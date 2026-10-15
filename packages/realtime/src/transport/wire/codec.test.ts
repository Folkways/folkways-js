import { describe, expect, it } from 'vitest';

import { decodeClientPacket, encodeServerPacket, event } from '../../../test/support/server-codec';
import { Code } from '../../shared/codes';
import { RealtimeError } from '../../shared/errors';
import { decodeServerPacket, encodeClientPacket } from './codec';
import { AckMode, ContentType, DEFAULT_LIMITS, DeliveryClass, GapReason, OnGap, StartAt, type ClientMsg, type ServerMsg } from './model';

const BIG = (1n << 63n) + 12345n; // above 2^53 and 2^63

describe('client packets', () => {
  const msgs: ClientMsg[] = [
    { type: 'ping', nonce: BIG, tsMs: 1_700_000_000_123 },
    { type: 'pong', nonce: 7n, tsMs: 1 },
    { type: 'close', code: Code.Ok, reason: 'bye' },
    { type: 'hello', hello: { token: 'a.b.c', client: 'folkways-js/test', protoMinor: 0, maxFrameBytes: 1024, features: ['x'] } },
    { type: 'reauth', token: 't2' },
    {
      type: 'publish',
      publish: {
        topic: { name: 'chat/lobby' },
        payload: new Uint8Array([1, 2, 3]),
        contentType: ContentType.Json,
        delivery: DeliveryClass.Durable,
        ack: AckMode.Accepted,
        idempotencyKey: { hi: BIG, lo: 42n },
        key: 'k',
        tombstone: true,
        ttlMs: 30_000,
        clientTsMs: 1_700_000_000_000,
        headers: [['trace', 'abc']],
      },
    },
    {
      type: 'subscribe',
      subscribe: { topic: { id: 9n }, start: StartAt.After, cursor: { epoch: BIG, seq: 5n }, lastN: 0, onGap: OnGap.Fail, snapshot: false },
    },
    { type: 'unsubscribe', topic: { name: 'chat/lobby' } },
    { type: 'cursorAck', acks: [{ topicId: 3n, cursor: { epoch: BIG, seq: 99n } }] },
    {
      type: 'poll',
      poll: {
        topics: [
          { topic: { name: 'a/b' }, start: StartAt.Oldest, onGap: OnGap.FromOldest, snapshot: true },
          { topic: { name: 'c/d' }, start: StartAt.LastN, lastN: 10, onGap: OnGap.FromLatest, snapshot: true },
        ],
        maxEvents: 50,
        waitMs: 25_000,
      },
    },
  ];

  it('every client frame round-trips through the node-side decoder', () => {
    const frames = msgs.map((msg, i) => ({ corr: BigInt(i + 1), msg }));
    const bytes = encodeClientPacket(frames);
    expect(new TextDecoder().decode(bytes.subarray(4, 8))).toBe('RTEC');
    const back = decodeClientPacket(bytes);
    expect(back.map((f) => f.corr)).toEqual(frames.map((f) => f.corr));
    expect(back[0]!.msg).toEqual(msgs[0]);
    expect(back[3]!.msg).toEqual(msgs[3]);
    const pub = back[5]!.msg;
    expect(pub).toMatchObject({ type: 'publish', publish: { key: 'k', tombstone: true, ttlMs: 30_000, idempotencyKey: { hi: BIG, lo: 42n } } });
    expect(back[6]!.msg).toEqual(msgs[6]);
    expect(back[8]!.msg).toEqual(msgs[8]);
    expect(back[9]!.msg).toMatchObject({ type: 'poll', poll: { maxEvents: 50, waitMs: 25_000 } });
  });

  it('snapshot defaults to true and is only written when false', () => {
    const [f] = decodeClientPacket(encodeClientPacket([{ corr: 1n, msg: { type: 'subscribe', subscribe: { topic: { name: 'a' } } } }]));
    expect(f!.msg).toMatchObject({ subscribe: { start: StartAt.Latest, onGap: OnGap.FromOldest, snapshot: true } });
  });

  it('refuses empty and oversized frame lists', () => {
    expect(() => encodeClientPacket([])).toThrow(RealtimeError);
    const many = Array.from({ length: 65 }, (_, i) => ({ corr: BigInt(i + 1), msg: { type: 'pong', nonce: 1n, tsMs: 0 } as const }));
    expect(() => encodeClientPacket(many)).toThrow(/1\.\.64/);
  });
});

