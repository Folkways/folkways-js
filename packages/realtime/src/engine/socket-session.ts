import { Code } from '../shared/codes';
import { RealtimeError, localError } from '../shared/errors';
import { randomU64 } from '../shared/random';
import {
  type ClientFrame,
  type ClientMsg,
  type Limits,
  type ServerFrame,
  type ServerMsg,
  type StreamCloseEvent,
  type StreamConnection,
  type StreamTransport,
  DEFAULT_LIMITS,
  PROTO_MINOR,
  TransportError,
  decodeServerPacket,
} from '../transport';
import { Backoff, sleep } from './backoff';
import { packetize } from './packets';
import { type OutboundPublish, opError } from './publish-queue';
import type { CloseInfo, Session, SessionHost, SessionInfo } from './session';
import type { TopicEntry } from './subscriptions';
import { peekJwt } from './token';

export interface SocketSessionOptions {
  url: string;
  clientName: string;
  device?: string;
  openTimeoutMs: number;
  pongTimeoutMs: number;
  cursorAckIntervalMs: number;
}

type Pending =
  | { kind: 'publish'; p: OutboundPublish }
  | { kind: 'subscribe'; entry: TopicEntry; timer: ReturnType<typeof setTimeout> }
  | { kind: 'reauth'; resolve: () => void; reject: (e: RealtimeError) => void; timer: ReturnType<typeof setTimeout> }
  | { kind: 'ignore' };

interface QueuedFrame {
  frame: ClientFrame;
  written?: () => void;
  tooLarge?: () => void;
}

/**
 * The WebSocket protocol driver: `Hello`/`Welcome`, heartbeats, token
 * refresh, subscribe/unsubscribe and publish over one stream connection.
 */
export class SocketSession implements Session {
  readonly kind = 'websocket' as const;
  readonly closed: Promise<CloseInfo>;
  limits: Limits = DEFAULT_LIMITS;

  private resolveClosed!: (info: CloseInfo) => void;
  private conn?: StreamConnection;
  private opened = false;
  private ended = false;
  private readonly endController = new AbortController();
  private nextCorr = 1n;
  private readonly pending = new Map<bigint, Pending>();
  private outq: QueuedFrame[] = [];
  private flushScheduled = false;
  private waiter?: { resolve: (msg: Extract<ServerMsg, { type: 'welcome' }>) => void; reject: (e: Error) => void };
  private serverClose?: { code: number; reason: string; retryAfterMs: number };
  private lastInbound = 0;
  private lastPing = { at: 0, nonce: 0n };
  private heartbeat?: ReturnType<typeof setInterval>;
  private ackTimer?: ReturnType<typeof setInterval>;
  private refreshing = false;

