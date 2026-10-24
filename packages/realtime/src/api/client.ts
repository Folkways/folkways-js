import { type CloseInfo, type ConnectionState, Engine, type Limits, type ReconnectInfo, type TransportKind } from '../engine';
import { Code } from '../shared/codes';
import { Emitter } from '../shared/emitter';
import { type RealtimeError, localError } from '../shared/errors';
import { format128 } from '../shared/random';
import { assertTopic } from '../shared/topic';
import type { PublishReceipt } from './message';
import { type ClientOptions, type ResolvedOptions, resolveOptions } from './options';
import type { MessageHandler, Subscription } from './subscription';
import { type PublishOptions, type SubscribeOptions, Topic } from './topic';

export type ClientEvents = {
  state: (state: ConnectionState, previous: ConnectionState) => void;
  connected: (info: { transport: TransportKind; identity?: string; sessionId?: string }) => void;
  disconnected: (info: { code: number; reason: string; retryAfterMs?: number }) => void;
  reconnecting: (info: ReconnectInfo) => void;
  /** A fatal error; the client is now `failed` until `connect()` is called again. */
  error: (err: RealtimeError) => void;
  tokenExpiring: (expiresAtMs: number) => void;
  tokenRefreshed: (expiresAtMs?: number) => void;
};

/** A connection to an RTE node. Create it with `Folkways.connect()` or `Folkways.createClient()`. */
export class RealtimeClient extends Emitter<ClientEvents> {
  private readonly engine: Engine;
  private readonly opts: ResolvedOptions;
  private readonly topics = new Map<string, Topic>();

  constructor(options: ClientOptions) {
    super();
    this.opts = resolveOptions(options);
    this.engine = new Engine(this.opts.engine);
    this.onListenerError = (err) => this.engine.log.error('client listener threw', { err });
    const e = this.engine;
    e.on('state', (s, p) => this.emit('state', s, p));
    e.on('connected', (i) =>
      this.emit('connected', {
        transport: i.kind,
        identity: i.identity,
        sessionId: i.sessionId ? format128(i.sessionId) : undefined,
      }),
    );
    e.on('disconnected', (i: CloseInfo) => this.emit('disconnected', { code: i.code, reason: i.reason, retryAfterMs: i.retryAfterMs }));
    e.on('reconnecting', (i) => this.emit('reconnecting', i));
    e.on('error', (err) => {
      if (this.listenerCount('error') > 0) this.emit('error', err);
    });
    e.on('tokenExpiring', (ms) => this.emit('tokenExpiring', ms));
    e.on('tokenRefreshed', (ms) => this.emit('tokenRefreshed', ms));
  }

  /** @internal */
  get autoConnect(): boolean {
    return this.opts.autoConnect;
  }

  get state(): ConnectionState {
    return this.engine.state;
  }

  /** The transport of the current session, or null while not connected. */
  get transport(): TransportKind | null {
    return this.engine.transport;
  }

  /** The token's `sub`, as confirmed by the node. */
  get identity(): string | undefined {
    return this.engine.info?.identity;
  }

  get sessionId(): string | undefined {
    const id = this.engine.info?.sessionId;
    return id ? format128(id) : undefined;
  }

  /** Limits announced by the node (schema defaults on HTTP). */
  get limits(): Limits {
    return this.engine.limits;
  }

  get tokenExpiresAt(): number | undefined {
    return this.engine.tokens.expiresAtMs;
  }

  /** Why the client closed, when it did. */
  get error(): RealtimeError | undefined {
    return this.engine.error;
  }

  /** `Date.now()` corrected by the clock offset measured to the node. */
  serverNow(): number {
    return this.engine.serverNow();
  }

  /**
   * Connects (or waits for the connection). Rejects on a fatal error, or with
   * `Timeout` after `connectTimeoutMs` while the client keeps trying.
   */
  async connect(): Promise<this> {
    const started = this.engine.start();
    const ms = this.opts.connectTimeoutMs;
    if (ms <= 0) {
      await started;
      return this;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        started,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(localError(Code.Timeout, `not connected within ${ms} ms; still trying`)), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    return this;
  }

  /** Closes the client for good. Queued publishes reject with `ClientClosed`. */
  async close(): Promise<void> {
    await this.engine.close();
  }

  /** The handle for a topic. Throws `InvalidTopic` for a malformed name. */
  topic(name: string): Topic {
    let t = this.topics.get(name);
    if (!t) {
      assertTopic(name, this.engine.limits.maxTopicBytes);
      t = new Topic(name, this.engine, this.opts.signalTtlMs);
      this.topics.set(name, t);
    }
    return t;
  }

  /** Shortcut for `client.topic(name).publish(data, opts)`. */
  publish(topic: string, data: unknown, opts?: PublishOptions): Promise<PublishReceipt> {
    try {
      return this.topic(topic).publish(data, opts);
    } catch (e) {
      return Promise.reject(e);
    }
  }

  /** Shortcut for `client.topic(name).subscribe(handler, opts)`. */
  subscribe<T = unknown>(topic: string, handler?: MessageHandler<T>, opts?: SubscribeOptions): Subscription<T> {
    return this.topic(topic).subscribe<T>(handler, opts);
  }
}
