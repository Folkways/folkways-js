/**
 * FlatBuffers codec for the client side of RTE v1: encodes `RTEC` client
 * packets and decodes `RTES` server packets.
 *
 * Decoding is fail-closed. The JavaScript FlatBuffers runtime has no
 * verifier, so the decoder checks size, identifier, frame count, union tags
 * and every vector length against the buffer, and reads every field eagerly
 * inside a guard: a malformed packet surfaces here as `BadFrame`, never later
 * in user code. Payloads are views into the received buffer (no copy).
 */
import * as flatbuffers from 'flatbuffers';

import { Code } from '../../shared/codes';
import type { Cursor } from '../../shared/cursor';
import { RealtimeError } from '../../shared/errors';
import * as fb from './generated/rte/v1.js';
import {
  type ClientFrame,
  type ClientMsg,
  type Header,
  type Limits,
  type ServerFrame,
  type ServerMsg,
  type SubscribeBody,
  type TopicRef,
  type WireEvent,
  CLIENT_IDENT,
  MAX_FRAMES_PER_PACKET,
  SERVER_IDENT,
} from './model';

type Builder = flatbuffers.Builder;
type Offset = flatbuffers.Offset;

const u64 = (n: number | bigint): bigint => (typeof n === 'bigint' ? n : BigInt(Math.max(0, Math.floor(n))));
const ms = (v: bigint): number => Number(v);

// ------------------------------------------------------------------ encode

function topicFields(b: Builder, t: TopicRef): { name: Offset; id: bigint } {
  return 'name' in t ? { name: b.createString(t.name), id: 0n } : { name: 0, id: t.id };
}

function headersVector(b: Builder, headers: readonly Header[] | undefined): Offset {
  if (!headers || headers.length === 0) return 0;
  const offs = headers.map(([k, v]) => fb.Header.createHeader(b, b.createString(k), b.createString(v)));
  return fb.Publish.createHeadersVector(b, offs);
}

function encodeSubscribe(b: Builder, s: SubscribeBody): Offset {
  const t = topicFields(b, s.topic);
  fb.Subscribe.startSubscribe(b);
  if (t.name) fb.Subscribe.addTopic(b, t.name);
  if (t.id) fb.Subscribe.addTopicId(b, t.id);
  fb.Subscribe.addStart(b, s.start ?? fb.StartAt.Latest);
  if (s.cursor) fb.Subscribe.addCursor(b, fb.Cursor.createCursor(b, s.cursor.epoch, s.cursor.seq));
  if (s.lastN) fb.Subscribe.addLastN(b, s.lastN);
  fb.Subscribe.addOnGap(b, s.onGap ?? fb.OnGap.FromOldest);
  fb.Subscribe.addSnapshot(b, s.snapshot ?? true);
  return fb.Subscribe.endSubscribe(b);
}