  constructor(
    private readonly host: SessionHost,
    private readonly transport: StreamTransport,
    private readonly opts: SocketSessionOptions,
  ) {
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  // ------------------------------------------------------------------ open

  async open(signal: AbortSignal): Promise<SessionInfo> {
    const token = await this.host.tokens.get();
    const conn = await this.transport.connect(this.opts.url, signal);
    this.conn = conn;
    conn.onPacket = (b) => this.onPacket(b);
    conn.onProtocolError = (m) => this.abort(Code.BadFrame, m, true);
    conn.onClose = (e) => this.onTransportClose(e);
    this.lastInbound = Date.now();

    const welcome = new Promise<Extract<ServerMsg, { type: 'welcome' }>>((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
    const t0 = Date.now();
    const hello: ClientMsg = {
      type: 'hello',
      hello: { token, client: this.opts.clientName, device: this.opts.device, protoMinor: PROTO_MINOR },
    };
    this.writeNow([{ corr: this.corr(), msg: hello }]);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => this.abort(Code.ClientClosed, 'aborted', true);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    try {
      const w = await Promise.race([
        welcome,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new TransportError(`no Welcome within ${this.opts.openTimeoutMs} ms`)),
            this.opts.openTimeoutMs,
          );
        }),
      ]);
      const t1 = Date.now();
      this.limits = w.limits;
      this.opened = true;
      this.host.clockSample(w.serverTimeMs, (t0 + t1) / 2, t1 - t0);
      this.host.tokens.setExpiry(w.expiresAtMs);
      this.startTimers();
      this.syncSubscriptions();
      const claims = peekJwt(token);
      return {
        kind: 'websocket',
        identity: w.identity,
        sessionId: w.sessionId,
        limits: w.limits,
        expiresAtMs: w.expiresAtMs,
        server: w.server,
        anonymous: w.anonymous,
        segmentId: w.segmentId || claims.seg,
        environment: w.environment || undefined,
        capabilities: w.capabilities.length ? w.capabilities : (claims.cap ?? []),
        features: w.features,
      };
    } catch (e) {
      this.waiter = undefined;
      this.finish({ code: Code.Unavailable, reason: 'open failed', transportFailure: true, local: true });
      throw e;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  // ------------------------------------------------------------- outbound

  sendPublishes(items: OutboundPublish[]): void {
    for (const p of items) {
      if (this.ended) return;
      const corr = this.corr();
      if (p.wantsAck) this.pending.set(corr, { kind: 'publish', p });
      this.enqueue({
        frame: { corr, msg: { type: 'publish', publish: p.body } },
        written: () => this.host.publishes.written(p),
        tooLarge: () => {
          this.pending.delete(corr);
          this.host.publishes.failed(p, localError(Code.PayloadTooLarge, `publish does not fit in ${this.limits.maxFrameBytes} bytes`));
        },
      });
    }
  }

  syncSubscriptions(): void {
    if (!this.opened || this.ended) return;
    const { registry } = this.host;
    for (const e of registry.drainUnsubscribes()) {
      const topic = e.topicId !== undefined && e.wire === 'active' ? { id: e.topicId } : { name: e.name };
      const corr = this.corr();
      this.pending.set(corr, { kind: 'ignore' });
      this.enqueue({ frame: { corr, msg: { type: 'unsubscribe', topic } } });
    }
    for (const e of registry.entries()) {
      if (e.retype && e.wire === 'active') {
        // Widen the type filter: subscribe again after the last event seen.
        const corr = this.corr();
        this.pending.set(corr, { kind: 'ignore' });
        this.enqueue({ frame: { corr, msg: { type: 'unsubscribe', topic: e.topicId !== undefined ? { id: e.topicId } : { name: e.name } } } });
        e.wire = 'idle';
      }
      if (e.wire !== 'idle') continue;
      if (!e.loaded) {
        void e.loading.then(() => this.syncSubscriptions());
        continue;
      }
      e.wire = 'subscribing';
      const corr = this.corr();
      const timer = setTimeout(
        () => this.abort(Code.Timeout, `no reply to Subscribe ${e.name} within ${this.host.requestTimeoutMs} ms`, true),
        this.host.requestTimeoutMs,
      );
      this.pending.set(corr, { kind: 'subscribe', entry: e, timer });
      this.enqueue({ frame: { corr, msg: { type: 'subscribe', subscribe: e.subscribeBody() } } });
    }
  }

  close(code: number, reason: string): void {
    if (this.ended) return;
    if (this.conn && this.opened) {
      this.flush();
      this.writeNow([{ corr: 0n, msg: { type: 'close', code: code === Code.ClientClosed ? Code.Ok : code, reason } }]);
    }
    this.finish({ code, reason, transportFailure: false, local: true });
  }

  private corr(): bigint {
    return this.nextCorr++;
  }

  private enqueue(q: QueuedFrame): void {
    this.outq.push(q);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => this.flush());
  }

  private flush(): void {
    this.flushScheduled = false;
    if (this.ended || !this.conn || this.outq.length === 0) return;
    const queued = this.outq;
    this.outq = [];
    const byFrame = new Map(queued.map((q) => [q.frame, q]));
    const { packets, oversize } = packetize(
      queued.map((q) => q.frame),
      this.limits,
    );
    for (const packet of packets) this.conn.send(packet.bytes);
    const tooLarge = new Set(oversize);
    for (const q of queued) {
      if (tooLarge.has(q.frame)) byFrame.get(q.frame)?.tooLarge?.();
      else q.written?.();
    }
  }

  private writeNow(frames: ClientFrame[]): void {
    const { packets } = packetize(frames, this.limits);
    for (const p of packets) this.conn?.send(p.bytes);
  }

  // -------------------------------------------------------------- inbound

  private onPacket(bytes: Uint8Array): void {
    if (this.ended) return;
    this.lastInbound = Date.now();
    let frames: ServerFrame[];
    try {
      frames = decodeServerPacket(bytes);
    } catch (e) {
      const err = e instanceof RealtimeError ? e : localError(Code.BadFrame, 'undecodable packet', e);
      this.host.log.warn('bad packet from node; reconnecting', { err: err.message });
      this.abort(Code.BadFrame, err.message, true);
      return;
    }
    for (const f of frames) {
      if (this.ended) return;
      this.onFrame(f);
    }
  }

