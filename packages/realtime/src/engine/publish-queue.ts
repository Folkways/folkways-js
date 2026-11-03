import { Code, codeInfo } from '../shared/codes';
import { RealtimeError, localError } from '../shared/errors';
import type { Logger } from '../shared/logger';
import { FlowAction, type PubAck, type PublishBody } from '../transport';
import { Backoff } from './backoff';
import type { Outbox, OutboxItem } from './outbox';

export type PublishState = 'queued' | 'inflight' | 'waiting' | 'done';

/**
 * What the node asked publishers to do about outbound pressure (`Flow`,
 * ADR-015 D4): `throttled` sends in batches, `paused` holds publishes until
 * the node resumes.
 */
export type FlowState = 'normal' | 'throttled' | 'paused';

/** One logical publish. Its body is frozen: retries resend exactly the same bytes. */
export interface OutboundPublish {
  readonly id: number;
  readonly topic: string;
  readonly body: PublishBody;
  /** False for fire-and-forget (`ack: NoAck`): settled as soon as it is written. */
  readonly wantsAck: boolean;
  readonly createdAt: number;
  /** Set when the publish is kept in the persistent outbox. */
  outboxKey?: string;
  state: PublishState;
  attempts: number;
  /** Attempts answered with `RateLimited`; they do not count against `retries`. */
  rateLimited: number;
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
  /** A persistent outbox: publishes survive reloads and wait out being offline. */
  outbox?: Outbox;
  /** The flow state changed. */
  onFlow?: (state: FlowState, retryAfterMs: number) => void;
}

/** Bounds of the batching interval while throttled. */
const THROTTLE_MIN_MS = 50;
const THROTTLE_MAX_MS = 1_000;

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
 *
 * `Flow` from the node gates sending: while throttled, queued publishes go
 * out in one batch per interval; while paused, they wait in the queue (their
 * deadline still runs) and fire-and-forget publishes are dropped, as when
 * offline. `RateLimited` means nothing was done, so its retries are bounded
 * by the deadline only, not by `retries`.
 */
export class PublishQueue {
  private seq = 0;
  private readonly entries = new Map<number, Entry>();
  private readonly queue: OutboundPublish[] = [];
  private flushScheduled = false;
  private closedWith?: RealtimeError;
  private flowState: FlowState = 'normal';
  private throttleMs = 0;
  private nextSendAt = 0;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private flowTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly sink: PublishSink,
    private readonly opts: PublishQueueOptions,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  get flow(): FlowState {
    return this.flowState;
  }

  /** True when stream and kv publishes are kept in a persistent outbox. */
  get persistent(): boolean {
    return !!this.opts.outbox?.enabled;
  }

  submit(topic: string, body: PublishBody, wantsAck: boolean, signal?: AbortSignal): Promise<PubAck | undefined> {
    return this.enqueue(topic, body, wantsAck, Date.now(), signal);
  }

  /** Resends an entry restored from the outbox (after a reload); same idempotency key. */
  restore(item: OutboxItem): Promise<PubAck | undefined> {
    return this.enqueue(item.topic, item.body, true, item.createdAt, undefined, item.key);
  }

  /** Outbox keys of publishes this queue holds (not to be restored twice). */
  ownsOutboxKey(key: string): boolean {
    return [...this.entries.values()].some((e) => e.p.outboxKey === key);
  }

