/**
 * The server half of the codec, for tests only: encodes `RTES` packets the
 * way the node does and decodes the client's `RTEC` packets.
 */
import * as flatbuffers from 'flatbuffers';

import type { Cursor } from '../../src/shared/cursor';
import * as fb from '../../src/transport/wire/generated/rte/v1.js';
import type {
  ClientFrame,
  ClientMsg,
  Header,
  ServerFrame,
  ServerMsg,
  SubscribeBody,
  TopicRef,
  WireEvent,
} from '../../src/transport/wire/model';

type B = flatbuffers.Builder;

const str = (b: B, s: string | undefined) => (s === undefined ? 0 : b.createString(s));

function events(b: B, evs: readonly WireEvent[], create: (b: B, offs: number[]) => number): number {
  const offs = evs.map((e) => {
    const publisher = str(b, e.publisher);
    const key = str(b, e.key);
    const headers = e.headers.length
      ? fb.Event.createHeadersVector(
          b,
          e.headers.map(([k, v]) => fb.Header.createHeader(b, b.createString(k), b.createString(v))),
        )
      : 0;
    const payload = e.payload.length ? fb.Event.createPayloadVector(b, e.payload) : 0;
    const name = str(b, e.name);
    fb.Event.startEvent(b);
    fb.Event.addTopicId(b, e.topicId);
    fb.Event.addEpoch(b, e.epoch);
    fb.Event.addSeq(b, e.seq);
    fb.Event.addServerTsMs(b, BigInt(e.serverTsMs));
    fb.Event.addClientTsMs(b, BigInt(e.clientTsMs));
    if (publisher) fb.Event.addPublisher(b, publisher);
    if (key) fb.Event.addKey(b, key);
    if (e.tombstone) fb.Event.addTombstone(b, true);
    if (e.contentType) fb.Event.addContentType(b, e.contentType);
    if (headers) fb.Event.addHeaders(b, headers);
    if (payload) fb.Event.addPayload(b, payload);
    if (e.delivery) fb.Event.addDelivery(b, e.delivery);
    if (name) fb.Event.addName(b, name);
    if (e.uid) fb.Event.addUid(b, fb.Uuid128.createUuid128(b, e.uid.hi, e.uid.lo));
    return fb.Event.endEvent(b);
  });
  return create(b, offs);
}

function cursorField(b: B, add: (b: B, off: number) => void, c: Cursor | undefined) {
  if (c) add(b, fb.Cursor.createCursor(b, c.epoch, c.seq));
}

