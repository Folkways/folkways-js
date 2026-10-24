import { type DeliveredEvent, Engine, peekJwt } from '../engine';
import { Code } from '../shared/codes';
import { RealtimeError, localError } from '../shared/errors';
import { assertTopic, topicMatches } from '../shared/topic';
import { RealtimeConnection } from './connection';
import { Live } from './live';
import { type RealtimeOptions, type ResolvedOptions, resolveOptions } from './options';
import { toSession } from './session';
import { toMessage } from './message';
import type { Subscription } from './subscription';
import { Topic } from './topic';
import { TopicSet } from './topic-set';
import type { CloseOptions, ConnectOptions, Connection, Delivery, EventFilter, EventMap, LiveView, Message, Session, TokenSource } from './types';

/** Welcome feature announcing personal `$user/{identity}` topics (rte#17). */
export const USER_TOPICS_FEATURE = 'user-topics';

const oneOf = (want: string | readonly string[] | undefined, v: string): boolean =>
  want === undefined || (typeof want === 'string' ? want === v : want.includes(v));

function matches(f: EventFilter, m: Message, me: string | null | undefined): boolean {
  if (f.topic !== undefined && f.topic !== m.topic && !topicMatches(f.topic, m.topic)) return false;
  if (f.delivery !== undefined && f.delivery !== (m.delivery satisfies Delivery)) return false;
  if (!oneOf(f.event, m.name)) return false;
  if (!oneOf(f.publisher, m.publisher)) return false;
  if (f.self === false && me && m.publisher === me) return false;
  return true;
}

/**
 * A client of one RTE segment. Create it, then `connect()`:
 *
 *   const client = new Folkways.Realtime({ url, authUrl: '/api/rte-token' });
 *   const session = await client.connect();
 *
 * `Folkways.connect(config)` does both in one call.
 */
export class Realtime {
  /** The client's one connection: state, transport, `on('change')`. */
  readonly connection: Connection;
  /** `client.session` as a live view, for UI bindings. */
  readonly sessionView: LiveView<Session | null>;

  private readonly engine: Engine;
  private readonly opts: ResolvedOptions;
  private readonly conn: RealtimeConnection;
  private readonly topics = new Map<string, Topic>();
  private readonly sessionLive: Live<Session | null>;
  private readonly observers = new Set<{ filter: EventFilter; handler: (e: Message) => void }>();
  private userTopic?: { name: string; sub: Subscription };

  constructor(options: RealtimeOptions) {
    this.opts = resolveOptions(options);
    this.engine = new Engine(this.opts.engine);
    this.conn = new RealtimeConnection(this.engine);
    this.connection = this.conn;
    this.sessionLive = new Live<Session | null>(null, (err) => this.engine.log.error('session listener threw', { err }));
    this.sessionView = this.sessionLive;
    const refresh = () => this.refreshSession();
    this.engine.on('connected', () => {
      refresh();
      this.followUserTopic();
    });
    this.engine.on('delivered', (d) => this.observe(d));
    this.engine.on('sessionUpdated', refresh);
    this.engine.on('tokenRefreshed', refresh);
    this.engine.on('identityChanged', () => {
      this.sessionLive.set(null);
      this.userTopic = undefined;
    });
  }

  /**
   * Listens to every event this client already receives (its subscriptions
   * and its own `$user/{identity}` topic), optionally filtered. It never
   * subscribes and never holds back delivery; listener errors go to
   * `client.connection`'s `error` event. Returns a function that stops it.
   */
  on(handler: (e: Message) => void): () => void;
  on(filter: EventFilter, handler: (e: Message) => void): () => void;
  on(a: EventFilter | ((e: Message) => void), b?: (e: Message) => void): () => void {
    const filter = typeof a === 'function' ? {} : a;
    const handler = typeof a === 'function' ? a : b;
    if (typeof handler !== 'function') throw localError(Code.InvalidArgument, 'client.on needs a handler');
    const l = { filter, handler };
    this.observers.add(l);
    return () => {
      this.observers.delete(l);
    };
  }

  /** Who this client is, once connected; null before. Kept up to date across token refreshes. */
  get session(): Session | null {
    return this.sessionLive.getSnapshot();
  }

  /** `Date.now()` corrected by the clock offset measured to the node. */
  serverNow(): number {
    return this.engine.serverNow();
  }

