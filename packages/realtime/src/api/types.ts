/**
 * The public types of @folkways/realtime (ADR-001, revision 3).
 *
 * Written before the implementation and reviewed on their own (FLK-55),
 * because they become a public API on the first npm release. Names follow
 * the portal vocabulary: segment, topic, delivery type, event name.
 */
import type { Limits, TransportKind } from '../engine';
import type { Cursor } from '../shared/cursor';
import type { RealtimeError } from '../shared/errors';

// ------------------------------------------------------------- vocabulary

/**
 * How the node handles one event:
 * - `stream`: ordered and replayable within the topic's window;
 * - `kv`: the latest value per key (key-value);
 * - `signal`: fire-and-forget, each sender's latest kept for 5 s.
 */
export type Delivery = 'stream' | 'kv' | 'signal';

/** Operations a permission can grant. `publish` is for stream events, `set` for kv, `signal` for signals. */
export type Op = 'subscribe' | 'publish' | 'set' | 'signal' | 'presence' | 'history';

/** Topic patterns and the operations this token allows on them. `*` matches one level, a trailing `>` one or more. */
export interface Permission {
  readonly topics: string;
  readonly ops: readonly Op[];
}

/** The segment named in the verified token. Never sent by the client. */
export interface Segment {
  readonly id: string;
  /** e.g. `production`; null when the node does not say. */
  readonly environment: string | null;
}

/** A value that changes over time, readable by React's useSyncExternalStore, Svelte stores and Vue refs. */
export interface LiveView<T> {
  /** The current value: an immutable snapshot, replaced (never mutated) on change. */
  getSnapshot(): T;
  /** Calls `listener` after every change. Returns a function that removes it. */
  subscribe(listener: () => void): () => void;
}

// ---------------------------------------------------------------- session

/** What `connect()` resolves with. The token string itself is never kept here. */
export interface Session {
  /** Who this connection acts for; null when anonymous. */
  readonly identity: string | null;
  readonly anonymous: boolean;
  /** Session id (32 hex digits). */
  readonly id: string;
  /** null when neither the node nor the token says. */
  readonly segment: Segment | null;
  readonly permissions: readonly Permission[];
  /** Local check with the node's pattern rules, for UI such as hiding a send button. The node still enforces. */
  can(op: Op, topic: string): boolean;
  /** Token expiry (Unix ms); the SDK refreshes before it. */
  readonly expiresAt: number | null;
  readonly limits: Limits;
  readonly transport: TransportKind;
  /** Features the node announced (e.g. `user-topics`, `presence`). */
  readonly features: readonly string[];
}

// ------------------------------------------------------------- connection

/**
 * `idle → connecting → connected ⇄ reconnecting → offline`; `failed` after a
 * fatal error (call `connect()` again, usually after `updateToken()`);
 * `closed` after `close()`.
 */
export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'failed' | 'closed';

export interface ConnectionChange {
  readonly current: ConnectionState;
  readonly previous: ConnectionState;
  /** Why it changed, when an error caused it. */
  readonly reason?: RealtimeError;
}

export interface ConnectionSnapshot {
  readonly state: ConnectionState;
  readonly transport: TransportKind | null;
  readonly error: RealtimeError | null;
}

export type ConnectionEvents = {
  change: (change: ConnectionChange) => void;
  /** Errors not tied to one call: listener failures, dropped outbox entries, failed token refreshes. */
  error: (err: RealtimeError | Error) => void;
};

/** The client's one connection for the whole segment. */
export interface Connection extends LiveView<ConnectionSnapshot> {
  readonly state: ConnectionState;
  readonly transport: TransportKind | null;
  /** Why the connection failed, while `failed`. */
  readonly error: RealtimeError | null;
  on<K extends keyof ConnectionEvents>(event: K, fn: ConnectionEvents[K]): () => void;
  /** Resolves when connected; rejects if the connection fails or closes first. */
  whenConnected(): Promise<void>;
}

// ---------------------------------------------------------------- events

/** Event names to payload types, e.g. `{ message: { text: string }; typing: { on: boolean } }`. */
export type EventMap = Record<string, unknown>;

/** One event received on (or sent to) a topic. */
export interface Message<T = unknown, E extends string = string> {
  readonly topic: string;
  /** Event name; empty from nodes that predate event names. */
  readonly name: E;
  readonly delivery: Delivery;
  /** Verified identity of the publisher. Trust this, never a name in the payload. */
  readonly publisher: string;
  /** Decoded payload: JSON → value, text → string, otherwise bytes. `undefined` for a kv delete. */
  readonly data: T;
  /** Stable id minted by the topic owner; survives node restarts. Point receipts and edits at it. */
  readonly uid?: string;
  /** Position in the topic, for stream events (and numbered kv events). */
  readonly cursor?: Cursor;
  /** Unique within the topic; usable as a React key. */
  readonly id: string;
  /** kv key (scoped by event name); for signals, the publisher. */
  readonly key?: string;
  /** A kv delete. */
  readonly deleted: boolean;
  readonly headers: Readonly<Record<string, string>>;
  readonly contentType: number;
  /** The raw payload (do not modify). */
  readonly payload: Uint8Array;
  /** When the node accepted the event (Unix ms); informational, not for ordering. */
  readonly serverTime: number;
  readonly clientTime?: number;
  /** Delivered from retained history rather than live. */
  readonly replayed: boolean;
  /** Sent by this client and not yet acknowledged. */
  readonly pending: boolean;
  /** Read from the local store and not yet confirmed by the live connection. */
  readonly fromCache: boolean;
}

