import { afterEach, describe, expect, it, vi } from 'vitest';

import { type ClientOptions, Code, type Message, RealtimeClient, RealtimeError, createClient } from '../src';
import { AckMode, ContentType, DeliveryClass, GapReason, OnGap, StartAt } from '../src/transport/wire/model';
import { FakeRequestTransport, FakeStreamTransport, until } from './support/fake-transport';
import { event } from './support/server-codec';
import { mintToken } from './support/token';

const EPOCH = 1879046969544933376n;
const clients: RealtimeClient[] = [];

function client(fake: FakeStreamTransport, opts: Partial<ClientOptions> = {}): RealtimeClient {
  const c = createClient({
    endpoints: { websocket: 'ws://fake/v1/ws' },
    transports: ['websocket'],
    token: mintToken('alice'),
    reconnect: { initialDelayMs: 1, maxDelayMs: 5 },
    connectTimeoutMs: 0,
    transportOverrides: { stream: fake },
    ...opts,
  });
  clients.push(c);
  return c;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

describe('connection', () => {
  it('sends Hello first, with the token and client name, and connects on Welcome', async () => {
    const fake = new FakeStreamTransport();
    const token = mintToken('alice');
    const c = client(fake, { token, clientName: 'test-app/1.0' });
    const conn = await fake.nextConn();
    const hello = await conn.welcome({ identity: 'alice' });
    expect(conn.received[0]).toBe(hello);
    expect(hello.corr).not.toBe(0n);
    expect(hello.msg).toMatchObject({ type: 'hello', hello: { token, client: 'test-app/1.0' } });
    await c.connect();
    expect(c.state).toBe('connected');
    expect(c.transport).toBe('websocket');
    expect(c.identity).toBe('alice');
  });

  it('sends the device label in Hello', async () => {
    const fake = new FakeStreamTransport();
    client(fake, { device: 'web-chrome' });
    const hello = await (await fake.nextConn()).welcome();
    expect(hello.msg).toMatchObject({ type: 'hello', hello: { device: 'web-chrome' } });
  });

  it('does not reconnect after Replaced (a newer connection took over)', async () => {
    const fake = new FakeStreamTransport();
    const c = client(fake);
    const conn = await fake.nextConn();
    await conn.welcome();
    await c.connect();
    conn.serverClose(Code.Replaced, 'replaced by a newer connection');
    await until(() => c.state === 'closed');
    expect(c.error?.code).toBe(Code.Replaced);
    expect(fake.conns).toHaveLength(1);
  });

  it('rejects connect and closes on AuthInvalid with a static token', async () => {
    const fake = new FakeStreamTransport();
    const c = client(fake);
    const conn = await fake.nextConn();
    await conn.next('hello');
    conn.serverClose(Code.AuthInvalid, 'authentication failed');
    const err = await c.connect().catch((e) => e);
    expect(err).toBeInstanceOf(RealtimeError);
    expect(err.code).toBe(Code.AuthInvalid);
    expect(c.state).toBe('closed');
  });

  it('asks the provider for a fresh token once after AuthInvalid, then gives up', async () => {
    const fake = new FakeStreamTransport();
    const reasons: string[] = [];
    const c = client(fake, {
      token: ({ reason }) => {
        reasons.push(reason);
        return mintToken('alice');
      },
    });
    const conn1 = await fake.nextConn();
    await conn1.next('hello');
    conn1.serverClose(Code.AuthInvalid);
    const conn2 = await fake.nextConn();
    await conn2.next('hello');
    conn2.serverClose(Code.AuthInvalid);
    const err = await c.connect().catch((e) => e);
    expect(err.code).toBe(Code.AuthInvalid);
    expect(reasons).toEqual(['connect', 'connect']);
    expect(fake.conns).toHaveLength(2);
  });

  it('reconnects after a drop and honours Draining', async () => {
    const fake = new FakeStreamTransport();
    const c = client(fake);
    const states: string[] = [];
    c.on('state', (s) => states.push(s));
    await (await fake.nextConn()).welcome();
    await c.connect();
    fake.conns[0]!.drop();
    await (await fake.nextConn()).welcome();
    await until(() => c.state === 'connected' && fake.conns.length === 2);
    fake.conns[1]!.serverClose(Code.Draining, 'node draining', 20);
    const t0 = Date.now();
    await (await fake.nextConn()).welcome();
    await until(() => c.state === 'connected' && fake.conns.length === 3);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15);
    expect(states).toContain('reconnecting');
  });

  it('falls back to HTTP after repeated WebSocket failures', async () => {
    const fake = new FakeStreamTransport();
    fake.refuse = 10;
    const http = new FakeRequestTransport((_path, _token, frames) => ({
      frames: frames.map((f) => ({ corr: f.corr, msg: { type: 'pong', nonce: 1n, tsMs: Date.now() } as const })),
    }));
    const c = client(fake, {
      endpoints: { websocket: 'ws://fake/v1/ws', http: 'http://fake' },
      transports: ['websocket', 'http'],
      transportOverrides: { stream: fake, request: http },
    });
    await c.connect();
    expect(c.transport).toBe('http');
    expect(fake.attempts).toBe(2);
    expect(http.calls[0]!.path).toBe('/v1/publish');
    expect(http.calls[0]!.frames[0]!.msg.type).toBe('ping');
  });

  it('pings at the heartbeat interval and reconnects when the node goes silent', async () => {
    const fake = new FakeStreamTransport();
    const c = client(fake, { pongTimeoutMs: 100 });
    const conn = await fake.nextConn();
    await conn.welcome({ limits: { heartbeatMs: 100 } });
    await c.connect();
    const ping = await conn.next('ping', 1_000);
    expect(ping.msg.nonce).not.toBe(0n);
    // Never answer: after heartbeat + pongTimeout of silence the client reconnects.
    const conn2 = await fake.nextConn(2_000);
    expect(conn.closed).toBe(true);
    await conn2.welcome();
  });

  it('refreshes the token on TokenExpiring with Reauth', async () => {
    const fake = new FakeStreamTransport();
    const reasons: string[] = [];
    const c = client(fake, {
      token: ({ reason }) => {
        reasons.push(reason);
        return mintToken('alice');
      },
    });
    const conn = await fake.nextConn();
    await conn.welcome();
    await c.connect();
    const refreshed = new Promise((r) => c.once('tokenRefreshed', r));
    conn.reply(0n, { type: 'tokenExpiring', expiresAtMs: Date.now() + 60_000 });
    const reauth = await conn.next('reauth');
    conn.reply(reauth.corr, { type: 'opOk' });
    await refreshed;
    expect(reasons).toEqual(['connect', 'refresh']);
  });

  it('ends with AuthExpired when a static token expires', async () => {
    const fake = new FakeStreamTransport();
    const c = client(fake);
    const conn = await fake.nextConn();
    await conn.welcome();
    await c.connect();
    const failed = new Promise<RealtimeError>((r) => c.on('error', r));
    conn.serverClose(Code.AuthExpired, 'token expired');
    expect((await failed).code).toBe(Code.AuthExpired);
    expect(c.state).toBe('closed');
  });
});

