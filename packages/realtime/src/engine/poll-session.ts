import { Code, codeInfo } from '../shared/codes';
import { RealtimeError, localError } from '../shared/errors';
import { randomU64 } from '../shared/random';
import {
  type ClientFrame,
  type HttpPath,
  type Limits,
  type RequestTransport,
  type ServerFrame,
  type SubscribeBody,
  DEFAULT_LIMITS,
  StartAt,
  TransportError,
  decodeServerPacket,
} from '../transport';
import { Backoff, sleep } from './backoff';
import { packetize } from './packets';
import { type OutboundPublish, opError } from './publish-queue';
import type { CloseInfo, Session, SessionHost, SessionInfo } from './session';
import type { TopicEntry } from './subscriptions';
import { peekJwt } from './token';

export interface PollSessionOptions {
  baseUrl: string;
  waitMs: number;
  maxEvents: number;
  emptyStateRecheckMs: number;
}

/** Topics per `Poll` (schema limit). */
const MAX_POLL_TOPICS = 256;

/** RTE code for an HTTP status that carried no RTE body (a proxy answered). */
function codeForStatus(status: number): number {
  switch (status) {
    case 400:
      return Code.BadFrame;
    case 401:
      return Code.AuthRequired;
    case 403:
      return Code.Forbidden;
    case 413:
      return Code.FrameTooLarge;
    case 429:
      return Code.RateLimited;
    case 500:
      return Code.Internal;
    case 504:
      return Code.Timeout;
    default:
      return Code.Unavailable;
  }
}

/** Codes that end an HTTP "session" (the engine then reconnects or gives up). */
function endsSession(code: number): boolean {
  return (
    codeInfo(code).closesConnection ||
    code === Code.AuthInvalid ||
    code === Code.AuthExpired ||
    code === Code.AuthRequired ||
    code === Code.Suspended
  );
}

/**
 * The HTTP protocol driver. Publishes go to `POST /v1/publish` in batches;
 * subscriptions are served by a stateless long-poll loop on `POST /v1/poll`
 * that carries each topic's cursor itself.
 */
export class PollSession implements Session {
  readonly kind = 'http' as const;
  readonly closed: Promise<CloseInfo>;
  readonly limits: Limits = DEFAULT_LIMITS;

  private resolveClosed!: (info: CloseInfo) => void;
  private ended = false;
  private opened = false;
  private readonly endController = new AbortController();
  private pollAbort?: AbortController;
  private wake?: () => void;
  private readonly publishQ: OutboundPublish[] = [];
  private publishing = false;
  private nextCorr = 1n;
  private recheckNext = false;