function encodeBody(b: Builder, msg: ClientMsg): [fb.ClientBody, Offset] {
  switch (msg.type) {
    case 'ping':
      return [fb.ClientBody.Ping, fb.Ping.createPing(b, msg.nonce, u64(msg.tsMs))];
    case 'pong':
      return [fb.ClientBody.Pong, fb.Pong.createPong(b, msg.nonce, u64(msg.tsMs))];
    case 'close': {
      const reason = msg.reason ? b.createString(msg.reason) : 0;
      return [fb.ClientBody.Close, fb.Close.createClose(b, msg.code, reason, 0)];
    }
    case 'hello': {
      const h = msg.hello;
      const token = b.createString(h.token);
      const client = h.client ? b.createString(h.client) : 0;
      const device = h.device ? b.createString(h.device) : 0;
      const features = h.features?.length
        ? fb.Hello.createFeaturesVector(
            b,
            h.features.map((f) => b.createString(f)),
          )
        : 0;
      fb.Hello.startHello(b);
      fb.Hello.addProtoMinor(b, h.protoMinor ?? 0);
      if (client) fb.Hello.addClient(b, client);
      fb.Hello.addToken(b, token);
      if (h.maxFrameBytes) fb.Hello.addMaxFrameBytes(b, h.maxFrameBytes);
      if (features) fb.Hello.addFeatures(b, features);
      if (device) fb.Hello.addDevice(b, device);
      return [fb.ClientBody.Hello, fb.Hello.endHello(b)];
    }
    case 'reauth':
      return [fb.ClientBody.Reauth, fb.Reauth.createReauth(b, b.createString(msg.token))];
    case 'publish': {
      const p = msg.publish;
      const t = topicFields(b, p.topic);
      const payload = p.payload.length ? fb.Publish.createPayloadVector(b, p.payload) : 0;
      const key = p.key !== undefined ? b.createString(p.key) : 0;
      const headers = headersVector(b, p.headers);
      fb.Publish.startPublish(b);
      if (t.name) fb.Publish.addTopic(b, t.name);
      if (t.id) fb.Publish.addTopicId(b, t.id);
      if (payload) fb.Publish.addPayload(b, payload);
      if (p.contentType) fb.Publish.addContentType(b, p.contentType);
      if (p.delivery) fb.Publish.addDelivery(b, p.delivery);
      if (p.ack) fb.Publish.addAck(b, p.ack);
      if (p.idempotencyKey) {
        fb.Publish.addIdempotencyKey(b, fb.Uuid128.createUuid128(b, p.idempotencyKey.hi, p.idempotencyKey.lo));
      }
      if (key) fb.Publish.addKey(b, key);
      if (p.tombstone) fb.Publish.addTombstone(b, true);
      if (p.ttlMs) fb.Publish.addTtlMs(b, p.ttlMs);
      if (p.clientTsMs) fb.Publish.addClientTsMs(b, u64(p.clientTsMs));
      if (headers) fb.Publish.addHeaders(b, headers);
      return [fb.ClientBody.Publish, fb.Publish.endPublish(b)];
    }
    case 'subscribe':
      return [fb.ClientBody.Subscribe, encodeSubscribe(b, msg.subscribe)];
    case 'unsubscribe': {
      const t = topicFields(b, msg.topic);
      return [fb.ClientBody.Unsubscribe, fb.Unsubscribe.createUnsubscribe(b, t.name, t.id)];
    }
    case 'cursorAck': {
      fb.CursorAck.startAcksVector(b, msg.acks.length);
      for (let i = msg.acks.length - 1; i >= 0; i--) {
        const a = msg.acks[i]!;
        fb.TopicCursor.createTopicCursor(b, a.topicId, a.cursor.epoch, a.cursor.seq);
      }
      const acks = b.endVector();
      return [fb.ClientBody.CursorAck, fb.CursorAck.createCursorAck(b, acks)];
    }
    case 'poll': {
      const subs = msg.poll.topics.map((s) => encodeSubscribe(b, s));
      const topics = fb.Poll.createTopicsVector(b, subs);
      return [fb.ClientBody.Poll, fb.Poll.createPoll(b, topics, msg.poll.maxEvents ?? 0, msg.poll.waitMs ?? 0)];
    }
  }
}

/** Encodes 1..64 frames as one `RTEC` packet. */
export function encodeClientPacket(frames: readonly ClientFrame[]): Uint8Array {
  if (frames.length === 0 || frames.length > MAX_FRAMES_PER_PACKET) {
    throw new RealtimeError(Code.InvalidArgument, {
      message: `a packet holds 1..${MAX_FRAMES_PER_PACKET} frames`,
      local: true,
    });
  }
  const b = new flatbuffers.Builder(256);
  const offs = frames.map((f) => {
    const [type, body] = encodeBody(b, f.msg);
    return fb.ClientFrame.createClientFrame(b, f.corr, type, body);
  });
  const vec = fb.ClientPacket.createFramesVector(b, offs);
  const packet = fb.ClientPacket.createClientPacket(b, vec);
  b.finish(packet, CLIENT_IDENT);
  return b.asUint8Array();
}

// ------------------------------------------------------------------ decode

function bad(message: string, cause?: unknown): RealtimeError {
  return new RealtimeError(Code.BadFrame, { message, local: true, cause });
}

/** Rejects vector lengths that cannot fit in the buffer (stops runaway loops). */
function checkLen(len: number, minElemBytes: number, total: number): number {
  if (!Number.isInteger(len) || len < 0 || len * minElemBytes > total) throw bad('vector length out of bounds');
  return len;
}

const cursorOf = (c: fb.Cursor | null): Cursor | undefined => (c ? { epoch: c.epoch(), seq: c.seq() } : undefined);

