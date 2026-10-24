import { Code, isFatalCloseCode } from '../shared/codes';
import { Emitter } from '../shared/emitter';
import { RealtimeError, localError } from '../shared/errors';
import type { Logger } from '../shared/logger';
import {
  type FetchLike,
  type Limits,
  type PubAck,
  type PublishBody,
  type RequestTransport,
  type StreamTransport,
  type TransportKind,
  type WebSocketConstructor,
  DEFAULT_LIMITS,
  HttpTransport,
  TransportError,
  WebSocketTransport,
} from '../transport';
import { Backoff, sleep } from './backoff';
import type { CursorStore } from './cursor-store';
import { PollSession } from './poll-session';
import { PublishQueue } from './publish-queue';
import { TransportSelector } from './selector';
import type { CloseInfo, Session, SessionHost, SessionInfo } from './session';
import { SocketSession } from './socket-session';
import {
  type StoredValue,
  type SubscribeSpec,
  type TopicListener,
  SubscriptionRegistry,
  TopicEntry,
} from './subscriptions';
import { type TokenSource, TokenManager } from './token';

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed';

export interface ReconnectOptions {
  initialDelayMs: number;
  maxDelayMs: number;
  /** Consecutive failed attempts before giving up. */
  maxAttempts: number;
}

/** Fully resolved engine settings (layer 1 fills in the defaults). */
export interface EngineConfig {
  endpoints: { websocket?: string; http?: string };
  token: TokenSource;
  transports: readonly TransportKind[];
  clientName: string;
  device?: string;
  openTimeoutMs: number;
  requestTimeoutMs: number;
  publishTimeoutMs: number;
  publishRetries: number;
  reconnect: ReconnectOptions | false;
  fallbackAfterFailures: number;
  pongTimeoutMs: number;
  cursorAckIntervalMs: number;
  offlineQueueMax: number;
  cursorStore: CursorStore;
  longPoll: { waitMs: number; maxEvents: number; emptyStateRecheckMs: number };
  webSocket?: WebSocketConstructor;
  fetch?: FetchLike;
  /** Replace the transports entirely (tests, custom runtimes). */
  streamTransport?: StreamTransport;
  requestTransport?: RequestTransport;
  logger: Logger;
}

export interface ReconnectInfo {
  readonly attempt: number;
  readonly delayMs: number;
  readonly error: RealtimeError;
}

export type EngineEvents = {
  state: (state: ConnectionState, previous: ConnectionState) => void;
  connected: (info: SessionInfo) => void;
  disconnected: (info: CloseInfo) => void;
  reconnecting: (info: ReconnectInfo) => void;
  error: (err: RealtimeError) => void;
  tokenExpiring: (expiresAtMs: number) => void;
  tokenRefreshed: (expiresAtMs?: number) => void;
};

interface Decision {
  fatal?: RealtimeError;
  delayMs: number;
}

/**
 * Layer 2. Owns the connection state machine and everything that outlives a
 * single connection: the token, the publish queue, the subscription registry
 * and the choice of transport. Layer 1 talks only to this class.
 */
export class Engine extends Emitter<EngineEvents> implements SessionHost {
  readonly registry: SubscriptionRegistry;
  readonly publishes: PublishQueue;
  readonly tokens: TokenManager;
  readonly log: Logger;
  readonly requestTimeoutMs: number;

  private stateValue: ConnectionState = 'idle';
  private session?: Session;
  private sessionInfo?: SessionInfo;
  private readonly selector: TransportSelector;
  private readonly ws: StreamTransport;
  private readonly http: RequestTransport;
  private loop?: Promise<void>;
  private stopped = false;
  private readonly stopController = new AbortController();
  private wakeController = new AbortController();
  private waiters: { resolve: () => void; reject: (e: RealtimeError) => void }[] = [];
  private fatalError?: RealtimeError;
  private clockOffset = 0;
  private bestRtt = Number.POSITIVE_INFINITY;
  private everConnected = false;
  private readonly removeOnline?: () => void;