  constructor(
    private readonly host: SessionHost,
    private readonly transport: RequestTransport,
    private readonly opts: PollSessionOptions,
  ) {
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  async open(signal: AbortSignal): Promise<SessionInfo> {
    const nonce = randomU64();
    const t0 = Date.now();
    const frames = await this.call('/v1/publish', [{ corr: this.corr(), msg: { type: 'ping', nonce, tsMs: t0 } }], signal);
    const t1 = Date.now();
    const pong = frames.find((f) => f.msg.type === 'pong');
    if (pong?.msg.type === 'pong') this.host.clockSample(pong.msg.tsMs, (t0 + t1) / 2, t1 - t0);
    this.opened = true;
    void this.pollLoop();
    const claims = peekJwt(this.host.tokens.current ?? '');
    return {
      kind: 'http',
      identity: claims.sub,
      limits: this.limits,
      expiresAtMs: this.host.tokens.expiresAtMs,
      anonymous: claims.kind === 'anonymous' || !claims.sub,
      segmentId: claims.seg,
      capabilities: claims.cap ?? [],
      features: [],
    };
  }

  // -------------------------------------------------------------- publish

  sendPublishes(items: OutboundPublish[]): void {
    this.publishQ.push(...items);
    if (!this.publishing) void this.publishLoop();
  }

  private async publishLoop(): Promise<void> {
    this.publishing = true;
    try {
      while (this.publishQ.length > 0 && !this.ended) {
        const batch = this.publishQ.splice(0, 64);
        const byCorr = new Map<bigint, OutboundPublish>();
        const frames: ClientFrame[] = batch.map((p) => {
          const corr = this.corr();
          byCorr.set(corr, p);
          return { corr, msg: { type: 'publish', publish: p.body } };
        });
        const { packets, oversize } = packetize(frames, this.limits);
        for (const f of oversize) {
          const p = byCorr.get(f.corr)!;
          this.host.publishes.failed(p, localError(Code.PayloadTooLarge, `publish does not fit in ${this.limits.maxFrameBytes} bytes`));
        }
        for (const packet of packets) {
          if (this.ended) return;
          let replies: ServerFrame[];
          try {
            replies = await this.callPacket('/v1/publish', packet.bytes, this.endController.signal);
          } catch (e) {
            if (this.handleError(e)) {
              // A request-level failure that does not end the session: let the queue retry.
              const err = e instanceof RealtimeError ? e : localError(Code.Unavailable, String(e));
              for (const f of packet.frames) this.host.publishes.failed(byCorr.get(f.corr)!, err);
            }
            // Otherwise the session ended and the engine puts in-flight publishes back.
            continue;
          }
          const answered = new Set<bigint>();
          for (const { corr, msg } of replies) {
            const p = byCorr.get(corr);
            if (!p) continue;
            if (msg.type === 'pubAck') {
              answered.add(corr);
              this.host.publishes.acked(p, msg);
            } else if (msg.type === 'opError') {
              answered.add(corr);
              this.host.publishes.failed(p, opError(msg.code, msg.message, msg.retryAfterMs, msg.topicId));
            }
          }
          for (const f of packet.frames) {
            const p = byCorr.get(f.corr)!;
            if (answered.has(f.corr)) continue;
            if (p.wantsAck) {
              this.host.publishes.failed(p, new RealtimeError(Code.Internal, { message: 'no receipt in the response' }));
            } else {
              this.host.publishes.written(p);
            }
          }
        }
      }
    } finally {
      this.publishing = false;
    }
  }

  // ---------------------------------------------------------------- poll

  syncSubscriptions(): void {
    this.host.registry.drainUnsubscribes(); // polls are stateless: nothing to tell the node
    if (!this.opened || this.ended) return;
    if (this.host.registry.entries().some((e) => e.wire === 'idle')) {
      // Probe the new topic now instead of after the current long-poll.
      this.pollAbort?.abort();
    }
    this.wake?.();
  }

  private waitForWork(): Promise<void> {
    return new Promise((resolve) => {
      this.wake = () => {
        this.wake = undefined;
        resolve();
      };
      if (this.ended) resolve();
    });
  }

  private async pollLoop(): Promise<void> {
    const backoff = new Backoff({ initialDelayMs: 500, maxDelayMs: 15_000 });
    while (!this.ended) {
      const { registry } = this.host;
      if (registry.entries().length === 0) {
        await this.waitForWork();
        continue;
      }
      try {
        let retryAfter = 0;
        for (const e of registry.entries()) {
          if (e.wire !== 'idle') continue;
          if (!e.loaded) await e.loading;
          if (e.removed || this.ended) continue;
          retryAfter = Math.max(retryAfter, await this.probe(e));
        }
        const active = registry.entries().filter((e) => e.wire === 'active');
        if (active.length > 0 && !this.ended) {
          await this.longPoll(active);
        } else if (retryAfter > 0 || registry.entries().every((e) => e.wire !== 'active')) {
          await sleep(Math.max(retryAfter, 1_000), this.endController.signal);
        }
        backoff.reset();
      } catch (e) {
        if (e instanceof TransportError && e.aborted && !this.ended) continue; // a new topic interrupted the poll
        if (!this.handleError(e)) return;
        const after = e instanceof RealtimeError ? (e.retryAfterMs ?? 0) : 0;
        await sleep(backoff.next(after), this.endController.signal);
      }
    }
  }

  /** First read of a topic, alone, so errors and the topic id are unambiguous. Returns a retry delay. */
  private async probe(e: TopicEntry): Promise<number> {
    e.wire = 'subscribing';
    const body = e.subscribeBody();
    const frames = await this.call(
      '/v1/poll',
      [{ corr: this.corr(), msg: { type: 'poll', poll: { topics: [body], maxEvents: this.opts.maxEvents, waitMs: 0 } } }],
      this.endController.signal,
    );
    const { registry } = this.host;
    let acked = false;
    for (const { msg } of frames) {
      if (e.removed) return 0;
      switch (msg.type) {
        case 'opError': {
          const err = opError(msg.code, msg.message, msg.retryAfterMs, msg.topicId);
          registry.onSubscribeError(e, err);
          return err.retry === 'backoff' ? Math.max(err.retryAfterMs ?? 0, 1_000) : 0;
        }
        case 'gap':
          if (!registry.onGap(e, msg)) return 0;
          break;
        case 'subAck':
          registry.onSubAck(e, msg);
          acked = true;
          break;
        case 'deliver':
          registry.onDeliver(e, msg);
          break;
        case 'snapshot':
          registry.onSnapshot(e, msg);
          break;
        default:
          break;
      }
    }
    if (!acked && !e.removed) e.wire = 'idle';
    this.afterRead(e);
    return 0;
  }

  private async longPoll(active: TopicEntry[]): Promise<void> {
    const groups: TopicEntry[][] = [];
    for (let i = 0; i < active.length; i += MAX_POLL_TOPICS) groups.push(active.slice(i, i + MAX_POLL_TOPICS));
    const abort = new AbortController();
    this.pollAbort = abort;
    const onEnd = () => abort.abort();
    this.endController.signal.addEventListener('abort', onEnd, { once: true });
    try {
      await Promise.all(groups.map((g) => this.pollGroup(g, abort.signal)));
    } finally {
      this.endController.signal.removeEventListener('abort', onEnd);
      if (this.pollAbort === abort) this.pollAbort = undefined;
    }
  }

  private async pollGroup(group: TopicEntry[], signal: AbortSignal): Promise<void> {
    const anyEmpty = group.some((e) => e.isState && e.poll.emptyState);
    const recheck = anyEmpty && this.recheckNext;
    const waitMs = recheck ? 0 : anyEmpty ? Math.min(this.opts.waitMs, this.opts.emptyStateRecheckMs) : this.opts.waitMs;
    const topics = group.map((e) => this.pollBody(e, recheck));
    const frames = await this.call(
      '/v1/poll',
      [{ corr: this.corr(), msg: { type: 'poll', poll: { topics, maxEvents: this.opts.maxEvents, waitMs } } }],
      signal,
    );
    if (anyEmpty) this.recheckNext = !recheck;
    const { registry } = this.host;
    const seen = new Set<TopicEntry>();
    for (const { msg } of frames) {
      switch (msg.type) {
        case 'opError': {
          const entry = msg.topicId ? registry.byTopicId(msg.topicId) : undefined;
          // Without a topic id the error cannot be attributed: the unseen topics are probed again.
          if (entry) {
            seen.add(entry);
            registry.onSubscribeError(entry, opError(msg.code, msg.message, msg.retryAfterMs, msg.topicId));
          }
          break;
        }
        case 'gap': {
          const entry = registry.byTopicId(msg.topicId);
          if (entry) registry.onGap(entry, msg);
          break;
        }
        case 'subAck': {
          const entry = registry.byTopicId(msg.topicId);
          if (entry) {
            seen.add(entry);
            registry.onSubAck(entry, msg, true);
          }
          break;
        }
        case 'deliver': {
          const entry = registry.byTopicId(msg.topicId);
          if (entry) registry.onDeliver(entry, msg, false);
          break;
        }
        case 'snapshot': {
          const entry = registry.byTopicId(msg.topicId);
          if (entry) registry.onSnapshot(entry, msg);
          break;
        }
        default:
          break;
      }
    }
    for (const e of group) {
      if (e.removed) continue;
      // No answer for it (unattributable error, or the topic was recreated with a new id).
      if (!seen.has(e) && e.wire === 'active') e.wire = 'idle';
      this.afterRead(e);
    }
  }

  /** Where the next poll of an established topic starts. */
  private pollBody(e: TopicEntry, recheck: boolean): SubscribeBody {
    const topic = { name: e.name };
    const onGap = e.spec.onGap;
    const types = e.wantedTypes();
    e.wireTypes = types;
    e.retype = false;
    if (e.received) return { topic, start: StartAt.After, cursor: e.received, onGap, snapshot: true, types };
    if (e.latest) return { topic, start: StartAt.After, cursor: e.latest, onGap, snapshot: true, types };
    // An empty Durable topic: everything it will hold is new to us.
    if (!e.isState) return { topic, start: StartAt.Oldest, onGap, snapshot: true, types };
    // An empty state topic has no cursor to poll after, so every other poll asks for a fresh snapshot.
    return { topic, start: StartAt.Latest, onGap, snapshot: recheck, types };
  }

  private afterRead(e: TopicEntry): void {
    e.poll.emptyState = e.isState && !e.received && !e.latest;
  }

  // ---------------------------------------------------------------- http

  private corr(): bigint {
    return this.nextCorr++;
  }

  private call(path: HttpPath, frames: ClientFrame[], signal: AbortSignal): Promise<ServerFrame[]> {
    const { packets, oversize } = packetize(frames, this.limits);
    if (oversize.length > 0 || packets.length !== 1) {
      return Promise.reject(localError(Code.FrameTooLarge, `request does not fit in ${this.limits.maxFrameBytes} bytes`));
    }
    return this.callPacket(path, packets[0]!.bytes, signal);
  }

  private async callPacket(path: HttpPath, packet: Uint8Array, signal: AbortSignal): Promise<ServerFrame[]> {
    const { tokens } = this.host;
    let refreshed = false;
    for (;;) {
      const token = await tokens.get();
      const reply = await this.transport.request(this.opts.baseUrl, path, token, packet, signal);
      const frames = reply.packets.flatMap((p) => decodeServerPacket(p));
      if (reply.status === 200) return frames;
      const close = frames.find((f) => f.msg.type === 'close')?.msg;
      const c = close?.type === 'close' ? close : undefined;
      const code = c?.code ?? codeForStatus(reply.status);
      if ((code === Code.AuthExpired || code === Code.AuthRequired) && !refreshed && tokens.refreshable) {
        tokens.invalidate();
        await tokens.refresh('rejected');
        refreshed = true;
        continue;
      }
      throw new RealtimeError(code, {
        message: c?.reason || `HTTP ${reply.status} from ${path}`,
        retryAfterMs: c?.retryAfterMs || reply.retryAfterMs,
      });
    }
  }

  /**
   * Decides what an error means for the session. Returns true when the
   * session carries on (after a backoff), false when it ended.
   */
  private handleError(e: unknown): boolean {
    if (this.ended) return false;
    if (e instanceof TransportError) {
      this.finish({ code: Code.Unavailable, reason: e.message, transportFailure: true, local: true });
      return false;
    }
    if (e instanceof RealtimeError) {
      if (e.local && e.code === Code.BadFrame) {
        this.finish({ code: Code.Unavailable, reason: e.message, transportFailure: true, local: true });
        return false;
      }
      if (endsSession(e.code)) {
        this.finish({ code: e.code, reason: e.message, retryAfterMs: e.retryAfterMs, transportFailure: false, local: e.local });
        return false;
      }
      this.host.log.warn('request failed; retrying', { code: e.codeName, retryAfterMs: e.retryAfterMs });
      return true;
    }
    this.finish({ code: Code.Internal, reason: String(e), transportFailure: false, local: true });
    return false;
  }

  /** Each HTTP request carries the current token, so nothing is sent. */
  reauth(): Promise<void> {
    return Promise.resolve();
  }

  close(code: number, reason: string): void {
    this.finish({ code, reason, transportFailure: false, local: true });
  }

  private finish(info: CloseInfo): void {
    if (this.ended) return;
    this.ended = true;
    this.endController.abort();
    this.pollAbort?.abort();
    this.wake?.();
    this.publishQ.length = 0;
    this.resolveClosed(info);
  }
}