/** A message of any event in `E`, narrowed by `name`. */
export type MessageOf<E extends EventMap> = { [K in keyof E & string]: Message<E[K], K> }[keyof E & string];

/** An entry of `topic.messages`: a received event, or one of this client's sends. */
export type TopicMessage<T = unknown, E extends string = string> = Message<T, E> & {
  readonly status: 'pending' | 'sent' | 'failed';
  readonly error?: RealtimeError;
  /** Sends a failed message again with the same idempotency key. */
  retry?(): Promise<void>;
};

// ------------------------------------------------------------ publishing

export interface PublishOptions {
  /** Default `stream`, or the type the topic definition fixes for this event. */
  delivery?: Delivery;
  /** kv: the key. Defaults to your identity. */
  key?: string;
  /** kv: how long the value lives (ms). */
  ttlMs?: number;
  /** kv: delete the key (`data` is ignored). */
  remove?: boolean;
  /** Up to `limits.maxHeaders` string headers, passed through to subscribers. */
  headers?: Record<string, string>;
  /** Payload type; inferred from `data` when omitted. */
  contentType?: ContentTypeName | number;
  /** 32 hex digits or a UUID. Reuse it to retry the same logical publish; generated otherwise. */
  idempotencyKey?: string;
  /** Your clock for this event (Unix ms). Defaults to `Date.now()`. */
  clientTime?: number;
  /** Stop waiting for the receipt (the node may still apply the publish). */
  signal?: AbortSignal;
}

export type ContentTypeName = 'bytes' | 'json' | 'text' | 'flatbuffers' | 'protobuf' | 'msgpack' | 'cbor';

/** The node's receipt for a stream or kv publish. */
export interface PublishReceipt {
  readonly topic: string;
  readonly delivery: Delivery;
  readonly uid?: string;
  readonly cursor?: Cursor;
  /** Same as `Message.id` of the delivered event. */
  readonly id: string;
  readonly level: 'accepted' | 'committed';
  /** The node had already accepted this idempotency key; nothing was published twice. */
  readonly duplicate: boolean;
  readonly serverTime: number;
}

// ----------------------------------------------------------- subscribing

export type StartFrom = 'latest' | 'oldest' | { after: Cursor | string } | { last: number };

export interface SubscribeOptions<E extends string = string> {
  /** Where to start when there is no saved cursor. Default `'latest'`. */
  from?: StartFrom;
  /** What to do when the cursor cannot be honoured. Default `'from-oldest'`. */
  onGap?: 'from-oldest' | 'from-latest' | 'fail';
  /** Delivery types to receive. Default: all. An inbox usually wants `['stream']`. */
  types?: readonly Delivery[];
  /** Event names to receive. Default: all. */
  events?: readonly E[];
}

export type SubscriptionStatus = 'pending' | 'active' | 'resyncing' | 'failed' | 'ended' | 'closed';

export type GapReasonName = 'expired' | 'epoch-lost' | 'slow-consumer' | 'unspecified';

export interface GapEvent {
  readonly topic: string;
  readonly reason: GapReasonName;
  /** The cursor you asked to resume after. */
  readonly requested?: Cursor;
  /** Oldest event still retained: fetch `(requested, oldest)` from your backend. */
  readonly oldest?: Cursor;
  readonly latest?: Cursor;
  /** False when `onGap: 'fail'` ended the subscription. */
  readonly resumed: boolean;
}

export type MessageHandler<M> = (message: M) => void | Promise<void>;

// ------------------------------------------------------------- topic sets

export interface SetSubscribeOptions<E extends string = string> extends SubscribeOptions<E> {
  /** Reject `ready` if any topic fails, instead of listing it in `failed`. */
  strict?: boolean;
}

export interface SetReady {
  readonly ok: readonly string[];
  readonly failed: readonly { readonly topic: string; readonly error: RealtimeError }[];
}

// ----------------------------------------------------------- client.on()

/** What `client.on(filter, handler)` listens to. Every field narrows; all are optional. */
export interface EventFilter {
  /** A topic name or pattern (`*` one level, trailing `>` one or more). */
  topic?: string;
  delivery?: Delivery;
  event?: string | readonly string[];
  publisher?: string | readonly string[];
  /** `false` skips events this client's identity published. */
  self?: boolean;
}

// ------------------------------------------------------------------ store

/** The local store port and its cipher hook live in the engine; re-exported here. */
export type { Store, StoreCipher } from '../engine';

// ------------------------------------------------------------------- auth

export type TokenReason = 'initial' | 'expiring' | 'rejected';

/** Returns a signed RTE token, typically by asking your backend. */
export type TokenProvider = (ctx: { reason: TokenReason }) => string | Promise<string>;

export type TokenSource = string | TokenProvider;

// ----------------------------------------------------------------- connect

export interface ConnectOptions {
  /** Fail with `SegmentMismatch` if the token is for another segment (catches a staging token in production). Never used for authorization. */
  segment?: string;
}

export interface CloseOptions {
  /** Also wipe this identity's local data (cursors, cache, outbox). */
  clear?: boolean;
}