  constructor(private readonly cfg: EngineConfig) {
    super();
    this.log = cfg.logger;
    this.requestTimeoutMs = cfg.requestTimeoutMs;
    this.tokens = new TokenManager(cfg.token);
    this.ws = cfg.streamTransport ?? new WebSocketTransport(cfg.webSocket);
    this.http = cfg.requestTransport ?? new HttpTransport(cfg.fetch);
    this.registry = new SubscriptionRegistry({
      cursorStore: cfg.cursorStore,
      logger: cfg.logger,
      onChange: () => this.session?.syncSubscriptions(),
    });
    this.publishes = new PublishQueue(
      {
        canSend: () => this.stateValue === 'connected' && !!this.session,
        send: (items) => this.session?.sendPublishes(items),
      },
      { maxQueued: cfg.offlineQueueMax, timeoutMs: cfg.publishTimeoutMs, retries: cfg.publishRetries, logger: cfg.logger },
    );
    this.selector = new TransportSelector(
      cfg.transports,
      (k) => (k === 'websocket' ? !!cfg.endpoints.websocket && this.ws.available() : !!cfg.endpoints.http && this.http.available()),
      Math.max(1, cfg.fallbackAfterFailures),
      cfg.logger,
    );
    this.onListenerError = (err) => this.log.error('event listener threw', { err });
    const g = globalThis as { addEventListener?: (t: string, f: () => void) => void; removeEventListener?: (t: string, f: () => void) => void };
    if (typeof g.addEventListener === 'function' && typeof g.removeEventListener === 'function') {
      const onOnline = () => this.wakeController.abort();
      g.addEventListener('online', onOnline);
      this.removeOnline = () => g.removeEventListener!('online', onOnline);
    }
  }

  // ------------------------------------------------------------ queries

  get state(): ConnectionState {
    return this.stateValue;
  }

  get info(): SessionInfo | undefined {
    return this.sessionInfo;
  }

  get transport(): TransportKind | null {
    return this.stateValue === 'connected' ? (this.session?.kind ?? null) : null;
  }

  get limits(): Limits {
    return this.session?.limits ?? this.sessionInfo?.limits ?? DEFAULT_LIMITS;
  }

  get error(): RealtimeError | undefined {
    return this.fatalError;
  }

  /** `Date.now()` corrected by the measured clock offset to the node. */
  serverNow(): number {
    return Date.now() + this.clockOffset;
  }

  // ------------------------------------------------------------ control

  /** Starts connecting (idempotent). Resolves when connected, rejects on a fatal error. */
  start(): Promise<void> {
    if (!this.loop && !this.stopped) {
      this.loop = this.run().catch((err) => {
        this.fail(err instanceof RealtimeError ? err : localError(Code.Internal, 'engine loop failed', err));
      });
    }
    return this.whenConnected();
  }