  private onFrame({ corr, msg }: ServerFrame): void {
    const { registry, log } = this.host;
    switch (msg.type) {
      case 'welcome':
        this.waiter?.resolve(msg);
        this.waiter = undefined;
        return;
      case 'close':
        this.serverClose = { code: msg.code, reason: msg.reason, retryAfterMs: msg.retryAfterMs };
        this.onServerClose();
        return;
      case 'ping':
        this.enqueue({ frame: { corr, msg: { type: 'pong', nonce: msg.nonce, tsMs: Date.now() } } });
        return;
      case 'pong': {
        if (msg.nonce === this.lastPing.nonce && this.lastPing.at) {
          const now = Date.now();
          this.host.clockSample(msg.tsMs, (this.lastPing.at + now) / 2, now - this.lastPing.at);
        }
        return;
      }
      case 'tokenExpiring':
        this.host.tokenExpiring(msg.expiresAtMs);
        void this.refreshToken(msg.expiresAtMs);
        return;
      case 'opOk':
      case 'opError':
      case 'pubAck':
        this.onReply(corr, msg);
        return;
      case 'subAck': {
        const p = corr ? this.pending.get(corr) : undefined;
        if (p?.kind === 'subscribe') {
          this.settle(corr, p);
          registry.onSubAck(p.entry, msg);
          return;
        }
        // After a Gap took the corr, the SubAck follows with corr 0.
        const entry = registry.byTopicId(msg.topicId);
        if (entry) registry.onSubAck(entry, msg);
        return;
      }
      case 'gap': {
        const p = corr ? this.pending.get(corr) : undefined;
        const entry = p?.kind === 'subscribe' ? p.entry : registry.byTopicId(msg.topicId);
        if (p?.kind === 'subscribe') this.settle(corr, p);
        if (entry) registry.onGap(entry, msg);
        return;
      }
      case 'deliver': {
        const entry = registry.byTopicId(msg.topicId);
        if (entry) registry.onDeliver(entry, msg);
        return;
      }
      case 'snapshot': {
        const entry = registry.byTopicId(msg.topicId);
        if (entry) registry.onSnapshot(entry, msg);
        return;
      }
      case 'subEnded': {
        const entry = registry.byTopicId(msg.topicId);
        if (entry) registry.onSubEnded(entry, msg.code, msg.message);
        return;
      }
      default:
        log.debug('ignored frame', { type: msg.type });
    }
  }

  private onReply(corr: bigint, msg: Extract<ServerMsg, { type: 'opOk' | 'opError' | 'pubAck' }>): void {
    const p = this.pending.get(corr);
    if (!p) {
      if (msg.type === 'opError') {
        this.host.log.warn('OpError without a pending request', { code: msg.code, message: msg.message });
      }
      return;
    }
    this.settle(corr, p);
    switch (p.kind) {
      case 'publish':
        if (msg.type === 'pubAck') this.host.publishes.acked(p.p, msg);
        else if (msg.type === 'opError') {
          this.host.publishes.failed(p.p, opError(msg.code, msg.message, msg.retryAfterMs, msg.topicId));
        }
        return;
      case 'subscribe': {
        if (msg.type !== 'opError') return;
        const err = opError(msg.code, msg.message, msg.retryAfterMs, msg.topicId);
        if (this.host.registry.onSubscribeError(p.entry, err)) {
          const delay = err.retry === 'backoff' ? Math.max(err.retryAfterMs ?? 0, 1_000) : 0;
          setTimeout(() => this.syncSubscriptions(), delay);
        }
        return;
      }
      case 'reauth':
        if (msg.type === 'opOk') p.resolve();
        else if (msg.type === 'opError') p.reject(opError(msg.code, msg.message, msg.retryAfterMs));
        return;
      case 'ignore':
        return;
    }
  }

  private settle(corr: bigint, p: Pending): void {
    this.pending.delete(corr);
    if (p.kind === 'subscribe' || p.kind === 'reauth') clearTimeout(p.timer);
  }

  // --------------------------------------------------------------- timers