function body(b: B, m: ServerMsg): [fb.ServerBody, number] {
  const S = fb.ServerBody;
  switch (m.type) {
    case 'ping':
      return [S.Ping, fb.Ping.createPing(b, m.nonce, BigInt(m.tsMs))];
    case 'pong':
      return [S.Pong, fb.Pong.createPong(b, m.nonce, BigInt(m.tsMs))];
    case 'close':
      return [S.Close, fb.Close.createClose(b, m.code, b.createString(m.reason), m.retryAfterMs)];
    case 'extension':
      return [S.Extension, fb.Extension.createExtension(b, m.code, m.contentType, fb.Extension.createDataVector(b, m.data))];
    case 'welcome': {
      const server = b.createString(m.server);
      const identity = b.createString(m.identity);
      const segmentId = m.segmentId ? b.createString(m.segmentId) : 0;
      const environment = m.environment ? b.createString(m.environment) : 0;
      const features = m.features.length
        ? fb.Welcome.createFeaturesVector(
            b,
            m.features.map((f) => b.createString(f)),
          )
        : 0;
      const caps = m.capabilities.length
        ? fb.Welcome.createCapabilitiesVector(
            b,
            m.capabilities.map((c) =>
              fb.Capability.createCapability(
                b,
                b.createString(c.topic),
                fb.Capability.createOpsVector(
                  b,
                  c.ops.map((o) => b.createString(o)),
                ),
              ),
            ),
          )
        : 0;
      const l = m.limits;
      const limits = fb.Limits.createLimits(
        b,
        l.maxFrameBytes,
        l.maxPayloadBytes,
        l.maxFramesPerPacket,
        l.maxSubscriptions,
        l.maxTopicBytes,
        l.maxHeaders,
        l.heartbeatMs,
        l.idleTimeoutMs,
      );
      fb.Welcome.startWelcome(b);
      fb.Welcome.addProtoMinor(b, m.protoMinor);
      fb.Welcome.addServer(b, server);
      fb.Welcome.addServerTimeMs(b, BigInt(m.serverTimeMs));
      fb.Welcome.addSessionId(b, fb.Uuid128.createUuid128(b, m.sessionId.hi, m.sessionId.lo));
      fb.Welcome.addResumed(b, m.resumed);
      fb.Welcome.addIdentity(b, identity);
      fb.Welcome.addExpiresAtMs(b, BigInt(m.expiresAtMs));
      fb.Welcome.addLimits(b, limits);
      if (features) fb.Welcome.addFeatures(b, features);
      if (m.anonymous) fb.Welcome.addAnonymous(b, true);
      if (segmentId) fb.Welcome.addSegmentId(b, segmentId);
      if (environment) fb.Welcome.addEnvironment(b, environment);
      if (caps) fb.Welcome.addCapabilities(b, caps);
      return [S.Welcome, fb.Welcome.endWelcome(b)];
    }
    case 'tokenExpiring':
      return [S.TokenExpiring, fb.TokenExpiring.createTokenExpiring(b, BigInt(m.expiresAtMs))];
    case 'opOk':
      fb.OpOk.startOpOk(b);
      return [S.OpOk, fb.OpOk.endOpOk(b)];
    case 'opError':
      return [S.OpError, fb.OpError.createOpError(b, m.code, b.createString(m.message), m.retryAfterMs, m.topicId)];
    case 'pubAck':
      fb.PubAck.startPubAck(b);
      fb.PubAck.addTopicId(b, m.topicId);
      fb.PubAck.addLevel(b, m.level);
      fb.PubAck.addEpoch(b, m.cursor.epoch);
      fb.PubAck.addSeq(b, m.cursor.seq);
      fb.PubAck.addDuplicate(b, m.duplicate);
      fb.PubAck.addServerTsMs(b, BigInt(m.serverTsMs));
      if (m.uid) fb.PubAck.addUid(b, fb.Uuid128.createUuid128(b, m.uid.hi, m.uid.lo));
      return [S.PubAck, fb.PubAck.endPubAck(b)];
    case 'subAck': {
      const deliveries = m.deliveries.length ? fb.SubAck.createDeliveriesVector(b, [...m.deliveries]) : 0;
      fb.SubAck.startSubAck(b);
      fb.SubAck.addTopicId(b, m.topicId);
      fb.SubAck.addDelivery(b, m.delivery);
      fb.SubAck.addCatchingUp(b, m.catchingUp);
      cursorField(b, fb.SubAck.addOldest, m.oldest);
      cursorField(b, fb.SubAck.addLatest, m.latest);
      fb.SubAck.addSnapshotFollows(b, m.snapshotFollows);
      if (deliveries) fb.SubAck.addDeliveries(b, deliveries);
      return [S.SubAck, fb.SubAck.endSubAck(b)];
    }
    case 'gap':
      fb.Gap.startGap(b);
      fb.Gap.addTopicId(b, m.topicId);
      fb.Gap.addReason(b, m.reason);
      cursorField(b, fb.Gap.addRequested, m.requested);
      cursorField(b, fb.Gap.addOldest, m.oldest);
      cursorField(b, fb.Gap.addLatest, m.latest);
      fb.Gap.addResumed(b, m.resumed);
      return [S.Gap, fb.Gap.endGap(b)];
    case 'flow':
      return [S.Flow, fb.Flow.createFlow(b, m.action, m.retryAfterMs, m.topicId)];
    case 'pollEnd':
      return [S.PollEnd, fb.PollEnd.createPollEnd(b, m.timedOut, m.more)];
    case 'deliver': {
      const evs = events(b, m.events, fb.Deliver.createEventsVector);
      return [S.Deliver, fb.Deliver.createDeliver(b, m.topicId, m.delivery, m.replayed, evs)];
    }
    case 'snapshot': {
      const evs = events(b, m.events, fb.Snapshot.createEventsVector);
      fb.Snapshot.startSnapshot(b);
      fb.Snapshot.addTopicId(b, m.topicId);
      fb.Snapshot.addSnapshotId(b, m.snapshotId);
      fb.Snapshot.addChunk(b, m.chunk);
      fb.Snapshot.addLastChunk(b, m.lastChunk);
      cursorField(b, fb.Snapshot.addFence, m.fence);
      fb.Snapshot.addEvents(b, evs);
      return [S.Snapshot, fb.Snapshot.endSnapshot(b)];
    }
    case 'subEnded':
      return [S.SubEnded, fb.SubEnded.createSubEnded(b, m.topicId, m.code, b.createString(m.message))];
  }
}

export function encodeServerPacket(frames: readonly ServerFrame[], ident = 'RTES'): Uint8Array {
  const b = new flatbuffers.Builder(256);
  const offs = frames.map((f) => {
    const [type, off] = body(b, f.msg);
    return fb.ServerFrame.createServerFrame(b, f.corr, type, off);
  });
  const vec = fb.ServerPacket.createFramesVector(b, offs);
  b.finish(fb.ServerPacket.createServerPacket(b, vec), ident);
  return b.asUint8Array().slice();
}

// ------------------------------------------------------------ client decode

const topicRef = (name: string | null, id: bigint): TopicRef => (name ? { name } : { id });
const cur = (c: fb.Cursor | null): Cursor | undefined => (c ? { epoch: c.epoch(), seq: c.seq() } : undefined);

