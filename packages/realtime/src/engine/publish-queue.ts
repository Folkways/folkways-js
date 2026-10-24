import { Code, codeInfo } from '../shared/codes';
import { RealtimeError, localError } from '../shared/errors';
import type { Logger } from '../shared/logger';
import type { PubAck, PublishBody } from '../transport';
import { Backoff } from './backoff';

export type PublishState = 'queued' | 'inflight' | 'waiting' | 'done';

/** One logical publish. Its body is frozen: retries resend exactly the same bytes. */
export interface OutboundPublish {
  readonly id: number;
  readonly topic: string;
  readonly body: PublishBody;
  /** False for fire-and-forget (`ack: NoAck`): settled as soon as it is written. */
  readonly wantsAck: boolean;
  state: PublishState;
  attempts: number;
}

/** What the queue needs from the engine. */
export interface PublishSink {
  /** True when a session is open and can take publishes now. */
  canSend(): boolean;
  /** Hands publishes to the current session, in order. */
  send(items: OutboundPublish[]): void;
  /** Why new publishes are refused right now (offline, failed), if they are. */
  refusal(): RealtimeError | undefined;
}

export interface PublishQueueOptions {
  /** 0 disables the offline queue: publishes made while offline fail with NotConnected. */
  maxQueued: number;
  timeoutMs: number;
  retries: number;
  logger: Logger;
}

interface Entry {
  p: OutboundPublish;
  resolve: (ack: PubAck | undefined) => void;
  reject: (err: RealtimeError) => void;
  timer: ReturnType<typeof setTimeout>;
  retryTimer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * Owns every publish from submit to settle: queues while offline, tracks
 * what is in flight, puts in-flight publishes back when a session drops (the
 * idempotency key makes the resend safe), retries `Backoff`-class errors and
 * enforces the overall timeout. Order of first sends follows submit order.
 */
export class PublishQueue {
  private seq = 0;
  private readonly entries = new Map<number, Entry>();
  private readonly queue: OutboundPublish[] = [];
  private flushScheduled = false;
  private closedWith?: RealtimeError;

  constructor(
    private readonly sink: PublishSink,
    private readonly opts: PublishQueueOptions,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  submit(topic: string, body: PublishBody, wantsAck: boolean, signal?: AbortSignal): Promise<PubAck | undefined> {
    if (this.closedWith) return Promise.reject(this.closedWith);
    if (signal?.aborted) return Promise.reject(localError(Code.Aborted, 'publish aborted'));
    const online = this.sink.canSend();
    if (!online) {
      if (!wantsAck) return Promise.resolve(undefined); // fire-and-forget is dropped while offline
      const refused = this.sink.refusal();
      if (refused) return Promise.reject(refused);
      if (this.opts.maxQueued <= 0) return Promise.reject(localError(Code.NotConnected, 'not connected'));
      const waiting = this.queue.length + [...this.entries.values()].filter((e) => e.p.state === 'waiting').length;
      if (waiting >= this.opts.maxQueued) {
        return Promise.reject(localError(Code.QueueFull, `offline queue is full (${this.opts.maxQueued})`));
      }
    }
    const p: OutboundPublish = { id: ++this.seq, topic, body, wantsAck, state: 'queued', attempts: 0 };
    return new Promise<PubAck | undefined>((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(p, localError(Code.Timeout, `no publish receipt within ${this.opts.timeoutMs} ms`)),
        this.opts.timeoutMs,
      );
      const entry: Entry = { p, resolve, reject, timer, signal };
      if (signal) {
        entry.onAbort = () => {
          // Already written publishes may still be applied by the node.
          this.fail(p, localError(Code.Aborted, 'publish aborted'));
        };
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      this.entries.set(p.id, entry);
      this.queue.push(p);
      this.scheduleFlush();
    });
  }

  /** Sends whatever is queued, if a session can take it. */
  flush(): void {
    this.flushScheduled = false;
    if (this.queue.length === 0 || !this.sink.canSend()) return;
    const batch = this.queue.splice(0, this.queue.length).filter((p) => p.state === 'queued');
    for (const p of batch) {
      p.state = 'inflight';
      p.attempts++;
    }
    if (batch.length > 0) this.sink.send(batch);
  }

  /** The publish was written to the wire (settles fire-and-forget publishes). */
  written(p: OutboundPublish): void {
    if (!p.wantsAck) this.settle(p, undefined);
  }

  acked(p: OutboundPublish, ack: PubAck): void {
    this.settle(p, ack);
  }

  /** The node answered with `OpError`, or the SDK refused to send it. */
  failed(p: OutboundPublish, err: RealtimeError): void {
    const e = this.entries.get(p.id);
    if (!e || p.state === 'done') return;
    const retryable = !err.local && codeInfo(err.code).retry === 'backoff';
    if (retryable && p.attempts <= this.opts.retries) {
      const backoff = new Backoff({ initialDelayMs: 250, maxDelayMs: 5_000 });
      for (let i = 1; i < p.attempts; i++) backoff.next();
      const delay = backoff.next(err.retryAfterMs ?? 0);
      this.opts.logger.debug('publish retry scheduled', { topic: p.topic, code: err.codeName, delay });
      p.state = 'waiting';
      e.retryTimer = setTimeout(() => {
        e.retryTimer = undefined;
        if (p.state !== 'waiting') return;
        p.state = 'queued';
        this.queue.push(p);
        this.flush();
      }, delay);
      return;
    }
    this.fail(p, err.withTopic(p.topic));
  }

  /**
   * The session ended. In-flight publishes go back to the front of the queue,
   * in their original order, to be resent with the same idempotency key.
   */
  sessionLost(): void {
    const inflight = [...this.entries.values()]
      .map((e) => e.p)
      .filter((p) => p.state === 'inflight')
      .sort((a, b) => a.id - b.id);
    for (const p of inflight) p.state = 'queued';
    const fireAndForget = inflight.filter((p) => !p.wantsAck);
    for (const p of fireAndForget) this.settle(p, undefined);
    this.queue.unshift(...inflight.filter((p) => p.wantsAck));
  }

  /** Rejects everything and refuses new publishes. */
  close(err: RealtimeError): void {
    this.closedWith = err;
    this.rejectAll(err);
  }

  /** Rejects every pending publish (offline, failed); new ones are still taken. */
  rejectAll(err: RealtimeError): void {
    for (const e of [...this.entries.values()]) this.fail(e.p, err);
    this.queue.length = 0;
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => this.flush());
  }

  private settle(p: OutboundPublish, ack: PubAck | undefined): void {
    const e = this.finish(p);
    e?.resolve(ack);
  }

  private fail(p: OutboundPublish, err: RealtimeError): void {
    const e = this.finish(p);
    e?.reject(err);
  }

  private finish(p: OutboundPublish): Entry | undefined {
    const e = this.entries.get(p.id);
    if (!e) return undefined;
    this.entries.delete(p.id);
    p.state = 'done';
    clearTimeout(e.timer);
    if (e.retryTimer) clearTimeout(e.retryTimer);
    if (e.signal && e.onAbort) e.signal.removeEventListener('abort', e.onAbort);
    const i = this.queue.indexOf(p);
    if (i >= 0) this.queue.splice(i, 1);
    return e;
  }
}

/** Converts an `OpError` into the error reported to the caller. */
export function opError(code: number, message: string, retryAfterMs: number, topicId?: bigint): RealtimeError {
  return new RealtimeError(code, {
    message: message || undefined,
    retryAfterMs,
    topicId: topicId || undefined,
  });
}
