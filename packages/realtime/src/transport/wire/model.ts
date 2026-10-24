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
}

export interface SubscribeBody {
  readonly topic: TopicRef;
  readonly start?: StartAt;
  readonly cursor?: Cursor;
  readonly lastN?: number;
  readonly onGap?: OnGap;
  /** Defaults to true, as in the schema. */
  readonly snapshot?: boolean;
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
}

export interface PubAck {
  readonly topicId: bigint;
  readonly level: AckMode;
  readonly cursor: Cursor;
  readonly duplicate: boolean;
  readonly serverTsMs: number;
}

export interface SubAck {
  readonly topicId: bigint;
  readonly delivery: DeliveryClass;
  readonly catchingUp: boolean;
  readonly oldest?: Cursor;
  readonly latest?: Cursor;
  readonly snapshotFollows: boolean;
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