  private startTimers(): void {
    const hb = Math.max(100, this.limits.heartbeatMs || DEFAULT_LIMITS.heartbeatMs);
    const tick = Math.max(50, Math.min(hb / 2, 5_000));
    this.lastPing.at = Date.now();
    this.heartbeat = setInterval(() => {
      const now = Date.now();
      if (now - this.lastInbound > hb + this.opts.pongTimeoutMs) {
        this.abort(Code.Timeout, `no traffic from the node for ${now - this.lastInbound} ms`, true);
        return;
      }
      if (now - this.lastPing.at >= hb) {
        this.lastPing = { at: now, nonce: randomU64() };
        this.enqueue({ frame: { corr: 0n, msg: { type: 'ping', nonce: this.lastPing.nonce, tsMs: now } } });
      }
    }, tick);
    if (this.opts.cursorAckIntervalMs > 0) {
      this.ackTimer = setInterval(() => {
        const acks = this.host.registry.takeCursorHints();
        for (let i = 0; i < acks.length; i += 256) {
          this.enqueue({ frame: { corr: 0n, msg: { type: 'cursorAck', acks: acks.slice(i, i + 256) } } });
        }
      }, this.opts.cursorAckIntervalMs);
    }
  }

  private async refreshToken(expiresAtMs: number): Promise<void> {
    const { tokens, log } = this.host;
    if (!tokens.refreshable) {
      log.warn('token expires soon and cannot be refreshed (pass a token provider)', { expiresAtMs });
      return;
    }
    if (this.refreshing) return;
    this.refreshing = true;
    const backoff = new Backoff({ initialDelayMs: 1_000, maxDelayMs: 10_000 });
    try {
      while (!this.ended && Date.now() < expiresAtMs) {
        try {
          const token = await tokens.refresh('expiring');
          await this.reauth(token);
          const exp = peekJwt(token).exp;
          if (exp) tokens.setExpiry(exp);
          this.host.tokenRefreshed(exp);
          return;
        } catch (err) {
          log.warn('token refresh failed; retrying', { err: (err as Error).message });
          await sleep(backoff.next(), this.endController.signal);
        }
      }
    } finally {
      this.refreshing = false;
    }
  }

  reauth(token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ended) {
        reject(localError(Code.NotConnected, 'session ended'));
        return;
      }
      const corr = this.corr();
      const timer = setTimeout(() => {
        this.pending.delete(corr);
        reject(localError(Code.Timeout, 'no reply to Reauth'));
      }, this.host.requestTimeoutMs);
      this.pending.set(corr, { kind: 'reauth', resolve, reject, timer });
      this.enqueue({ frame: { corr, msg: { type: 'reauth', token } } });
    });
  }

  // ------------------------------------------------------------------ end

  private onServerClose(): void {
    const c = this.serverClose!;
    if (this.waiter) {
      this.waiter.reject(new RealtimeError(c.code, { message: c.reason, retryAfterMs: c.retryAfterMs }));
      this.waiter = undefined;
    }
    this.finish({ code: c.code, reason: c.reason, retryAfterMs: c.retryAfterMs, transportFailure: false, local: false });
  }

  private onTransportClose(e: StreamCloseEvent): void {
    if (this.serverClose) {
      this.onServerClose();
      return;
    }
    const reason = `connection closed (WebSocket ${e.code}${e.reason ? ` ${e.reason}` : ''})`;
    if (this.waiter) {
      this.waiter.reject(new TransportError(reason));
      this.waiter = undefined;
    }
    this.finish({ code: Code.Unavailable, reason, transportFailure: true, local: true });
  }

  /** Ends the session because of something the SDK detected. */
  private abort(code: number, reason: string, transportFailure: boolean): void {
    if (this.ended) return;
    this.host.log.warn('closing connection', { reason });
    if (this.waiter) {
      this.waiter.reject(transportFailure ? new TransportError(reason) : localError(code, reason));
      this.waiter = undefined;
    }
    this.finish({ code, reason, transportFailure, local: true });
  }

  private finish(info: CloseInfo): void {
    if (this.ended) return;
    this.ended = true;
    this.endController.abort();
    clearInterval(this.heartbeat);
    clearInterval(this.ackTimer);
    for (const [, p] of this.pending) {
      if (p.kind === 'subscribe') clearTimeout(p.timer);
      if (p.kind === 'reauth') {
        clearTimeout(p.timer);
        p.reject(localError(Code.NotConnected, 'session ended'));
      }
    }
    this.pending.clear();
    this.outq = [];
    try {
      this.conn?.close(info.code === Code.ClientClosed || info.code === Code.Ok ? 1000 : 4000, '');
    } catch {
      /* ignore */
    }
    this.resolveClosed(info);
  }
}
