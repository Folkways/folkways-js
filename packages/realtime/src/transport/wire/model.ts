/**
 * Owned message model of the RTE v1 wire protocol.
 *
 * Mirrors `rte/src/proto/codec.rs`. Every u64 is a `bigint` except
 * millisecond timestamps, which are `number` (they stay far below 2^53).
 * Enums are the ones generated from `rte.fbs`.
 */
import type { Cursor } from '../../shared/cursor';
import { AckMode } from './generated/rte/v1/ack-mode.js';
import { ContentType } from './generated/rte/v1/content-type.js';
import { DeliveryClass } from './generated/rte/v1/delivery-class.js';
import { FlowAction } from './generated/rte/v1/flow-action.js';
import { GapReason } from './generated/rte/v1/gap-reason.js';
import { OnGap } from './generated/rte/v1/on-gap.js';
import { StartAt } from './generated/rte/v1/start-at.js';

export { AckMode, ContentType, DeliveryClass, FlowAction, GapReason, OnGap, StartAt };

/** Minor protocol revision this SDK speaks. */
export const PROTO_MINOR = 0;
/** File identifier of client-to-server packets. */
export const CLIENT_IDENT = 'RTEC';
/** File identifier of server-to-client packets. */
export const SERVER_IDENT = 'RTES';
/** Frames one packet may hold (schema rule). */
export const MAX_FRAMES_PER_PACKET = 64;

/** A topic named in full, or by the numeric id the node assigned. */
export type TopicRef = { readonly name: string } | { readonly id: bigint };

export interface Uuid128 {
  readonly hi: bigint;
  readonly lo: bigint;
}

/** The house rules announced in `Welcome`. */
export interface Limits {
  readonly maxFrameBytes: number;
  readonly maxPayloadBytes: number;
  readonly maxFramesPerPacket: number;
  readonly maxSubscriptions: number;
  readonly maxTopicBytes: number;
  readonly maxHeaders: number;
  readonly heartbeatMs: number;
  readonly idleTimeoutMs: number;
}

/** The schema defaults; used until a `Welcome` says otherwise (and on HTTP). */
export const DEFAULT_LIMITS: Limits = Object.freeze({
  maxFrameBytes: 65_536,
  maxPayloadBytes: 61_440,
  maxFramesPerPacket: 64,
  maxSubscriptions: 1_000,
  maxTopicBytes: 255,
  maxHeaders: 16,
  heartbeatMs: 30_000,
  idleTimeoutMs: 90_000,
});

export type Header = readonly [key: string, value: string];

/** One stored event, as delivered. `payload` is a view into the received packet. */
export interface WireEvent {
  readonly topicId: bigint;
  readonly epoch: bigint;
  readonly seq: bigint;
  readonly serverTsMs: number;
  readonly clientTsMs: number;
  readonly publisher: string;
  readonly key?: string;
  readonly tombstone: boolean;
  readonly contentType: number;
  readonly headers: readonly Header[];
  readonly payload: Uint8Array;
  /** This event's own type; `Unspecified` from nodes before ADR-001 (use the topic's). */
  readonly delivery: DeliveryClass;
  /** Event name chosen by the publisher; absent from nodes before ADR-001. */
  readonly name?: string;
  /** Stable id minted by the topic owner (AiraID); absent from nodes before ADR-001. */
  readonly uid?: Uuid128;
  /**
   * State version of a kv or signal event in a topic with several types,
   * where such events take no sequence number; absent otherwise.
   */
  readonly version?: bigint;
}

/** A right granted by the node: `ops` on the topics `topic` (a pattern) matches. */
export interface WireCapability {
  readonly topic: string;
  readonly ops: readonly string[];
}

// ---------------------------------------------------------------- client

export interface Hello {
  readonly token: string;
  readonly client?: string;
  readonly protoMinor?: number;
  readonly maxFrameBytes?: number;
  readonly features?: readonly string[];
  /** Descriptive label of the device or app instance; never used for authorization. */
  readonly device?: string;
}

export interface PublishBody {
  readonly topic: TopicRef;
  readonly payload: Uint8Array;
  readonly contentType?: number;
  readonly delivery?: DeliveryClass;
  readonly ack?: AckMode;
  readonly idempotencyKey?: Uuid128;
  readonly key?: string;
  readonly tombstone?: boolean;
  readonly ttlMs?: number;
  readonly clientTsMs?: number;
  readonly headers?: readonly Header[];
  /** Event name (ADR-001); ignored by nodes before it. */
  readonly name?: string;
}

export interface SubscribeBody {
  readonly topic: TopicRef;
  readonly start?: StartAt;
  readonly cursor?: Cursor;
  readonly lastN?: number;
  readonly onGap?: OnGap;
  /** Defaults to true, as in the schema. */
  readonly snapshot?: boolean;
  /** Event types to receive (ADR-001); empty or absent means all. Ignored by nodes before it. */
  readonly types?: readonly DeliveryClass[];
  /**
   * Long-poll of a topic with several types: the last `SubAck.stateLatest`
   * applied. The node then returns only the kv and signal changes after it.
   */
  readonly stateAfter?: Cursor;
}