function decodeEvent(e: fb.Event | null, total: number): WireEvent {
  if (!e) throw bad('missing event');
  const hn = checkLen(e.headersLength(), 4, total);
  const headers: Header[] = [];
  for (let i = 0; i < hn; i++) {
    const h = e.headers(i);
    if (!h) throw bad('missing header');
    headers.push([h.key() ?? '', h.value() ?? '']);
  }
  checkLen(e.payloadLength(), 1, total);
  const key = e.key();
  return {
    topicId: e.topicId(),
    epoch: e.epoch(),
    seq: e.seq(),
    serverTsMs: ms(e.serverTsMs()),
    clientTsMs: ms(e.clientTsMs()),
    publisher: e.publisher() ?? '',
    key: key === null ? undefined : key,
    tombstone: e.tombstone(),
    contentType: e.contentType(),
    headers,
    payload: e.payloadArray() ?? new Uint8Array(0),
  };
}

function decodeEvents(len: number, get: (i: number) => fb.Event | null, total: number): WireEvent[] {
  const n = checkLen(len, 4, total);
  const out: WireEvent[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = decodeEvent(get(i), total);
  return out;
}

function decodeLimits(l: fb.Limits | null): Limits {
  if (!l) throw bad('Welcome without limits');
  return {
    maxFrameBytes: l.maxFrameBytes(),
    maxPayloadBytes: l.maxPayloadBytes(),
    maxFramesPerPacket: l.maxFramesPerPacket(),
    maxSubscriptions: l.maxSubscriptions(),
    maxTopicBytes: l.maxTopicBytes(),
    maxHeaders: l.maxHeaders(),
    heartbeatMs: l.heartbeatMs(),
    idleTimeoutMs: l.idleTimeoutMs(),
  };
}

function decodeServerBody(f: fb.ServerFrame, total: number): ServerMsg {
  const B = fb.ServerBody;
  const type = f.bodyType();
  switch (type) {
    case B.Ping: {
      const b = f.body(new fb.Ping()) as fb.Ping;
      return { type: 'ping', nonce: b.nonce(), tsMs: ms(b.tsMs()) };
    }
    case B.Pong: {
      const b = f.body(new fb.Pong()) as fb.Pong;
      return { type: 'pong', nonce: b.nonce(), tsMs: ms(b.tsMs()) };
    }
    case B.Close: {
      const b = f.body(new fb.Close()) as fb.Close;
      return { type: 'close', code: b.code(), reason: b.reason() ?? '', retryAfterMs: b.retryAfterMs() };
    }
    case B.Extension: {
      const b = f.body(new fb.Extension()) as fb.Extension;
      checkLen(b.dataLength(), 1, total);
      return { type: 'extension', code: b.code(), contentType: b.contentType(), data: b.dataArray() ?? new Uint8Array(0) };
    }
    case B.Welcome: {
      const b = f.body(new fb.Welcome()) as fb.Welcome;
      const sid = b.sessionId();
      const nf = checkLen(b.featuresLength(), 4, total);
      const features: string[] = [];
      for (let i = 0; i < nf; i++) features.push(b.features(i) ?? '');
      return {
        type: 'welcome',
        protoMinor: b.protoMinor(),
        server: b.server() ?? '',
        serverTimeMs: ms(b.serverTimeMs()),
        sessionId: { hi: sid?.hi() ?? 0n, lo: sid?.lo() ?? 0n },
        resumed: b.resumed(),
        identity: b.identity() ?? '',
        expiresAtMs: ms(b.expiresAtMs()),
        limits: decodeLimits(b.limits()),
        features,
        anonymous: b.anonymous(),
      };
    }
    case B.TokenExpiring: {
      const b = f.body(new fb.TokenExpiring()) as fb.TokenExpiring;
      return { type: 'tokenExpiring', expiresAtMs: ms(b.expiresAtMs()) };
    }
    case B.OpOk:
      return { type: 'opOk' };
    case B.OpError: {
      const b = f.body(new fb.OpError()) as fb.OpError;
      return {
        type: 'opError',
        code: b.code(),
        message: b.message() ?? '',
        retryAfterMs: b.retryAfterMs(),
        topicId: b.topicId(),
      };
    }
    case B.PubAck: {
      const b = f.body(new fb.PubAck()) as fb.PubAck;
      return {
        type: 'pubAck',
        topicId: b.topicId(),
        level: b.level(),
        cursor: { epoch: b.epoch(), seq: b.seq() },
        duplicate: b.duplicate(),
        serverTsMs: ms(b.serverTsMs()),
      };
    }
    case B.SubAck: {
      const b = f.body(new fb.SubAck()) as fb.SubAck;
      return {
        type: 'subAck',
        topicId: b.topicId(),
        delivery: b.delivery(),
        catchingUp: b.catchingUp(),
        oldest: cursorOf(b.oldest()),
        latest: cursorOf(b.latest()),
        snapshotFollows: b.snapshotFollows(),
      };
    }
    case B.Gap: {
      const b = f.body(new fb.Gap()) as fb.Gap;
      return {
        type: 'gap',
        topicId: b.topicId(),
        reason: b.reason(),
        requested: cursorOf(b.requested()),
        oldest: cursorOf(b.oldest()),
        latest: cursorOf(b.latest()),
        resumed: b.resumed(),
      };
    }
    case B.Flow: {
      const b = f.body(new fb.Flow()) as fb.Flow;
      return { type: 'flow', action: b.action(), retryAfterMs: b.retryAfterMs(), topicId: b.topicId() };
    }
    case B.PollEnd: {
      const b = f.body(new fb.PollEnd()) as fb.PollEnd;
      return { type: 'pollEnd', timedOut: b.timedOut(), more: b.more() };
    }
    case B.Deliver: {
      const b = f.body(new fb.Deliver()) as fb.Deliver;
      return {
        type: 'deliver',
        topicId: b.topicId(),
        delivery: b.delivery(),
        replayed: b.replayed(),
        events: decodeEvents(b.eventsLength(), (i) => b.events(i), total),
      };
    }
    case B.Snapshot: {
      const b = f.body(new fb.Snapshot()) as fb.Snapshot;
      return {
        type: 'snapshot',
        topicId: b.topicId(),
        snapshotId: b.snapshotId(),
        chunk: b.chunk(),
        lastChunk: b.lastChunk(),
        fence: cursorOf(b.fence()),
        events: decodeEvents(b.eventsLength(), (i) => b.events(i), total),
      };
    }
    case B.SubEnded: {
      const b = f.body(new fb.SubEnded()) as fb.SubEnded;
      return { type: 'subEnded', topicId: b.topicId(), code: b.code(), message: b.message() ?? '' };
    }
    default:
      // Unknown tags, and client-only tags in a server packet, fail closed.
      throw bad(`frame type ${String(type)} not accepted from a server`);
  }
}

/**
 * Decodes one `RTES` server packet. Throws `RealtimeError(BadFrame)` for
 * anything malformed and `FrameTooLarge` above `maxBytes`.
 */
export function decodeServerPacket(bytes: Uint8Array, maxBytes = Number.POSITIVE_INFINITY): ServerFrame[] {
  if (bytes.length > maxBytes) {
    throw new RealtimeError(Code.FrameTooLarge, { message: 'server packet exceeds the frame limit', local: true });
  }
  if (bytes.length < 8) throw bad('packet shorter than 8 bytes');
  const bb = new flatbuffers.ByteBuffer(bytes);
  if (!bb.__has_identifier(SERVER_IDENT)) {
    throw bad(bb.__has_identifier(CLIENT_IDENT) ? 'client packet received from a server' : 'missing RTES identifier');
  }
  try {
    const root = bb.readInt32(0);
    if (root < 8 || root >= bytes.length) throw bad('root offset out of bounds');
    const packet = fb.ServerPacket.getRootAsServerPacket(bb);
    const n = checkLen(packet.framesLength(), 4, bytes.length);
    if (n < 1 || n > MAX_FRAMES_PER_PACKET) throw bad(`packet must hold 1..${MAX_FRAMES_PER_PACKET} frames`);
    const frames: ServerFrame[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const f = packet.frames(i);
      if (!f) throw bad('missing frame');
      frames[i] = { corr: f.corr(), msg: decodeServerBody(f, bytes.length) };
    }
    return frames;
  } catch (e) {
    if (e instanceof RealtimeError) throw e;
    throw bad('packet failed to decode', e);
  }
}
