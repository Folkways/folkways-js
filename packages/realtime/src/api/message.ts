import { ContentType, DeliveryClass, type DeliveredEvent, GapReason } from '../engine';
import { Code } from '../shared/codes';
import { type Cursor, formatCursor } from '../shared/cursor';
import { RealtimeError } from '../shared/errors';

export type DeliveryClassName = 'durable' | 'last-value' | 'ephemeral';
export type ContentTypeName = 'bytes' | 'json' | 'text' | 'flatbuffers' | 'protobuf' | 'msgpack' | 'cbor';

/** One event received on a topic. */
export interface Message<T = unknown> {
  readonly topic: string;
  readonly topicId: bigint;
  /** Position of the event in its topic. */
  readonly cursor: Cursor;
  /** `"epoch:seq"`: unique per topic, usable as a React key. */
  readonly id: string;
  /** The payload decoded by content type: JSON → value, Text → string, otherwise the bytes. `undefined` for deletes. */
  readonly data: T;
  /** The raw payload (a view into the received packet; do not modify). */
  readonly payload: Uint8Array;
  readonly contentType: number;
  /** Verified identity of the publisher (the token's `sub`). */
  readonly publisher: string;
  /** LastValue item key (for Ephemeral topics, the publisher). */
  readonly key?: string;
  /** A LastValue delete. */
  readonly deleted: boolean;
  readonly headers: Readonly<Record<string, string>>;
  /** When the node accepted the event (Unix ms); informational, not for ordering. */
  readonly serverTime: number;
  /** The publisher's own clock (Unix ms), when it set one. */
  readonly clientTime?: number;
  /** Delivered from retained history rather than live. */
  readonly replayed: boolean;
  /** Part of a state snapshot. */
  readonly fromSnapshot: boolean;
}

/** A publish the node accepted. */
export interface PublishReceipt {
  readonly topic: string;
  readonly topicId: bigint;
  readonly cursor: Cursor;
  readonly id: string;
  /** Acknowledgement level reached: `accepted` in this RTE release. */
  readonly level: 'accepted' | 'committed';
  /** The node had already accepted this idempotency key; nothing was published twice. */
  readonly duplicate: boolean;
  readonly serverTime: number;
}

const CONTENT_TYPES: Record<ContentTypeName, number> = {
  bytes: ContentType.Bytes,
  json: ContentType.Json,
  text: ContentType.Text,
  flatbuffers: ContentType.FlatBuffers,
  protobuf: ContentType.Protobuf,
  msgpack: ContentType.MsgPack,
  cbor: ContentType.Cbor,
};

export function contentTypeCode(t: ContentTypeName | number): number {
  if (typeof t === 'number') {
    if (!Number.isInteger(t) || t < 0 || t > 0xffff) {
      throw new RealtimeError(Code.InvalidArgument, { message: `content type ${t} is not a u16`, local: true });
    }
    return t;
  }
  const code = CONTENT_TYPES[t];
  if (code === undefined) throw new RealtimeError(Code.InvalidArgument, { message: `unknown content type "${t}"`, local: true });
  return code;
}

const utf8 = new TextEncoder();
const utf8d = new TextDecoder();

function asBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return undefined;
}

/**
 * Encodes a payload. Without an explicit type: bytes → Bytes, string → Text,
 * anything else → JSON. With one, `data` must be bytes, or a string for
 * text/json (a non-string with `json` is stringified).
 */
export function encodePayload(data: unknown, type?: ContentTypeName | number): { payload: Uint8Array; contentType: number } {
  if (type === undefined) {
    const bytes = asBytes(data);
    if (bytes) return { payload: bytes, contentType: ContentType.Bytes };
    if (typeof data === 'string') return { payload: utf8.encode(data), contentType: ContentType.Text };
    return { payload: encodeJson(data), contentType: ContentType.Json };
  }
  const contentType = contentTypeCode(type);
  if (contentType === ContentType.Json && asBytes(data) === undefined) {
    return { payload: typeof data === 'string' ? utf8.encode(data) : encodeJson(data), contentType };
  }
  if (contentType === ContentType.Text && typeof data === 'string') return { payload: utf8.encode(data), contentType };
  const bytes = asBytes(data);
  if (!bytes) {
    throw new RealtimeError(Code.InvalidArgument, {
      message: 'payload must be a Uint8Array or ArrayBuffer for this content type',
      local: true,
    });
  }
  return { payload: bytes, contentType };
}

function encodeJson(data: unknown): Uint8Array {
  let text: string | undefined;
  try {
    text = JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  } catch (e) {
    throw new RealtimeError(Code.InvalidArgument, { message: 'payload is not JSON-serialisable', local: true, cause: e });
  }
  if (text === undefined) {
    throw new RealtimeError(Code.InvalidArgument, { message: 'payload is not JSON-serialisable', local: true });
  }
  return utf8.encode(text);
}

/** Decodes a payload by content type; undecodable JSON comes back as the bytes. */
export function decodePayload(contentType: number, payload: Uint8Array): unknown {
  switch (contentType) {
    case ContentType.Json:
      if (payload.length === 0) return undefined;
      try {
        return JSON.parse(utf8d.decode(payload));
      } catch {
        return payload;
      }
    case ContentType.Text:
      return utf8d.decode(payload);
    default:
      return payload;
  }
}

export function deliveryClassName(c: DeliveryClass): DeliveryClassName | undefined {
  switch (c) {
    case DeliveryClass.Durable:
      return 'durable';
    case DeliveryClass.LastValue:
      return 'last-value';
    case DeliveryClass.Ephemeral:
      return 'ephemeral';
    default:
      return undefined;
  }
}

export function deliveryClassCode(name: DeliveryClassName): DeliveryClass {
  switch (name) {
    case 'durable':
      return DeliveryClass.Durable;
    case 'last-value':
      return DeliveryClass.LastValue;
    case 'ephemeral':
      return DeliveryClass.Ephemeral;
    default:
      throw new RealtimeError(Code.InvalidArgument, { message: `unknown delivery class "${String(name)}"`, local: true });
  }
}

export type GapReasonName = 'expired' | 'epoch-lost' | 'slow-consumer' | 'unspecified';

export function gapReasonName(r: GapReason): GapReasonName {
  switch (r) {
    case GapReason.Expired:
      return 'expired';
    case GapReason.EpochLost:
      return 'epoch-lost';
    case GapReason.SlowConsumer:
      return 'slow-consumer';
    default:
      return 'unspecified';
  }
}

export function toMessage<T = unknown>(d: DeliveredEvent): Message<T> {
  const e = d.event;
  const cursor = { epoch: e.epoch, seq: e.seq };
  const headers: Record<string, string> = {};
  for (const [k, v] of e.headers) headers[k] = v;
  return {
    topic: d.topic,
    topicId: e.topicId,
    cursor,
    id: formatCursor(cursor),
    data: (e.tombstone ? undefined : decodePayload(e.contentType, e.payload)) as T,
    payload: e.payload,
    contentType: e.contentType,
    publisher: e.publisher,
    key: e.key,
    deleted: e.tombstone,
    headers,
    serverTime: e.serverTsMs,
    clientTime: e.clientTsMs || undefined,
    replayed: d.replayed,
    fromSnapshot: d.fromSnapshot,
  };
}
