import { ContentType, DeliveryClass, type DeliveredEvent, GapReason } from '../engine';
import { Code } from '../shared/codes';
import { type Cursor, formatCursor } from '../shared/cursor';
import { RealtimeError } from '../shared/errors';
import { format128 } from '../shared/random';
import type { ContentTypeName, Delivery, GapReasonName, Message } from './types';

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

/** The public name of a wire delivery class (internal names stay on the wire). */
export function deliveryName(c: DeliveryClass): Delivery {
  switch (c) {
    case DeliveryClass.LastValue:
      return 'kv';
    case DeliveryClass.Ephemeral:
      return 'signal';
    default:
      return 'stream';
  }
}

export function deliveryCode(name: Delivery): DeliveryClass {
  switch (name) {
    case 'stream':
      return DeliveryClass.Durable;
    case 'kv':
      return DeliveryClass.LastValue;
    case 'signal':
      return DeliveryClass.Ephemeral;
    default:
      throw new RealtimeError(Code.InvalidArgument, { message: `unknown delivery "${String(name)}"; use stream, kv or signal`, local: true });
  }
}

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

/** `"epoch:seq"` for numbered events, else the uid: unique within a topic. */
export function eventId(cursor: Cursor | undefined, uid: string | undefined, fallback: string): string {
  if (cursor) return formatCursor(cursor);
  return uid ?? fallback;
}

export function toMessage<T = unknown, E extends string = string>(d: DeliveredEvent, extra: { fromCache?: boolean } = {}): Message<T, E> {
  const e = d.event;
  const delivery = deliveryName(d.delivery);
  const cursor = e.seq > 0n ? { epoch: e.epoch, seq: e.seq } : undefined;
  const uid = e.uid ? format128(e.uid) : undefined;
  const name = (e.name ?? '') as E;
  const key = delivery === 'signal' ? e.publisher : e.key;
  const headers: Record<string, string> = {};
  for (const [k, v] of e.headers) headers[k] = v;
  return {
    topic: d.topic,
    name,
    delivery,
    publisher: e.publisher,
    data: (e.tombstone ? undefined : decodePayload(e.contentType, e.payload)) as T,
    uid,
    cursor,
    id: eventId(cursor, uid, `${delivery}/${name}/${key ?? ''}/${e.serverTsMs}`),
    key,
    deleted: e.tombstone,
    headers,
    contentType: e.contentType,
    payload: e.payload,
    serverTime: e.serverTsMs,
    clientTime: e.clientTsMs || undefined,
    replayed: d.replayed,
    pending: false,
    fromCache: extra.fromCache ?? false,
  };
}