  whenConnected(): Promise<void> {
    if (this.stateValue === 'connected') return Promise.resolve();
    if (this.fatalError) return Promise.reject(this.fatalError);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  /** Closes the connection for good. Pending publishes reject with `ClientClosed`. */
  async close(): Promise<void> {
    if (this.stopped) {
      await this.loop;
      return;
    }
    this.stopped = true;
    const err = localError(Code.ClientClosed, 'client closed');
    this.fatalError ??= err;
    this.session?.close(Code.ClientClosed, 'client closed');
    this.stopController.abort();
    this.wakeController.abort();
    this.removeOnline?.();
    this.publishes.close(err);
    this.registry.close(err);
    this.setState('closed');
    this.rejectWaiters(err);
    await this.loop;
  }

  // ------------------------------------------------------- layer 1 API

  publish(topic: string, body: PublishBody, wantsAck: boolean, signal?: AbortSignal): Promise<PubAck | undefined> {
    const limits = this.limits;
    if (body.payload.length > limits.maxPayloadBytes) {
      return Promise.reject(
        new RealtimeError(Code.PayloadTooLarge, {
          message: `payload of ${body.payload.length} bytes exceeds ${limits.maxPayloadBytes}`,
          topic,
          local: true,
        }),
      );
    }
    if ((body.headers?.length ?? 0) > limits.maxHeaders) {
      return Promise.reject(
        new RealtimeError(Code.InvalidArgument, { message: `more than ${limits.maxHeaders} headers`, topic, local: true }),
      );
    }
    return this.publishes.submit(topic, body, wantsAck, signal);
  }

  subscribe(topic: string, spec: SubscribeSpec, listener: TopicListener): TopicEntry {
    if (this.stopped) {
      const err = this.fatalError ?? localError(Code.ClientClosed, 'client closed');
      const entry = new TopicEntry(topic, spec, this.cfg.cursorStore, this.log);
      entry.removed = true;
      queueMicrotask(() => listener.onEnded(err));
      return entry;
    }
    return this.registry.add(topic, spec, listener);
  }

  unsubscribe(entry: TopicEntry, listener: TopicListener): void {
    this.registry.remove(entry, listener);
  }

  /** Current kv values and latest signals of a topic, by event name. */
  values(entry: TopicEntry): { readonly kv: ReadonlyMap<string, ReadonlyMap<string, StoredValue>>; readonly signals: ReadonlyMap<string, ReadonlyMap<string, StoredValue>> } {
    return { kv: entry.kv, signals: entry.signals };
  }

  // ------------------------------------------------------- SessionHost

  clockSample(serverMs: number, localMs: number, rttMs: number): void {
    if (!(serverMs > 0)) return;
    // The lowest-latency sample bounds the error best.
    if (rttMs <= this.bestRtt) {
      this.bestRtt = rttMs;
      this.clockOffset = Math.round(serverMs - localMs);
    }
  }

  tokenRefreshed(expiresAtMs?: number): void {
    this.log.debug('token refreshed', { expiresAtMs });
    this.emit('tokenRefreshed', expiresAtMs);
  }

  tokenExpiring(expiresAtMs: number): void {
    this.emit('tokenExpiring', expiresAtMs);
  }

  // ------------------------------------------------------------- loop

  private async run(): Promise<void> {
    const rc = this.cfg.reconnect || { initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 0 };
    const backoff = new Backoff(rc);
    let failures = 0;
    let invalidStreak = 0;
    let authRetried = false;

    const decide = (err: RealtimeError, transportFailure: boolean, kind: TransportKind): Decision => {
      if (transportFailure && kind === 'websocket' && this.selector.transportFailed()) {
        return { delayMs: 0 };
      }
      const { code } = err;
      if (code === Code.ClientClosed) return { fatal: err, delayMs: 0 };
      if (code === Code.AuthInvalid && !err.local) {
        if (this.tokens.refreshable && invalidStreak === 0) {
          invalidStreak++;
          this.tokens.invalidate();
          return { delayMs: 0 };
        }
        return { fatal: err, delayMs: 0 };
      }
      if ((code === Code.AuthExpired || code === Code.AuthRequired) && !err.local) {
        if (!this.tokens.refreshable) return { fatal: err, delayMs: 0 };
        this.tokens.invalidate();
        if (!authRetried) {
          authRetried = true;
          return { delayMs: 0 };
        }
      }
      if (isFatalCloseCode(code) && !err.local) return { fatal: err, delayMs: 0 };
      failures++;
      if (this.cfg.reconnect === false || failures > rc.maxAttempts) {
        return { fatal: err, delayMs: 0 };
      }
      if (code === Code.Draining) {
        // Another node takes over: reconnect soon, without growing the backoff.
        return { delayMs: err.retryAfterMs ?? Math.floor(Math.random() * 1_000) };
      }
      return { delayMs: backoff.next(err.retryAfterMs ?? 0) };
    };

    while (!this.stopped) {
      const kind = this.selector.current();
      if (!kind) {
        this.fail(
          localError(
            Code.TransportUnavailable,
            `none of [${this.cfg.transports.join(', ')}] can be used here (check endpoints, WebSocket and fetch availability)`,
          ),
        );
        return;
      }
      this.setState(this.everConnected ? 'reconnecting' : 'connecting');
      const session = this.createSession(kind);
      this.log.debug('connecting', { transport: kind });
      let info: SessionInfo;
      try {
        info = await session.open(this.stopController.signal);
      } catch (e) {
        session.close(Code.ClientClosed, 'open failed');
        if (this.stopped) return;
        const transportFailure = e instanceof TransportError;
        const err =
          e instanceof RealtimeError
            ? e
            : localError(Code.Unavailable, e instanceof Error ? e.message : 'connection failed', e);
        this.log.warn('connection attempt failed', { transport: kind, code: err.codeName, reason: err.message });
        const d = decide(err, transportFailure, kind);
        if (d.fatal) {
          this.fail(d.fatal);
          return;
        }
        await this.pause(d.delayMs, failures, err);
        continue;
      }
      if (this.stopped) {
        session.close(Code.ClientClosed, 'client closed');
        return;
      }

      // ---- connected
      this.session = session;
      this.sessionInfo = info;
      this.bestRtt = Number.POSITIVE_INFINITY;
      backoff.reset();
      failures = 0;
      invalidStreak = 0;
      authRetried = false;
      this.selector.opened();
      this.everConnected = true;
      this.log.info('connected', { transport: kind, identity: info.identity, server: info.server });
      this.setState('connected');
      this.emit('connected', info);
      this.resolveWaiters();
      this.publishes.flush();

      const closed = await session.closed;
      this.session = undefined;
      this.publishes.sessionLost();
      this.registry.sessionLost();
      if (this.stopped) return;
      this.log.info('disconnected', { code: closed.code, reason: closed.reason });
      this.emit('disconnected', closed);
      const err = new RealtimeError(closed.code, {
        message: closed.reason,
        retryAfterMs: closed.retryAfterMs,
        local: closed.local,
      });
      const d = decide(err, closed.transportFailure, kind);
      if (d.fatal) {
        this.fail(d.fatal);
        return;
      }
      this.setState('reconnecting');
      await this.pause(d.delayMs, failures, err);
    }
  }

  private createSession(kind: TransportKind): Session {
    if (kind === 'websocket') {
      return new SocketSession(this, this.ws, {
        url: this.cfg.endpoints.websocket!,
        clientName: this.cfg.clientName,
        device: this.cfg.device,
        openTimeoutMs: this.cfg.openTimeoutMs,
        pongTimeoutMs: this.cfg.pongTimeoutMs,
        cursorAckIntervalMs: this.cfg.cursorAckIntervalMs,
      });
    }
    return new PollSession(this, this.http, {
      baseUrl: this.cfg.endpoints.http!,
      ...this.cfg.longPoll,
    });
  }

  private async pause(delayMs: number, attempt: number, error: RealtimeError): Promise<void> {
    if (delayMs <= 0 || this.stopped) return;
    this.emit('reconnecting', { attempt, delayMs, error });
    this.log.debug('reconnecting after delay', { delayMs, attempt });
    if (this.wakeController.signal.aborted) this.wakeController = new AbortController();
    await sleep(delayMs, this.wakeController.signal);
    if (this.wakeController.signal.aborted && !this.stopped) this.wakeController = new AbortController();
  }

  private fail(err: RealtimeError): void {
    if (this.stopped && this.stateValue === 'closed') return;
    this.log.error('connection failed permanently', { code: err.codeName, reason: err.message });
    this.stopped = true;
    this.fatalError = err;
    this.session?.close(Code.ClientClosed, 'client failed');
    this.removeOnline?.();
    this.publishes.close(err);
    this.registry.close(err);
    this.setState('closed');
    this.rejectWaiters(err);
    this.emit('error', err);
  }

  private setState(next: ConnectionState): void {
    const prev = this.stateValue;
    if (prev === next) return;
    this.stateValue = next;
    this.emit('state', next, prev);
  }

  private resolveWaiters(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const { resolve } of w) resolve();
  }

  private rejectWaiters(err: RealtimeError): void {
    const w = this.waiters;
    this.waiters = [];
    for (const { reject } of w) reject(err);
  }
}