describe('publish', () => {
  it('sends an Accepted publish with a fresh idempotency key and resolves with the receipt', async () => {
    const fake = new FakeStreamTransport();
    const c = client(fake);
    const conn = await fake.nextConn();
    await conn.welcome();
    await c.connect();
    const p = c.topic('chat/lobby').publish({ text: 'hi' }, { headers: { trace: 't1' } });
    const f = await conn.next('publish');
    expect(f.msg.publish).toMatchObject({
      topic: { name: 'chat/lobby' },
      contentType: ContentType.Json,
      ack: AckMode.Accepted,
      headers: [['trace', 't1']],
    });
    expect(JSON.parse(new TextDecoder().decode(f.msg.publish.payload))).toEqual({ text: 'hi' });
    expect(f.msg.publish.idempotencyKey).toBeDefined();
    conn.reply(f.corr, { type: 'pubAck', topicId: 1n, level: AckMode.Accepted, cursor: { epoch: EPOCH, seq: 1n }, duplicate: false, serverTsMs: 5 });
    await expect(p).resolves.toMatchObject({ id: `${EPOCH}:1`, level: 'accepted', duplicate: false, topicId: 1n });
  });

  it('queues while offline and sends after Welcome', async () => {
    const fake = new FakeStreamTransport();
    const c = client(fake);
    const p = c.publish('chat/lobby', 'early');
    const conn = await fake.nextConn();
    await conn.welcome();
    const f = await conn.next('publish');
    conn.reply(f.corr, { type: 'pubAck', topicId: 1n, level: AckMode.Accepted, cursor: { epoch: EPOCH, seq: 1n }, duplicate: false, serverTsMs: 1 });
    await expect(p).resolves.toMatchObject({ id: `${EPOCH}:1` });
  });

  it('resends an in-flight publish with the same idempotency key after a reconnect', async () => {
    const fake = new FakeStreamTransport();
    const c = client(fake);
    const conn1 = await fake.nextConn();
    await conn1.welcome();
    await c.connect();
    const p = c.publish('chat/lobby', 'once');
    const first = await conn1.next('publish');
    conn1.drop();
    const conn2 = await fake.nextConn();
    await conn2.welcome();
    const second = await conn2.next('publish');
    expect(second.msg.publish.idempotencyKey).toEqual(first.msg.publish.idempotencyKey);
    expect(second.msg.publish.clientTsMs).toBe(first.msg.publish.clientTsMs);
    conn2.reply(second.corr, { type: 'pubAck', topicId: 1n, level: AckMode.Accepted, cursor: { epoch: EPOCH, seq: 1n }, duplicate: true, serverTsMs: 1 });
    await expect(p).resolves.toMatchObject({ duplicate: true });
  });

  it('retries RateLimited after retry_after_ms and rejects non-retryable errors', async () => {
    const fake = new FakeStreamTransport();
    const c = client(fake);
    const conn = await fake.nextConn();
    await conn.welcome();
    await c.connect();
    const p = c.publish('chat/lobby', 'x');
    const a = await conn.next('publish');
    conn.reply(a.corr, { type: 'opError', code: Code.RateLimited, message: 'slow', retryAfterMs: 20, topicId: 0n });
    const b = await conn.next('publish');
    expect(b.msg.publish.idempotencyKey).toEqual(a.msg.publish.idempotencyKey);
    conn.reply(b.corr, { type: 'pubAck', topicId: 1n, level: AckMode.Accepted, cursor: { epoch: 1n, seq: 1n }, duplicate: false, serverTsMs: 1 });
    await expect(p).resolves.toBeDefined();

    const q = c.publish('other/x', 'nope');
    const f = await conn.next('publish');
    conn.reply(f.corr, { type: 'opError', code: Code.Forbidden, message: 'not allowed', retryAfterMs: 0, topicId: 0n });
    await expect(q).rejects.toMatchObject({ code: Code.Forbidden, topic: 'other/x', local: false });
  });

  it('validates locally before sending', async () => {
    const fake = new FakeStreamTransport();
    const c = client(fake);
    const conn = await fake.nextConn();
    await conn.welcome({ limits: { maxPayloadBytes: 4 } });
    await c.connect();
    await expect(c.publish('chat/lobby', 'too long')).rejects.toMatchObject({ code: Code.PayloadTooLarge, local: true });
    expect(() => c.topic('bad topic')).toThrow(RealtimeError);
    await expect(c.publish('chat/lobby', 'x', { idempotencyKey: 'nope' })).rejects.toMatchObject({ code: Code.InvalidArgument });
    expect(conn.sent('publish')).toHaveLength(0);
  });

  it('signal() is fire-and-forget with NoAck', async () => {
    const fake = new FakeStreamTransport();
    const c = client(fake);
    const conn = await fake.nextConn();
    await conn.welcome();
    await c.connect();
    c.topic('typing/room-1').signal({ typing: true });
    const f = await conn.next('publish');
    expect(f.msg.publish.ack).toBe(AckMode.NoAck);
    expect(f.msg.publish.idempotencyKey).toBeUndefined();
  });

  it('rejects pending publishes on close', async () => {
    const fake = new FakeStreamTransport();
    const c = client(fake);
    const p = c.publish('chat/lobby', 'x');
    const rejected = expect(p).rejects.toMatchObject({ code: Code.ClientClosed });
    const t0 = Date.now();
    await c.close();
    await rejected;
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe('subscribe', () => {
  async function connected(opts: Partial<ClientOptions> = {}) {
    const fake = new FakeStreamTransport();
    const c = client(fake, opts);
    const conn = await fake.nextConn();
    await conn.welcome();
    await c.connect();
    return { fake, c, conn };
  }

  it('subscribes, delivers in order with async handlers, and drops duplicates', async () => {
    const { c, conn } = await connected();
    const seen: string[] = [];
    const sub = c.topic('chat/lobby').subscribe<string>(async (m) => {
      await new Promise((r) => setTimeout(r, m.data === 'one' ? 20 : 0));
      seen.push(m.data);
    });
    const s = await conn.next('subscribe');
    expect(s.msg.subscribe).toMatchObject({ topic: { name: 'chat/lobby' }, start: StartAt.Latest, onGap: OnGap.FromOldest });
    conn.reply(s.corr, { type: 'subAck', topicId: 7n, delivery: DeliveryClass.Durable, catchingUp: false, snapshotFollows: false, deliveries: [] });
    await sub.ready;
    expect(sub.deliveryClass).toBe('durable');
    conn.reply(0n, {
      type: 'deliver',
      topicId: 7n,
      delivery: DeliveryClass.Durable,
      replayed: false,
      events: [event(7n, EPOCH, 1n, 'one'), event(7n, EPOCH, 2n, 'two')],
    });
    conn.reply(0n, { type: 'deliver', topicId: 7n, delivery: DeliveryClass.Durable, replayed: false, events: [event(7n, EPOCH, 2n, 'two')] });
    await until(() => seen.length >= 2);
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual(['one', 'two']);
    expect(sub.cursor).toEqual({ epoch: EPOCH, seq: 2n });
  });

  it('resubscribes after a reconnect from the last cursor', async () => {
    const { fake, c, conn } = await connected();
    const got: Message[] = [];
    const sub = c.subscribe('chat/lobby', (m) => {
      got.push(m);
    });
    const s = await conn.next('subscribe');
    conn.reply(s.corr, { type: 'subAck', topicId: 7n, delivery: DeliveryClass.Durable, catchingUp: false, snapshotFollows: false, deliveries: [] });
    conn.reply(0n, { type: 'deliver', topicId: 7n, delivery: DeliveryClass.Durable, replayed: false, events: [event(7n, EPOCH, 5n, 'a')] });
    await until(() => got.length === 1);
    conn.drop();
    await until(() => sub.status === 'resyncing');
    const conn2 = await fake.nextConn();
    await conn2.welcome();
    const s2 = await conn2.next('subscribe');
    expect(s2.msg.subscribe).toMatchObject({ start: StartAt.After, cursor: { epoch: EPOCH, seq: 5n } });
    conn2.reply(s2.corr, { type: 'subAck', topicId: 8n, delivery: DeliveryClass.Durable, catchingUp: true, snapshotFollows: false, deliveries: [] });
    conn2.reply(0n, {
      type: 'deliver',
      topicId: 8n,
      delivery: DeliveryClass.Durable,
      replayed: true,
      events: [event(8n, EPOCH, 5n, 'a'), event(8n, EPOCH, 6n, 'b')],
    });
    await until(() => got.length === 2);
    expect(got.map((m) => m.data)).toEqual(['a', 'b']);
    expect(got[1]!.replayed).toBe(true);
    expect(sub.status).toBe('active');
  });

  it('correlates a Gap that takes the corr with the SubAck that follows on corr 0', async () => {
    const { c, conn } = await connected({
      cursorStore: { get: () => ({ epoch: 1n, seq: 3n }), set: () => {} },
    });
    const sub = c.topic('chat/lobby').subscribe();
    const gaps: unknown[] = [];
    sub.on('gap', (g) => gaps.push(g));
    const s = await conn.next('subscribe');
    expect(s.msg.subscribe).toMatchObject({ start: StartAt.After, cursor: { epoch: 1n, seq: 3n } });
    conn.push(
      {
        corr: s.corr,
        msg: {
          type: 'gap',
          topicId: 7n,
          reason: GapReason.EpochLost,
          requested: { epoch: 1n, seq: 3n },
          oldest: { epoch: EPOCH, seq: 1n },
          latest: { epoch: EPOCH, seq: 4n },
          resumed: true,
        },
      },
      { corr: 0n, msg: { type: 'subAck', topicId: 7n, delivery: DeliveryClass.Durable, catchingUp: true, snapshotFollows: false, deliveries: [] } },
    );
    await sub.ready;
    expect(gaps).toEqual([{ reason: 'epoch-lost', requested: { epoch: 1n, seq: 3n }, oldest: { epoch: EPOCH, seq: 1n }, latest: { epoch: EPOCH, seq: 4n }, resumed: true }]);
  });

  it("fails the subscription on a Gap with onGap: 'fail'", async () => {
    const { c, conn } = await connected();
    const sub = c.topic('chat/lobby').subscribe({ from: { after: '1:3' }, onGap: 'fail' });
    const s = await conn.next('subscribe');
    expect(s.msg.subscribe.onGap).toBe(OnGap.Fail);
    conn.reply(s.corr, { type: 'gap', topicId: 7n, reason: GapReason.Expired, resumed: false });
    await expect(sub.ready).rejects.toMatchObject({ code: Code.InvalidCursor });
    expect(sub.status).toBe('failed');
  });

  it('rejects ready when the node refuses the subscription', async () => {
    const { c, conn } = await connected();
    const sub = c.topic('secret/x').subscribe();
    const s = await conn.next('subscribe');
    conn.reply(s.corr, { type: 'opError', code: Code.Forbidden, message: 'not allowed', retryAfterMs: 0, topicId: 0n });
    await expect(sub.ready).rejects.toMatchObject({ code: Code.Forbidden, topic: 'secret/x' });
  });

  it('assembles snapshot chunks, keeps values and applies tombstones', async () => {
    const { c, conn } = await connected();
    const sub = c.topic('rides/42/location').subscribe();
    const snapshots: Message[][] = [];
    sub.on('snapshot', (ms) => snapshots.push(ms));
    const s = await conn.next('subscribe');
    conn.push(
      { corr: s.corr, msg: { type: 'subAck', topicId: 3n, delivery: DeliveryClass.LastValue, catchingUp: false, snapshotFollows: true, deliveries: [] } },
      {
        corr: 0n,
        msg: { type: 'snapshot', topicId: 3n, snapshotId: 1n, chunk: 0, lastChunk: false, events: [event(3n, EPOCH, 1n, 'a', { key: 'd1' })] },
      },
      {
        corr: 0n,
        msg: {
          type: 'snapshot',
          topicId: 3n,
          snapshotId: 1n,
          chunk: 1,
          lastChunk: true,
          fence: { epoch: EPOCH, seq: 2n },
          events: [event(3n, EPOCH, 2n, 'b', { key: 'd2' })],
        },
      },
    );
    await until(() => snapshots.length === 1);
    expect(snapshots[0]!.map((m) => m.key)).toEqual(['d1', 'd2']);
    expect([...sub.values.keys()]).toEqual(['d1', 'd2']);
    conn.reply(0n, {
      type: 'deliver',
      topicId: 3n,
      delivery: DeliveryClass.LastValue,
      replayed: false,
      events: [event(3n, EPOCH, 3n, '', { key: 'd1', tombstone: true })],
    });
    await until(() => sub.values.size === 1);
    expect([...sub.values.keys()]).toEqual(['d2']);

    // A second handle on the same topic shares the wire subscription and gets the current state.
    const late: Message[][] = [];
    const sub2 = c.topic('rides/42/location').subscribe();
    sub2.on('snapshot', (ms) => late.push(ms));
    await sub2.ready;
    await until(() => late.length === 1);
    expect(late[0]!.map((m) => m.key)).toEqual(['d2']);
    expect(conn.sent('subscribe')).toHaveLength(1);
  });

  it('ends the subscription on SubEnded', async () => {
    const { c, conn } = await connected();
    const sub = c.topic('chat/lobby').subscribe();
    const s = await conn.next('subscribe');
    conn.reply(s.corr, { type: 'subAck', topicId: 7n, delivery: DeliveryClass.Durable, catchingUp: false, snapshotFollows: false, deliveries: [] });
    await sub.ready;
    const ended = new Promise<RealtimeError>((r) => sub.on('ended', r));
    conn.reply(0n, { type: 'subEnded', topicId: 7n, code: Code.Forbidden, message: 'rights changed' });
    expect((await ended).code).toBe(Code.Forbidden);
    expect(sub.status).toBe('ended');
  });

  it('unsubscribes on the wire only when the last handle leaves, after a tick', async () => {
    const { c, conn } = await connected();
    const a = c.topic('chat/lobby').subscribe();
    const s = await conn.next('subscribe');
    conn.reply(s.corr, { type: 'subAck', topicId: 7n, delivery: DeliveryClass.Durable, catchingUp: false, snapshotFollows: false, deliveries: [] });
    await a.ready;
    // StrictMode-style unmount/remount: no wire traffic.
    await a.unsubscribe();
    const b = c.topic('chat/lobby').subscribe();
    await b.ready;
    await new Promise((r) => setTimeout(r, 20));
    expect(conn.sent('unsubscribe')).toHaveLength(0);
    expect(conn.sent('subscribe')).toHaveLength(1);
    await b.unsubscribe();
    const u = await conn.next('unsubscribe');
    expect(u.msg.topic).toEqual({ id: 7n });
  });

  it('hints processed cursors with CursorAck', async () => {
    const { c, conn } = await connected({ cursorAckIntervalMs: 20 });
    c.topic('chat/lobby').subscribe();
    const s = await conn.next('subscribe');
    conn.reply(s.corr, { type: 'subAck', topicId: 7n, delivery: DeliveryClass.Durable, catchingUp: false, snapshotFollows: false, deliveries: [] });
    conn.reply(0n, { type: 'deliver', topicId: 7n, delivery: DeliveryClass.Durable, replayed: false, events: [event(7n, EPOCH, 9n, 'x')] });
    const ack = await conn.next('cursorAck', 1_000);
    expect(ack.msg.acks).toEqual([{ topicId: 7n, cursor: { epoch: EPOCH, seq: 9n } }]);
  });

  it('persists processed Durable cursors to the cursor store', async () => {
    const set = vi.fn();
    const { c, conn } = await connected({ cursorStore: { get: () => undefined, set } });
    c.topic('chat/lobby').subscribe(() => {});
    const s = await conn.next('subscribe');
    conn.reply(s.corr, { type: 'subAck', topicId: 7n, delivery: DeliveryClass.Durable, catchingUp: false, snapshotFollows: false, deliveries: [] });
    conn.reply(0n, { type: 'deliver', topicId: 7n, delivery: DeliveryClass.Durable, replayed: false, events: [event(7n, EPOCH, 4n, 'x')] });
    await until(() => set.mock.calls.length === 1);
    expect(set).toHaveBeenCalledWith('chat/lobby', { epoch: EPOCH, seq: 4n });
  });

  it('supports for-await iteration', async () => {
    const { c, conn } = await connected();
    const sub = c.topic('chat/lobby').subscribe<string>();
    const s = await conn.next('subscribe');
    conn.reply(s.corr, { type: 'subAck', topicId: 7n, delivery: DeliveryClass.Durable, catchingUp: false, snapshotFollows: false, deliveries: [] });
    conn.reply(0n, {
      type: 'deliver',
      topicId: 7n,
      delivery: DeliveryClass.Durable,
      replayed: false,
      events: [event(7n, EPOCH, 1n, 'a'), event(7n, EPOCH, 2n, 'b')],
    });
    const out: string[] = [];
    for await (const m of sub) {
      out.push(m.data);
      if (out.length === 2) await sub.unsubscribe();
    }
    expect(out).toEqual(['a', 'b']);
  });
});

describe('http long-poll', () => {
  it('probes a new topic, then long-polls after the last cursor, and publishes by POST', async () => {
    let published = 0;
    let polls = 0;
    const http = new FakeRequestTransport(async (path, _token, frames, signal) => {
      const f = frames[0]!;
      if (path === '/v1/publish') {
        return {
          frames: frames.map((fr) =>
            fr.msg.type === 'ping'
              ? { corr: fr.corr, msg: { type: 'pong', nonce: 1n, tsMs: Date.now() } as const }
              : { corr: fr.corr, msg: { type: 'pubAck', topicId: 7n, level: AckMode.Accepted, cursor: { epoch: EPOCH, seq: BigInt(++published) }, duplicate: false, serverTsMs: 1 } as const },
          ),
        };
      }
      if (f.msg.type !== 'poll') throw new Error('expected poll');
      polls++;
      const t = f.msg.poll.topics[0]!;
      if (f.msg.poll.waitMs === 0) {
        // The probe.
        expect(t).toMatchObject({ topic: { name: 'chat/lobby' }, start: StartAt.Oldest });
        return {
          frames: [
            { corr: f.corr, msg: { type: 'subAck', topicId: 7n, delivery: DeliveryClass.Durable, catchingUp: false, latest: { epoch: EPOCH, seq: 1n }, snapshotFollows: false, deliveries: [] } },
            { corr: f.corr, msg: { type: 'deliver', topicId: 7n, delivery: DeliveryClass.Durable, replayed: true, events: [event(7n, EPOCH, 1n, 'first')] } },
            { corr: f.corr, msg: { type: 'pollEnd', timedOut: false, more: false } },
          ],
        };
      }
      if (polls === 2) {
        expect(t).toMatchObject({ start: StartAt.After, cursor: { epoch: EPOCH, seq: 1n } });
        return {
          frames: [
            { corr: f.corr, msg: { type: 'subAck', topicId: 7n, delivery: DeliveryClass.Durable, catchingUp: false, latest: { epoch: EPOCH, seq: 2n }, snapshotFollows: false, deliveries: [] } },
            { corr: f.corr, msg: { type: 'deliver', topicId: 7n, delivery: DeliveryClass.Durable, replayed: true, events: [event(7n, EPOCH, 2n, 'second')] } },
            { corr: f.corr, msg: { type: 'pollEnd', timedOut: false, more: false } },
          ],
        };
      }
      expect(t).toMatchObject({ start: StartAt.After, cursor: { epoch: EPOCH, seq: 2n } });
      await new Promise<void>((r) => signal?.addEventListener('abort', () => r()));
      return { frames: [] };
    });
    const c = createClient({
      endpoints: { http: 'http://fake' },
      transports: ['http'],
      token: mintToken('alice'),
      connectTimeoutMs: 0,
      transportOverrides: { request: http },
    });
    clients.push(c);
    await c.connect();
    expect(c.identity).toBe('alice');
    const got: Message<string>[] = [];
    const sub = c.subscribe<string>('chat/lobby', (m) => {
      got.push(m);
    }, { from: 'oldest' });
    await sub.ready;
    await until(() => got.length === 2);
    expect(got.map((m) => [m.data, m.replayed])).toEqual([
      ['first', true],
      ['second', false],
    ]);
    const r = await c.publish('chat/lobby', 'hello');
    expect(r.id).toBe(`${EPOCH}:1`);
    const call = http.calls.find((x) => x.frames[0]!.msg.type === 'publish')!;
    expect(call.token).toBe(c['engine'].tokens['token']);
  });

  it('refreshes the token once on a 401 AuthExpired', async () => {
    const tokens = [mintToken('alice'), mintToken('alice', { ttlSecs: 900 })];
    let i = 0;
    const http = new FakeRequestTransport((_path, token, frames) => {
      if (token === tokens[0]) {
        return { status: 401, frames: [{ corr: 0n, msg: { type: 'close', code: Code.AuthExpired, reason: 'expired', retryAfterMs: 0 } }] };
      }
      return { frames: frames.map((f) => ({ corr: f.corr, msg: { type: 'pong', nonce: 1n, tsMs: Date.now() } as const })) };
    });
    const c = createClient({
      endpoints: { http: 'http://fake' },
      transports: ['http'],
      token: () => tokens[i++]!,
      connectTimeoutMs: 0,
      transportOverrides: { request: http },
    });
    clients.push(c);
    await c.connect();
    expect(http.calls.map((x) => x.token)).toEqual(tokens);
  });
});