  private enqueue(
    topic: string,
    body: PublishBody,
    wantsAck: boolean,
    createdAt: number,
    signal?: AbortSignal,
    restoredKey?: string,
  ): Promise<PubAck | undefined> {
    if (this.closedWith) return Promise.reject(this.closedWith);
    if (signal?.aborted) return Promise.reject(localError(Code.Aborted, 'publish aborted'));
    const outbox = wantsAck && this.persistent ? this.opts.outbox : undefined;
    const online = this.sink.canSend();
    const paused = online && this.flowState === 'paused';
    if (!online || paused) {
      // Fire-and-forget is dropped while offline or paused: it would be stale by the time it went out.
      if (!wantsAck) {
        if (paused) this.opts.logger.debug('fire-and-forget publish dropped while paused', { topic });
        return Promise.resolve(undefined);
      }
      if (!online) {
        const refused = this.sink.refusal();
        if (refused && !(outbox && refused.code === Code.NotConnected)) return Promise.reject(refused);
        if (this.opts.maxQueued <= 0) return Promise.reject(localError(Code.NotConnected, 'not connected'));
      }
      // The offline queue bounds a pause too; disabled, a pause holds nothing.
      if (this.opts.maxQueued <= 0) {
        return Promise.reject(localError(Code.QueueFull, 'publishing is paused by the node and the offline queue is disabled'));
      }
      if (this.held() >= this.opts.maxQueued) {
        const why = paused ? 'publishing is paused by the node and the queue is full' : 'offline queue is full';
        return Promise.reject(localError(Code.QueueFull, `${why} (${this.opts.maxQueued})`));
      }
    }
    const p: OutboundPublish = { id: ++this.seq, topic, body, wantsAck, createdAt, state: 'queued', attempts: 0, rateLimited: 0 };
    if (outbox) p.outboxKey = restoredKey ?? outbox.keyFor(body, createdAt);
    return new Promise<PubAck | undefined>((resolve, reject) => {
      // Offline with an outbox, a publish waits up to the outbox's age limit instead.
      const waitMs = outbox && !online ? Math.max(0, createdAt + outbox.maxAgeMs - Date.now()) : this.opts.timeoutMs;
      const timer = setTimeout(() => this.fail(p, localError(Code.Timeout, `no publish receipt within ${waitMs} ms`)), waitMs);
      const entry: Entry = { p, resolve, reject, timer, signal };
      if (signal) {
        entry.onAbort = () => {
          // Already written publishes may still be applied by the node.
          this.fail(p, localError(Code.Aborted, 'publish aborted'));
        };
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      this.entries.set(p.id, entry);
      if (outbox && !restoredKey) {
        // The idempotency key is in the store before the first send.
        void outbox.put({ key: p.outboxKey!, topic, body, createdAt }).then(() => {
          if (p.state !== 'queued') return;
          this.queue.push(p);
          this.scheduleFlush();
        });
        return;
      }
      this.queue.push(p);
      this.scheduleFlush();
    });
  }

  /** Publishes not sent yet: queued, or waiting to be retried. */
  private held(): number {
    return this.queue.length + [...this.entries.values()].filter((e) => e.p.state === 'waiting').length;
  }

  /** Sends whatever is queued, if a session can take it and the node lets it. */
  flush(): void {
    this.flushScheduled = false;
    if (this.queue.length === 0 || !this.sink.canSend() || this.flowState === 'paused') return;
    if (this.flowState === 'throttled') {
      const wait = this.nextSendAt - Date.now();
      if (wait > 0) {
        this.flushTimer ??= setTimeout(() => {
          this.flushTimer = undefined;
          this.flush();
        }, wait);
        return;
      }
      this.nextSendAt = Date.now() + this.throttleMs;
    }
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
    // RateLimited: nothing was done and the node said when to come back; only the deadline bounds it.
    if (retryable && err.code === Code.RateLimited) p.rateLimited++;
    if (retryable && (err.code === Code.RateLimited || p.attempts - p.rateLimited <= this.opts.retries)) {
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
   * `Flow` from the node. `expires`: the state lasts `retryAfterMs` unless
   * the node repeats it (HTTP, where every request starts unthrottled);
   * otherwise it lasts until the next `Flow` (WebSocket, where the node sends
   * `Resume` on its own).
   */
  flowControl(action: FlowAction, retryAfterMs: number, expires: boolean): void {
    clearTimeout(this.flowTimer);
    this.flowTimer = undefined;
    switch (action) {
      case FlowAction.Resume:
        this.setFlow('normal', 0);
        return;
      case FlowAction.Throttle:
        this.throttleMs = Math.min(THROTTLE_MAX_MS, Math.max(THROTTLE_MIN_MS, retryAfterMs));
        this.setFlow('throttled', retryAfterMs);
        break;
      case FlowAction.Pause:
        this.setFlow('paused', retryAfterMs);
        this.dropQueuedFireAndForget();
        break;
      default:
        this.opts.logger.debug('ignored unknown Flow action', { action });
        return;
    }
    if (expires) this.flowTimer = setTimeout(() => this.setFlow('normal', 0), Math.max(retryAfterMs, THROTTLE_MIN_MS));
  }

  private setFlow(state: FlowState, retryAfterMs: number): void {
    if (state === 'normal') {
      clearTimeout(this.flowTimer);
      this.flowTimer = undefined;
    }
    if (state !== 'throttled') {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
      this.nextSendAt = 0;
    }
    const changed = state !== this.flowState;
    this.flowState = state;
    if (changed) {
      this.opts.logger.debug('publish flow changed', { state, retryAfterMs });
      this.opts.onFlow?.(state, retryAfterMs);
    }
    // Leaving a pause sends what it held (in batches, when throttled).
    if (state !== 'paused') this.flush();
  }

  private dropQueuedFireAndForget(): void {
    for (const p of this.queue.filter((q) => !q.wantsAck)) this.settle(p, undefined);
  }

  /**
   * The session ended. In-flight publishes go back to the front of the queue,
   * in their original order, to be resent with the same idempotency key.
   * The flow state belongs to the session and starts over with the next one.
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
    this.setFlow('normal', 0);
  }

  /** Rejects everything and refuses new publishes. */
  close(err: RealtimeError): void {
    this.closedWith = err;
    this.rejectAll(err);
    clearTimeout(this.flushTimer);
    clearTimeout(this.flowTimer);
  }

  /** Rejects every pending publish (offline, failed); new ones are still taken. */
  rejectAll(err: RealtimeError): void {
    for (const e of [...this.entries.values()]) this.fail(e.p, err);
    this.queue.length = 0;
  }

  /**
   * The connection went offline: publishes kept in the outbox wait for the
   * next connection (up to its age limit); the others fail with `err`.
   */
  goOffline(err: RealtimeError): void {
    const outbox = this.opts.outbox;
    for (const e of [...this.entries.values()]) {
      if (!e.p.outboxKey || !outbox) {
        this.fail(e.p, err);
        continue;
      }
      clearTimeout(e.timer);
      const left = Math.max(0, e.p.createdAt + outbox.maxAgeMs - Date.now());
      e.timer = setTimeout(() => this.fail(e.p, localError(Code.Timeout, 'not sent within the outbox age limit')), left);
    }
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
    if (p.outboxKey) void this.opts.outbox?.remove(p.outboxKey);
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