describe('server packets', () => {
  const ev = event(4n, BIG, 1n, 'hi', { headers: [['h', 'v']], key: 'driver-7', clientTsMs: 5 });
  const msgs: ServerMsg[] = [
    { type: 'ping', nonce: 1n, tsMs: 2 },
    { type: 'pong', nonce: BIG, tsMs: 3 },
    { type: 'close', code: Code.Draining, reason: 'drain', retryAfterMs: 250 },
    { type: 'extension', code: 9, contentType: 1, data: new Uint8Array([7]) },
    {
      type: 'welcome',
      protoMinor: 0,
      server: 'rte-1',
      serverTimeMs: 1_700_000_000_000,
      sessionId: { hi: BIG, lo: 1n },
      resumed: false,
      identity: 'alice',
      expiresAtMs: 1_700_000_600_000,
      limits: { ...DEFAULT_LIMITS, heartbeatMs: 1_000 },
      features: [],
    },
    { type: 'tokenExpiring', expiresAtMs: 99 },
    { type: 'opOk' },
    { type: 'opError', code: Code.RateLimited, message: 'slow down', retryAfterMs: 10, topicId: 3n },
    { type: 'pubAck', topicId: 3n, level: AckMode.Accepted, cursor: { epoch: BIG, seq: 8n }, duplicate: true, serverTsMs: 4 },
    {
      type: 'subAck',
      topicId: 3n,
      delivery: DeliveryClass.Durable,
      catchingUp: true,
      oldest: { epoch: BIG, seq: 1n },
      latest: undefined,
      snapshotFollows: false,
    },
    {
      type: 'gap',
      topicId: 3n,
      reason: GapReason.Expired,
      requested: { epoch: 1n, seq: 2n },
      oldest: undefined,
      latest: { epoch: 1n, seq: 9n },
      resumed: true,
    },
    { type: 'flow', action: 1, retryAfterMs: 5, topicId: 3n },
    { type: 'pollEnd', timedOut: true, more: false },
    { type: 'deliver', topicId: 4n, delivery: DeliveryClass.LastValue, replayed: true, events: [ev] },
    { type: 'snapshot', topicId: 4n, snapshotId: 77n, chunk: 2, lastChunk: true, fence: { epoch: BIG, seq: 1n }, events: [ev] },
    { type: 'subEnded', topicId: 4n, code: Code.Forbidden, message: 'rights changed' },
  ];

  it('decodes every server frame type', () => {
    const frames = msgs.map((msg, i) => ({ corr: BigInt(i), msg }));
    const back = decodeServerPacket(encodeServerPacket(frames));
    expect(back.map((f) => f.corr)).toEqual(frames.map((f) => f.corr));
    for (let i = 0; i < msgs.length; i++) expect(back[i]!.msg).toEqual(msgs[i]);
  });

  it('rejects a client packet, a missing identifier and short buffers with BadFrame', () => {
    const clientPacket = encodeClientPacket([{ corr: 1n, msg: { type: 'pong', nonce: 1n, tsMs: 0 } }]);
    const expectBad = (b: Uint8Array) => {
      try {
        decodeServerPacket(b);
        throw new Error('decoded');
      } catch (e) {
        expect(e).toBeInstanceOf(RealtimeError);
        expect((e as RealtimeError).code).toBe(Code.BadFrame);
      }
    };
    expectBad(clientPacket);
    expectBad(encodeServerPacket([{ corr: 0n, msg: { type: 'opOk' } }], 'XXXX'));
    expectBad(new Uint8Array(4));
  });

  it('enforces the size limit', () => {
    const b = encodeServerPacket([{ corr: 0n, msg: { type: 'opOk' } }]);
    expect(() => decodeServerPacket(b, b.length - 1)).toThrow(/FrameTooLarge/);
  });

  it('never throws anything but RealtimeError on corrupted input, and never hangs', () => {
    const base = encodeServerPacket(msgs.map((msg, i) => ({ corr: BigInt(i), msg })));
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    let decoded = 0;
    for (let i = 0; i < 5_000; i++) {
      const b = base.slice(0, i % 3 === 0 ? rnd() % base.length : base.length);
      const flips = 1 + (rnd() % 8);
      for (let j = 0; j < flips && b.length > 8; j++) b[8 + (rnd() % (b.length - 8))] ^= 1 << (rnd() % 8);
      try {
        decodeServerPacket(b);
        decoded++;
      } catch (e) {
        expect(e).toBeInstanceOf(RealtimeError);
      }
    }
    expect(decoded).toBeLessThan(5_000);
    for (let i = 0; i < 2_000; i++) {
      const b = new Uint8Array(8 + (rnd() % 200)).map(() => rnd() & 0xff);
      b.set([0x52, 0x54, 0x45, 0x53], 4); // RTES
      try {
        decodeServerPacket(b);
      } catch (e) {
        expect(e).toBeInstanceOf(RealtimeError);
      }
    }
  });
});