  /**
   * Connects and resolves with the session. Retryable failures are retried
   * quietly until `connectTimeoutMs`; rejects with a `RealtimeError` on a
   * fatal one (the connection is then `failed`), or with `Timeout` while
   * the client keeps trying. After `failed`, calling it again starts over.
   */
  async connect(opts: ConnectOptions = {}): Promise<Session> {
    if (opts.segment !== undefined) this.assertSegment(opts.segment);
    const started = this.engine.start();
    const ms = this.opts.connectTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await (ms <= 0
        ? started
        : Promise.race([
            started,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(localError(Code.Timeout, `not connected within ${ms} ms; still trying`)), ms);
            }),
          ]));
    } finally {
      clearTimeout(timer);
    }
    const session = this.refreshSession();
    if (!session) throw new RealtimeError(Code.NotConnected, { message: 'connection closed while connecting', local: true });
    if (opts.segment !== undefined && session.segment && session.segment.id !== opts.segment) {
      const err = localError(Code.SegmentMismatch, `the token is for segment ${session.segment.id}, not ${opts.segment}`);
      this.engine.failWith(err);
      throw err;
    }
    return session;
  }

  /**
   * Swaps the token (or provider). The same identity keeps its connection
   * and subscriptions (`Reauth`); a different identity reconnects and ends
   * every subscription with `IdentityChanged`. Rejects with
   * `SegmentMismatch` for a token of another segment.
   */
  updateToken(token: TokenSource): Promise<void> {
    return this.engine.updateToken(token);
  }

  /** Closes the client for good. Queued publishes reject with `ClientClosed`. */
  async close(_opts: CloseOptions = {}): Promise<void> {
    await this.engine.close();
  }

  /**
   * The handle for a topic (a room). Throws `InvalidTopic` for a malformed
   * name. Pass an event map to type each event's data:
   * `client.topic<{ message: { text: string } }>('chat/45')`.
   */
  topic<E extends EventMap = EventMap>(name: string): Topic<E>;
  /** A set of topics handled as one: bulk subscribe and publish (see `TopicSet`). */
  topic<E extends EventMap = EventMap>(names: readonly string[]): TopicSet<E>;
  topic<E extends EventMap = EventMap>(name: string | readonly string[]): Topic<E> | TopicSet<E> {
    if (Array.isArray(name)) return new TopicSet<E>(name, (n) => this.topic<E>(n), this.engine);
    return this.single<E>(name as string);
  }

  private single<E extends EventMap>(name: string): Topic<E> {
    let t = this.topics.get(name);
    if (!t) {
      assertTopic(name, this.engine.limits.maxTopicBytes, true);
      t = new Topic(name, this.engine, this.opts.signalTtlMs);
      this.topics.set(name, t);
    }
    return t as unknown as Topic<E>;
  }

  /** A string token can be checked before anything is sent. */
  private assertSegment(segment: string): void {
    const token = this.engine.tokens.current;
    const seg = token ? peekJwt(token).seg : undefined;
    if (seg && seg !== segment) throw localError(Code.SegmentMismatch, `the token is for segment ${seg}, not ${segment}`);
  }

  private observe(d: DeliveredEvent): void {
    if (this.observers.size === 0) return;
    const m = toMessage(d);
    const me = this.session?.identity;
    for (const { filter, handler } of [...this.observers]) {
      if (!matches(filter, m, me)) continue;
      try {
        handler(m);
      } catch (err) {
        this.conn.report(err as Error);
      }
    }
  }

  /** Every identified connection follows its own `$user/{identity}` once the node offers it (rte#17). */
  private followUserTopic(): void {
    const s = this.session;
    if (!s?.identity || !s.features.includes(USER_TOPICS_FEATURE)) return;
    const name = `$user/${s.identity}`;
    if (this.userTopic?.name === name) return;
    void this.userTopic?.sub.unsubscribe();
    try {
      this.userTopic = { name, sub: this.topic(name).subscribe() as unknown as Subscription };
    } catch (err) {
      this.engine.log.warn('cannot follow the personal topic', { err });
    }
  }

  private refreshSession(): Session | null {
    const info = this.engine.info;
    const transport = this.engine.transport;
    if (!info || !transport) return this.sessionLive.getSnapshot();
    const session = toSession(info, this.engine.limits, transport, this.engine.tokens.expiresAtMs);
    this.sessionLive.set(session);
    return session;
  }
}