export interface PollBody {
  readonly topics: readonly SubscribeBody[];
  readonly maxEvents?: number;
  readonly waitMs?: number;
}

export interface TopicCursor {
  readonly topicId: bigint;
  readonly cursor: Cursor;
}

export type ClientMsg =
  | { readonly type: 'ping'; readonly nonce: bigint; readonly tsMs: number }
  | { readonly type: 'pong'; readonly nonce: bigint; readonly tsMs: number }
  | { readonly type: 'close'; readonly code: number; readonly reason?: string }
  | { readonly type: 'hello'; readonly hello: Hello }
  | { readonly type: 'reauth'; readonly token: string }
  | { readonly type: 'publish'; readonly publish: PublishBody }
  | { readonly type: 'subscribe'; readonly subscribe: SubscribeBody }
  | { readonly type: 'unsubscribe'; readonly topic: TopicRef }
  | { readonly type: 'cursorAck'; readonly acks: readonly TopicCursor[] }
  | { readonly type: 'poll'; readonly poll: PollBody };

export interface ClientFrame {
  /** Request id; replies carry it back. Non-zero for requests. */
  readonly corr: bigint;
  readonly msg: ClientMsg;
}

// ---------------------------------------------------------------- server

export interface Welcome {
  readonly protoMinor: number;
  readonly server: string;
  readonly serverTimeMs: number;
  readonly sessionId: Uuid128;
  readonly resumed: boolean;
  readonly identity: string;
  readonly expiresAtMs: number;
  readonly limits: Limits;
  readonly features: readonly string[];
  /** The token named no user; `identity` is the node-assigned `anon:<session_id>` label. */
  readonly anonymous: boolean;
  /** The verified segment (ADR-001, rte#19); empty from older nodes. */
  readonly segmentId: string;
  /** The segment's environment, e.g. `production`; empty from older nodes. */
  readonly environment: string;
  /** The rights granted to this connection; empty from older nodes. */
  readonly capabilities: readonly WireCapability[];
}

export interface PubAck {
  readonly topicId: bigint;
  readonly level: AckMode;
  readonly cursor: Cursor;
  readonly duplicate: boolean;
  readonly serverTsMs: number;
  /** The event's stable id (ADR-001); absent from older nodes. */
  readonly uid?: Uuid128;
}

export interface SubAck {
  readonly topicId: bigint;
  readonly delivery: DeliveryClass;
  readonly catchingUp: boolean;
  readonly oldest?: Cursor;
  readonly latest?: Cursor;
  readonly snapshotFollows: boolean;
  /** Event types the topic's rule allows (ADR-001); empty from older nodes. */
  readonly deliveries: readonly DeliveryClass[];
  /** Latest state version (epoch, version) of a topic with several types; absent otherwise. */
  readonly stateLatest?: Cursor;
}

export interface Gap {
  readonly topicId: bigint;
  readonly reason: GapReason;
  readonly requested?: Cursor;
  readonly oldest?: Cursor;
  readonly latest?: Cursor;
  readonly resumed: boolean;
}

export interface Deliver {
  readonly topicId: bigint;
  readonly delivery: DeliveryClass;
  readonly replayed: boolean;
  readonly events: readonly WireEvent[];
}

export interface Snapshot {
  readonly topicId: bigint;
  readonly snapshotId: bigint;
  readonly chunk: number;
  readonly lastChunk: boolean;
  readonly fence?: Cursor;
  readonly events: readonly WireEvent[];
}

export type ServerMsg =
  | { readonly type: 'ping'; readonly nonce: bigint; readonly tsMs: number }
  | { readonly type: 'pong'; readonly nonce: bigint; readonly tsMs: number }
  | { readonly type: 'close'; readonly code: number; readonly reason: string; readonly retryAfterMs: number }
  | { readonly type: 'extension'; readonly code: number; readonly contentType: number; readonly data: Uint8Array }
  | ({ readonly type: 'welcome' } & Welcome)
  | { readonly type: 'tokenExpiring'; readonly expiresAtMs: number }
  | { readonly type: 'opOk' }
  | {
      readonly type: 'opError';
      readonly code: number;
      readonly message: string;
      readonly retryAfterMs: number;
      readonly topicId: bigint;
    }
  | ({ readonly type: 'pubAck' } & PubAck)
  | ({ readonly type: 'subAck' } & SubAck)
  | ({ readonly type: 'gap' } & Gap)
  | { readonly type: 'flow'; readonly action: FlowAction; readonly retryAfterMs: number; readonly topicId: bigint }
  | { readonly type: 'pollEnd'; readonly timedOut: boolean; readonly more: boolean }
  | ({ readonly type: 'deliver' } & Deliver)
  | ({ readonly type: 'snapshot' } & Snapshot)
  | { readonly type: 'subEnded'; readonly topicId: bigint; readonly code: number; readonly message: string };

export type ServerMsgOf<T extends ServerMsg['type']> = Extract<ServerMsg, { type: T }>;

export interface ServerFrame {
  readonly corr: bigint;
  readonly msg: ServerMsg;
}