function subscribe(s: fb.Subscribe): SubscribeBody {
  return {
    topic: topicRef(s.topic(), s.topicId()),
    start: s.start(),
    cursor: cur(s.cursor()),
    lastN: s.lastN(),
    onGap: s.onGap(),
    snapshot: s.snapshot(),
    types: Array.from(s.typesArray() ?? []),
  };
}

function msg(f: fb.ClientFrame): ClientMsg {
  const C = fb.ClientBody;
  switch (f.bodyType()) {
    case C.Ping: {
      const p = f.body(new fb.Ping()) as fb.Ping;
      return { type: 'ping', nonce: p.nonce(), tsMs: Number(p.tsMs()) };
    }
    case C.Pong: {
      const p = f.body(new fb.Pong()) as fb.Pong;
      return { type: 'pong', nonce: p.nonce(), tsMs: Number(p.tsMs()) };
    }
    case C.Close: {
      const c = f.body(new fb.Close()) as fb.Close;
      return { type: 'close', code: c.code(), reason: c.reason() ?? undefined };
    }
    case C.Hello: {
      const h = f.body(new fb.Hello()) as fb.Hello;
      const features: string[] = [];
      for (let i = 0; i < h.featuresLength(); i++) features.push(h.features(i));
      return {
        type: 'hello',
        hello: {
          token: h.token() ?? '',
          client: h.client() ?? undefined,
          protoMinor: h.protoMinor(),
          maxFrameBytes: h.maxFrameBytes(),
          features,
          device: h.device() ?? undefined,
        },
      };
    }
    case C.Reauth:
      return { type: 'reauth', token: (f.body(new fb.Reauth()) as fb.Reauth).token() ?? '' };
    case C.Publish: {
      const p = f.body(new fb.Publish()) as fb.Publish;
      const headers: Header[] = [];
      for (let i = 0; i < p.headersLength(); i++) {
        const h = p.headers(i)!;
        headers.push([h.key()!, h.value() ?? '']);
      }
      const k = p.idempotencyKey();
      return {
        type: 'publish',
        publish: {
          topic: topicRef(p.topic(), p.topicId()),
          payload: p.payloadArray()?.slice() ?? new Uint8Array(0),
          contentType: p.contentType(),
          delivery: p.delivery(),
          ack: p.ack(),
          idempotencyKey: k ? { hi: k.hi(), lo: k.lo() } : undefined,
          key: p.key() ?? undefined,
          tombstone: p.tombstone(),
          ttlMs: p.ttlMs(),
          clientTsMs: Number(p.clientTsMs()),
          headers,
          name: p.name() ?? undefined,
        },
      };
    }
    case C.Subscribe:
      return { type: 'subscribe', subscribe: subscribe(f.body(new fb.Subscribe()) as fb.Subscribe) };
    case C.Unsubscribe: {
      const u = f.body(new fb.Unsubscribe()) as fb.Unsubscribe;
      return { type: 'unsubscribe', topic: topicRef(u.topic(), u.topicId()) };
    }
    case C.CursorAck: {
      const a = f.body(new fb.CursorAck()) as fb.CursorAck;
      const acks = [];
      for (let i = 0; i < a.acksLength(); i++) {
        const t = a.acks(i)!;
        acks.push({ topicId: t.topicId(), cursor: { epoch: t.cursor()!.epoch(), seq: t.cursor()!.seq() } });
      }
      return { type: 'cursorAck', acks };
    }
    case C.Poll: {
      const p = f.body(new fb.Poll()) as fb.Poll;
      const topics = [];
      for (let i = 0; i < p.topicsLength(); i++) topics.push(subscribe(p.topics(i)!));
      return { type: 'poll', poll: { topics, maxEvents: p.maxEvents(), waitMs: p.waitMs() } };
    }
    default:
      throw new Error(`unexpected client body ${f.bodyType()}`);
  }
}

export function decodeClientPacket(bytes: Uint8Array): ClientFrame[] {
  const bb = new flatbuffers.ByteBuffer(bytes);
  if (!bb.__has_identifier('RTEC')) throw new Error('missing RTEC identifier');
  const packet = fb.ClientPacket.getRootAsClientPacket(bb);
  const out: ClientFrame[] = [];
  for (let i = 0; i < packet.framesLength(); i++) {
    const f = packet.frames(i)!;
    out.push({ corr: f.corr(), msg: msg(f) });
  }
  return out;
}

export function event(topicId: bigint, epoch: bigint, seq: bigint, payload: string, extra: Partial<WireEvent> = {}): WireEvent {
  return {
    topicId,
    epoch,
    seq,
    serverTsMs: 1_700_000_000_000,
    clientTsMs: 0,
    publisher: 'bob',
    tombstone: false,
    contentType: fb.ContentType.Text,
    headers: [],
    payload: new TextEncoder().encode(payload),
    delivery: fb.DeliveryClass.Unspecified,
    ...extra,
  };
}
