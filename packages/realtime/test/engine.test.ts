import { afterEach, describe, expect, it, vi } from 'vitest';

import { Code, Folkways, type Message, Realtime, RealtimeError, type RealtimeOptions } from '../src';
import { AckMode, ContentType, DeliveryClass, GapReason, OnGap, StartAt } from '../src/transport/wire/model';
import { FakeRequestTransport, FakeStreamTransport, until } from './support/fake-transport';
import { event } from './support/server-codec';
import { mintToken } from './support/token';

const EPOCH = 1879046969544933376n;
const clients: Realtime[] = [];

/** A client that starts connecting at once, like an app calling connect() without awaiting it. */
function client(fake: FakeStreamTransport, opts: Partial<RealtimeOptions> = {}): Realtime {
  const c = new Realtime({
    endpoints: { websocket: 'ws://fake/v1/ws' },
    transports: ['websocket'],
    token: mintToken('alice'),
    reconnect: { initialDelayMs: 1, maxDelayMs: 5 },
    connectTimeoutMs: 0,
    transportOverrides: { stream: fake },
    ...opts,
  });
  c.connect().catch(() => {});
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
    expect(c.connection.state).toBe('connected');
    expect(c.connection.transport).toBe('websocket');
    expect(c.session?.identity).toBe('alice');
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
    await until(() => c.connection.state === 'failed');
    expect(c.connection.error?.code).toBe(Code.Replaced);
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
    expect(c.connection.state).toBe('failed');
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
    expect(reasons).toEqual(['initial', 'rejected']);
    expect(fake.conns).toHaveLength(2);
  });

  it('reconnects after a drop and honours Draining', async () => {
    const fake = new FakeStreamTransport();
    const c = client(fake);
    const states: string[] = [];
    c.connection.on('change', ({ current }) => states.push(current));
    await (await fake.nextConn()).welcome();
    await c.connect();
    fake.conns[0]!.drop();
    await (await fake.nextConn()).welcome();
    await until(() => c.connection.state === 'connected' && fake.conns.length === 2);
    fake.conns[1]!.serverClose(Code.Draining, 'node draining', 20);
    const t0 = Date.now();
    await (await fake.nextConn()).welcome();
    await until(() => c.connection.state === 'connected' && fake.conns.length === 3);
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
    expect(c.connection.transport).toBe('http');
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
    const refreshed = new Promise((r) => c.sessionView.subscribe(() => r(undefined)));
    conn.reply(0n, { type: 'tokenExpiring', expiresAtMs: Date.now() + 60_000 });
    const reauth = await conn.next('reauth');
    conn.reply(reauth.corr, { type: 'opOk' });
    await refreshed;
    expect(reasons).toEqual(['initial', 'expiring']);
  });

  it('ends with AuthExpired when a static token expires', async () => {
    const fake = new FakeStreamTransport();
    const c = client(fake);
    const conn = await fake.nextConn();
    await conn.welcome();
    await c.connect();
    const failed = new Promise<RealtimeError>((r) => c.connection.on('change', ({ current, reason }) => current === 'failed' && r(reason!)));
    conn.serverClose(Code.AuthExpired, 'token expired');
    expect((await failed).code).toBe(Code.AuthExpired);
    expect(c.connection.state).toBe('failed');
  });
});

describe('session', () => {
  it('resolves connect() with the session from Welcome: identity, segment, permissions, limits', async () => {
    const fake = new FakeStreamTransport();
    const c = new Realtime({
      endpoints: { websocket: 'ws://fake/v1/ws' },
      transports: ['websocket'],
      token: mintToken('user:42'),
      connectTimeoutMs: 0,
      transportOverrides: { stream: fake },
    });
    clients.push(c);
    const connecting = c.connect();
    await (await fake.nextConn()).welcome({
      identity: 'user:42',
      segmentId: 'seg_8f2c',
      environment: 'production',
      capabilities: [
        { topic: 'chat/*', ops: ['publish', 'subscribe', 'set', 'signal'] },
        { topic: 'notes/>', ops: ['subscribe', 'not-an-op'] },
      ],
      limits: { maxSubscriptions: 50 },
      features: ['user-topics'],
    });
    const session = await connecting;
    expect(session).toBe(c.session);
    expect(session).toMatchObject({
      identity: 'user:42',
      anonymous: false,
      id: '00000000000000010000000000000002',
      segment: { id: 'seg_8f2c', environment: 'production' },
      transport: 'websocket',
      features: ['user-topics'],
      permissions: [
        { topics: 'chat/*', ops: ['publish', 'subscribe', 'set', 'signal'] },
        { topics: 'notes/>', ops: ['subscribe'] },
      ],
    });
    expect(session.limits.maxSubscriptions).toBe(50);
    expect(session.can('publish', 'chat/45')).toBe(true);
    expect(session.can('publish', 'chat/45/typing')).toBe(false);
    expect(session.can('subscribe', 'notes/a/b')).toBe(true);
    expect(session.can('subscribe', 'notes')).toBe(false);
    expect(session.can('presence', 'chat/45')).toBe(false);
    expect(Object.isFrozen(session)).toBe(true);
  });

  it('falls back to the token claims when the node does not send segment and permissions', async () => {
    const fake = new FakeStreamTransport();
    const c = client(fake, { token: mintToken('alice', { seg: 'seg-from-token', cap: [{ topic: 'rooms/*', ops: ['subscribe'] }] }) });
    await (await fake.nextConn()).welcome();
    const session = await c.connect();
    expect(session.segment).toEqual({ id: 'seg-from-token', environment: null });
    expect(session.permissions).toEqual([{ topics: 'rooms/*', ops: ['subscribe'] }]);
  });

  it('checks connect({ segment }) locally and never sends a mismatching token', async () => {
    const fake = new FakeStreamTransport();
    const c = new Realtime({
      endpoints: { websocket: 'ws://fake/v1/ws' },
      transports: ['websocket'],
      token: mintToken('alice', { seg: 'staging' }),
      transportOverrides: { stream: fake },
    });
    clients.push(c);
    await expect(c.connect({ segment: 'production' })).rejects.toMatchObject({ code: Code.SegmentMismatch, local: true });
    expect(fake.attempts).toBe(0);
  });

  it('Folkways.connect() resolves with a connected client and closes it on failure', async () => {
    const fake = new FakeStreamTransport();
    const base = { endpoints: { websocket: 'ws://fake/v1/ws' }, transports: ['websocket' as const], transportOverrides: { stream: fake } };
    const ok = Folkways.connect({ ...base, token: mintToken('alice') });
    await (await fake.nextConn()).welcome();
    const c = await ok;
    clients.push(c);
    expect(c.connection.state).toBe('connected');
    expect(c.session?.identity).toBe('alice');

    const bad = Folkways.connect({ ...base, token: mintToken('alice') });
    const conn = await fake.nextConn();
    await conn.next('hello');
    conn.serverClose(Code.Suspended, 'segment suspended');
    await expect(bad).rejects.toMatchObject({ code: Code.Suspended });
  });

  it('reports state changes with their cause on client.connection', async () => {
    const fake = new FakeStreamTransport();
    const c = client(fake);
    const changes: string[] = [];
    let snapshots = 0;
    c.connection.subscribe(() => snapshots++);
    c.connection.on('change', ({ previous, current, reason }) => changes.push(`${previous}>${current}${reason ? `:${reason.codeName}` : ''}`));
    const conn = await fake.nextConn();
    await conn.welcome();
    await c.connection.whenConnected();
    conn.serverClose(Code.AuthInvalid);
    await until(() => c.connection.state === 'failed');
    expect(changes).toEqual(['connecting>connected', 'connected>failed:AuthInvalid']);
    expect(c.connection.getSnapshot()).toMatchObject({ state: 'failed', error: { code: Code.AuthInvalid } });
    expect(snapshots).toBeGreaterThanOrEqual(2);
  });
});

describe('updateToken', () => {
  async function connected(fake: FakeStreamTransport, identity = 'alice', opts: Partial<RealtimeOptions> = {}) {
    const c = client(fake, { token: mintToken(identity), ...opts });
    const conn = await fake.nextConn();
    await conn.welcome({ identity });
    await c.connect();
    return { c, conn };
  }

  it('sends Reauth for the same identity and keeps the connection and subscriptions', async () => {
    const fake = new FakeStreamTransport();
    const { c, conn } = await connected(fake);
    const sub = c.topic('chat/a').subscribe();
    const s = await conn.next('subscribe');
    conn.reply(s.corr, { type: 'subAck', topicId: 7n, delivery: DeliveryClass.Durable, catchingUp: false, snapshotFollows: false, deliveries: [] });
    await sub.ready;
    const fresh = mintToken('alice', { ttlSecs: 900 });
    const done = c.updateToken(fresh);
    const reauth = await conn.next('reauth');
    expect(reauth.msg.token).toBe(fresh);
    conn.reply(reauth.corr, { type: 'opOk' });
    await done;
    expect(fake.conns).toHaveLength(1);
    expect(sub.status).toBe('active');
  });

  it('rejects when the node refuses the Reauth', async () => {
    const fake = new FakeStreamTransport();
    const { c, conn } = await connected(fake);
    const done = c.updateToken(mintToken('alice'));
    const reauth = await conn.next('reauth');
    conn.reply(reauth.corr, { type: 'opError', code: Code.AuthInvalid, message: 'bad token', retryAfterMs: 0, topicId: 0n });
    await expect(done).rejects.toMatchObject({ code: Code.AuthInvalid });
  });

  it('reconnects for another identity and ends every subscription with IdentityChanged', async () => {
    const fake = new FakeStreamTransport();
    const { c, conn } = await connected(fake);
    const sub = c.topic('chat/a').subscribe();
    const ended = new Promise<RealtimeError>((r) => sub.on('ended', r));
    await conn.next('subscribe');
    await c.updateToken(mintToken('bob'));
    expect((await ended).code).toBe(Code.IdentityChanged);
    const conn2 = await fake.nextConn();
    const hello = await conn2.welcome({ identity: 'bob' });
    expect(hello.msg).toMatchObject({ hello: { token: expect.any(String) } });
    await until(() => c.session?.identity === 'bob');
    expect(conn.closed).toBe(true);
  });

  it('refuses a token for another segment and keeps the current one', async () => {
    const fake = new FakeStreamTransport();
    const { c } = await connected(fake);
    await expect(c.updateToken(mintToken('alice', { seg: 'another-segment' }))).rejects.toMatchObject({
      code: Code.SegmentMismatch,
      local: true,
    });
    expect(fake.conns).toHaveLength(1);
  });

  it('connects with a token from authUrl', async () => {
    const fake = new FakeStreamTransport();
    const token = mintToken('alice');
    const seen: string[] = [];
    const fetchFn = async (url: string) => {
      seen.push(url);
      return {
        status: 200,
        headers: { get: () => 'application/json' },
        arrayBuffer: async () => new TextEncoder().encode(JSON.stringify({ token })).buffer as ArrayBuffer,
      };
    };
    client(fake, { token: undefined, authUrl: 'https://app.example/api/rte-token', fetch: fetchFn });
    const hello = await (await fake.nextConn()).welcome();
    expect(hello.msg).toMatchObject({ hello: { token } });
    expect(seen).toEqual(['https://app.example/api/rte-token']);
  });
});

describe('connection states', () => {
  it('goes offline after offlineAfterMs of failed reconnecting, fails queued publishes, and recovers', async () => {
    const fake = new FakeStreamTransport();
    const c = client(fake, { offlineAfterMs: 50, reconnect: { initialDelayMs: 5, maxDelayMs: 20 } });
    const states: string[] = [];
    c.connection.on('change', ({ current }) => states.push(current));
    await (await fake.nextConn()).welcome();
    await c.connect();
    fake.refuse = 1_000;
    fake.conns[0]!.drop();
    const queued = c.topic('chat/a').publish('message', 'queued while reconnecting').catch((e: RealtimeError) => e);
    await until(() => c.connection.state === 'offline', 2_000, 'offline');
    expect(await queued).toMatchObject({ code: Code.NotConnected });
    await expect(c.topic('chat/a').publish('message', 'while offline')).rejects.toMatchObject({ code: Code.NotConnected });
    fake.refuse = 0;
    await (await fake.nextConn(2_000)).welcome();
    await until(() => c.connection.state === 'connected', 2_000, 'connected');
    expect(states).toEqual(['connected', 'reconnecting', 'offline', 'connected']);
  });

  it('keeps subscriptions through failed and resumes them after connect() is called again', async () => {
    const fake = new FakeStreamTransport();
    const c = client(fake);
    const conn = await fake.nextConn();
    await conn.welcome();
    await c.connect();
    const sub = c.topic('chat/a').subscribe();
    const s = await conn.next('subscribe');
    conn.reply(s.corr, { type: 'subAck', topicId: 7n, delivery: DeliveryClass.Durable, catchingUp: false, snapshotFollows: false, deliveries: [] });
    await sub.ready;
    conn.push({ corr: 0n, msg: { type: 'deliver', topicId: 7n, delivery: DeliveryClass.Durable, replayed: false, events: [event(7n, EPOCH, 3n, 'x')] } });
    await until(() => sub.cursor?.seq === 3n);
    conn.serverClose(Code.AuthInvalid);
    await until(() => c.connection.state === 'failed');
    expect(sub.status).toBe('resyncing');
    await expect(c.topic('chat/a').publish('message', 'nope')).rejects.toMatchObject({ code: Code.AuthInvalid });

    const reconnected = c.connect();
    const conn2 = await fake.nextConn();
    await conn2.welcome();
    await reconnected;
    const s2 = await conn2.next('subscribe');
    expect(s2.msg.subscribe).toMatchObject({ start: StartAt.After, cursor: { epoch: EPOCH, seq: 3n } });
  });

  it('skips the remaining backoff when the tab becomes visible', async () => {
    const listeners: Record<string, () => void> = {};
    const doc = {
      visibilityState: 'hidden',
      addEventListener: (t: string, f: () => void) => (listeners[t] = f),
      removeEventListener: (t: string) => delete listeners[t],
    };
    vi.stubGlobal('document', doc);
    try {
      const fake = new FakeStreamTransport();
      const c = client(fake, { reconnect: { initialDelayMs: 60_000, maxDelayMs: 60_000 } });
      await (await fake.nextConn()).welcome();
      await c.connect();
      fake.conns[0]!.drop();
      await until(() => c.connection.state === 'reconnecting');
      await new Promise((r) => setTimeout(r, 20));
      expect(fake.attempts).toBe(1);
      doc.visibilityState = 'visible';
      listeners.visibilitychange!();
      await (await fake.nextConn(1_000)).welcome();
      await until(() => c.connection.state === 'connected');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('moves back to WebSocket once a probe opens while on the HTTP fallback', async () => {
    const fake = new FakeStreamTransport();
    fake.refuse = 2;
    const http = new FakeRequestTransport(async (path, _token, frames, signal) => {
      if (path === '/v1/poll') await new Promise((r) => signal?.addEventListener('abort', r, { once: true }));
      return { frames: frames.map((f) => ({ corr: f.corr, msg: { type: 'pong', nonce: 1n, tsMs: Date.now() } as const })) };
    });
    const c = client(fake, {
      endpoints: { websocket: 'ws://fake/v1/ws', http: 'http://fake' },
      transports: ['websocket', 'http'],
      transportOverrides: { stream: fake, request: http },
      webSocketRetryMs: 30,
    });
    await c.connect();
    expect(c.connection.transport).toBe('http');
    // The probe opens a socket and closes it; then the real WebSocket session follows.
    await until(() => fake.conns.length === 2, 2_000, 'websocket session');
    await fake.conns[1]!.welcome();
    await until(() => c.connection.transport === 'websocket', 2_000, 'websocket transport');
    expect(fake.conns[0]!.closed).toBe(true);
  });
});

describe('publish', () => {
  it('sends an Accepted publish with a fresh idempotency key and resolves with the receipt', async () => {
    const fake = new FakeStreamTransport();
    const c = client(fake);
    const conn = await fake.nextConn();
    await conn.welcome();
    await c.connect();
    const p = c.topic('chat/lobby').publish('message', { text: 'hi' }, { headers: { trace: 't1' } });
    const f = await conn.next('publish');
    expect(f.msg.publish).toMatchObject({
      topic: { name: 'chat/lobby' },
      name: 'message',
      delivery: DeliveryClass.Durable,
      contentType: ContentType.Json,
      ack: AckMode.Accepted,
      headers: [['trace', 't1']],
    });
    expect(JSON.parse(new TextDecoder().decode(f.msg.publish.payload))).toEqual({ text: 'hi' });
    expect(f.msg.publish.idempotencyKey).toBeDefined();
    conn.reply(f.corr, {
      type: 'pubAck',
      topicId: 1n,
      level: AckMode.Accepted,
      cursor: { epoch: EPOCH, seq: 1n },
      duplicate: false,
      serverTsMs: 5,
      uid: { hi: 0n, lo: 255n },
    });
    await expect(p).resolves.toEqual({
      topic: 'chat/lobby',
      delivery: 'stream',
      uid: '000000000000000000000000000000ff',
      cursor: { epoch: EPOCH, seq: 1n },
      id: `${EPOCH}:1`,
      level: 'accepted',
      duplicate: false,
      serverTime: 5,
    });
  });

  it('queues while offline and sends after Welcome', async () => {
    const fake = new FakeStreamTransport();
    const c = client(fake);
    const p = c.topic('chat/lobby').publish('message', 'early');
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
    const p = c.topic('chat/lobby').publish('message', 'once');
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
    const p = c.topic('chat/lobby').publish('message', 'x');
    const a = await conn.next('publish');
    conn.reply(a.corr, { type: 'opError', code: Code.RateLimited, message: 'slow', retryAfterMs: 20, topicId: 0n });
    const b = await conn.next('publish');
    expect(b.msg.publish.idempotencyKey).toEqual(a.msg.publish.idempotencyKey);
    conn.reply(b.corr, { type: 'pubAck', topicId: 1n, level: AckMode.Accepted, cursor: { epoch: 1n, seq: 1n }, duplicate: false, serverTsMs: 1 });
    await expect(p).resolves.toBeDefined();

    const q = c.topic('other/x').publish('message', 'nope');
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
    await expect(c.topic('chat/lobby').publish('message', 'too long')).rejects.toMatchObject({ code: Code.PayloadTooLarge, local: true });
    expect(() => c.topic('bad topic')).toThrow(RealtimeError);
    await expect(c.topic('chat/lobby').publish('message', 'x', { idempotencyKey: 'nope' })).rejects.toMatchObject({ code: Code.InvalidArgument });
    expect(conn.sent('publish')).toHaveLength(0);
  });

  it('sends signals fire-and-forget with NoAck, and drops them while not connected', async () => {
    const fake = new FakeStreamTransport();
    const c = client(fake);
    await expect(c.topic('chat/1').publish('typing', { on: true }, { delivery: 'signal' })).resolves.toBeUndefined();
    const conn = await fake.nextConn();
    await conn.welcome();
    await c.connect();
    await c.topic('chat/1').publish('typing', { on: true }, { delivery: 'signal' });
    const f = await conn.next('publish');
    expect(f.msg.publish).toMatchObject({ name: 'typing', delivery: DeliveryClass.Ephemeral, ack: AckMode.NoAck });
    expect(f.msg.publish.idempotencyKey).toBeUndefined();
    expect(conn.sent('publish')).toHaveLength(1);
  });

  it('keys kv events by your identity unless given a key, and deletes with remove', async () => {
    const fake = new FakeStreamTransport();
    const c = client(fake, { token: mintToken('user:7') });
    const conn = await fake.nextConn();
    await conn.welcome({ identity: 'user:7' });
    await c.connect();
    const room = c.topic('chat/45');
    room.publish('read', { upTo: 'abc' }, { delivery: 'kv', ttlMs: 60_000 }).catch(() => {});
    room.publish('title', 'Lunch', { delivery: 'kv', key: 'room' }).catch(() => {});
    room.publish('read', null, { delivery: 'kv', remove: true }).catch(() => {});
    const [a, b, d] = [await conn.next('publish'), await conn.next('publish'), await conn.next('publish')];
    expect(a.msg.publish).toMatchObject({ name: 'read', delivery: DeliveryClass.LastValue, key: 'user:7', ttlMs: 60_000 });
    expect(b.msg.publish).toMatchObject({ name: 'title', key: 'room' });
    expect(d.msg.publish).toMatchObject({ name: 'read', key: 'user:7', tombstone: true });
    expect(d.msg.publish.payload).toHaveLength(0);
    await expect(room.publish('message', 'x', { key: 'k' })).rejects.toMatchObject({ code: Code.InvalidArgument });
    await expect(room.publish('message', 'x', { remove: true })).rejects.toMatchObject({ code: Code.InvalidArgument });
    await expect(room.publish('', 'x')).rejects.toMatchObject({ code: Code.InvalidArgument });
  });

  it('rejects pending publishes on close', async () => {
    const fake = new FakeStreamTransport();
    const c = client(fake);
    const p = c.topic('chat/lobby').publish('message', 'x');
    const rejected = expect(p).rejects.toMatchObject({ code: Code.ClientClosed });
    const t0 = Date.now();
    await c.close();
    await rejected;
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe('subscribe', () => {
  async function connected(opts: Partial<RealtimeOptions> = {}) {
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
    const sub = c.topic<{ '': string }>('chat/lobby').subscribe(async (m) => {
      await new Promise((r) => setTimeout(r, m.data === 'one' ? 20 : 0));
      seen.push(m.data);
    });
    const s = await conn.next('subscribe');
    expect(s.msg.subscribe).toMatchObject({ topic: { name: 'chat/lobby' }, start: StartAt.Latest, onGap: OnGap.FromOldest });
    conn.reply(s.corr, { type: 'subAck', topicId: 7n, delivery: DeliveryClass.Durable, catchingUp: false, snapshotFollows: false, deliveries: [] });
    await sub.ready;
    expect(sub.deliveries).toEqual(['stream']);
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
    const sub = c.topic('chat/lobby').subscribe((m) => {
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
    expect(gaps).toEqual([{ topic: 'chat/lobby', reason: 'epoch-lost', requested: { epoch: 1n, seq: 3n }, oldest: { epoch: EPOCH, seq: 1n }, latest: { epoch: EPOCH, seq: 4n }, resumed: true }]);
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
    expect([...c.topic('rides/42/location').values().keys()]).toEqual(['d1', 'd2']);
    conn.reply(0n, {
      type: 'deliver',
      topicId: 3n,
      delivery: DeliveryClass.LastValue,
      replayed: false,
      events: [event(3n, EPOCH, 3n, '', { key: 'd1', tombstone: true })],
    });
    await until(() => c.topic('rides/42/location').values().size === 1);
    expect([...c.topic('rides/42/location').values().keys()]).toEqual(['d2']);

    // A second handle on the same topic shares the wire subscription and gets the current state.
    const late: Message[][] = [];
    const sub2 = c.topic('rides/42/location').subscribe();
    sub2.on('snapshot', (ms) => late.push(ms));
    await sub2.ready;
    await until(() => late.length === 1);
    expect(late[0]!.map((m) => m.key)).toEqual(['d2']);
    expect(conn.sent('subscribe')).toHaveLength(1);
  });

  it('receives named events of several types in one topic, filtered by types and events', async () => {
    const { c, conn } = await connected();
    const room: Message[] = [];
    const inbox: Message[] = [];
    const reads: Message[] = [];
    c.topic('chat/45').subscribe((m) => void room.push(m));
    c.topic('chat/45').subscribe((m) => void inbox.push(m), { types: ['stream'] });
    c.topic('chat/45').subscribe((m) => void reads.push(m), { events: ['read'] });
    const s = await conn.next('subscribe');
    expect(s.msg.subscribe.types).toEqual([]); // the first handle wants every type
    conn.reply(s.corr, {
      type: 'subAck',
      topicId: 9n,
      delivery: DeliveryClass.Unspecified,
      catchingUp: false,
      snapshotFollows: false,
      deliveries: [DeliveryClass.Durable, DeliveryClass.LastValue, DeliveryClass.Ephemeral],
    });
    conn.reply(0n, {
      type: 'deliver',
      topicId: 9n,
      delivery: DeliveryClass.Unspecified,
      replayed: false,
      events: [
        event(9n, EPOCH, 1n, '{"text":"hi"}', { delivery: DeliveryClass.Durable, name: 'message', contentType: ContentType.Json, uid: { hi: 0n, lo: 1n } }),
        event(9n, 0n, 0n, '{"on":true}', { delivery: DeliveryClass.Ephemeral, name: 'typing', contentType: ContentType.Json }),
        event(9n, 0n, 0n, '{"upTo":"x"}', { delivery: DeliveryClass.LastValue, name: 'read', key: 'bob', contentType: ContentType.Json }),
      ],
    });
    await until(() => room.length === 3 && reads.length === 1);
    expect(room.map((m) => [m.name, m.delivery])).toEqual([
      ['message', 'stream'],
      ['typing', 'signal'],
      ['read', 'kv'],
    ]);
    expect(room[0]).toMatchObject({ uid: '00000000000000000000000000000001', cursor: { epoch: EPOCH, seq: 1n }, data: { text: 'hi' }, pending: false, fromCache: false });
    expect(room[1]).toMatchObject({ cursor: undefined, key: 'bob', publisher: 'bob' });
    expect(inbox.map((m) => m.name)).toEqual(['message']);
    expect(reads.map((m) => m.data)).toEqual([{ upTo: 'x' }]);
  });

  it('subscribes again with wider types when a handle needs types the wire filters out', async () => {
    const { c, conn } = await connected();
    const inbox = c.topic('chat/45').subscribe({ types: ['stream'] });
    const s = await conn.next('subscribe');
    expect(s.msg.subscribe.types).toEqual([DeliveryClass.Durable]);
    conn.reply(s.corr, { type: 'subAck', topicId: 9n, delivery: DeliveryClass.Durable, catchingUp: false, snapshotFollows: false, deliveries: [] });
    await inbox.ready;
    c.topic('chat/45').subscribe();
    const u = await conn.next('unsubscribe');
    expect(u.msg.topic).toEqual({ id: 9n });
    const s2 = await conn.next('subscribe');
    expect(s2.msg.subscribe.types).toEqual([]);
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
    const sub = c.topic<{ '': string }>('chat/lobby').subscribe();
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

describe('topic views', () => {
  async function connected(opts: Partial<RealtimeOptions> = {}) {
    const fake = new FakeStreamTransport();
    const c = client(fake, { token: mintToken('alice'), ...opts });
    const conn = await fake.nextConn();
    await conn.welcome({ identity: 'alice' });
    await c.connect();
    return { c, conn };
  }
  const ack = (seq: bigint, uid?: bigint) =>
    ({ type: 'pubAck', topicId: 9n, level: AckMode.Accepted, cursor: { epoch: EPOCH, seq }, duplicate: false, serverTsMs: 7, uid: uid ? { hi: 0n, lo: uid } : undefined }) as const;

  it('shows a send as pending, then sent, and replaces it with the delivered copy in place', async () => {
    const { c, conn } = await connected();
    const room = c.topic<{ message: { text: string } }>('chat/45');
    room.subscribe();
    const s = await conn.next('subscribe');
    conn.reply(s.corr, { type: 'subAck', topicId: 9n, delivery: DeliveryClass.Durable, catchingUp: false, snapshotFollows: false, deliveries: [] });
    let notified = 0;
    room.messages.subscribe(() => notified++);
    const p = room.publish('message', { text: 'hi' });
    expect(room.messages.getSnapshot()).toMatchObject([{ status: 'pending', pending: true, data: { text: 'hi' }, publisher: 'alice', name: 'message' }]);
    const f = await conn.next('publish');
    conn.reply(f.corr, ack(1n, 5n));
    await p;
    expect(room.messages.getSnapshot()).toMatchObject([{ status: 'sent', pending: false, id: `${EPOCH}:1`, uid: '00000000000000000000000000000005' }]);
    conn.reply(0n, {
      type: 'deliver',
      topicId: 9n,
      delivery: DeliveryClass.Durable,
      replayed: false,
      events: [
        event(9n, EPOCH, 1n, '{"text":"hi"}', { publisher: 'alice', name: 'message', contentType: ContentType.Json, uid: { hi: 0n, lo: 5n } }),
        event(9n, EPOCH, 2n, '{"text":"yo"}', { publisher: 'bob', name: 'message', contentType: ContentType.Json }),
      ],
    });
    await until(() => room.messages.getSnapshot().length === 2);
    expect(room.messages.getSnapshot().map((m) => [m.id, m.status, m.publisher])).toEqual([
      [`${EPOCH}:1`, 'sent', 'alice'],
      [`${EPOCH}:2`, 'sent', 'bob'],
    ]);
    expect(notified).toBeGreaterThanOrEqual(3);
    expect(Object.isFrozen(room.messages.getSnapshot())).toBe(true);
  });

  it('marks a failed send and retries it with the same idempotency key', async () => {
    const { c, conn } = await connected();
    const room = c.topic('chat/45');
    const p = room.publish('message', 'x').catch((e: RealtimeError) => e);
    const f = await conn.next('publish');
    conn.reply(f.corr, { type: 'opError', code: Code.Forbidden, message: 'no', retryAfterMs: 0, topicId: 0n });
    expect(await p).toMatchObject({ code: Code.Forbidden });
    const failed = room.messages.getSnapshot()[0]!;
    expect(failed).toMatchObject({ status: 'failed', error: { code: Code.Forbidden } });
    const again = failed.retry!();
    expect(room.messages.getSnapshot()[0]!.status).toBe('pending');
    const f2 = await conn.next('publish');
    expect(f2.msg.publish.idempotencyKey).toEqual(f.msg.publish.idempotencyKey);
    conn.reply(f2.corr, ack(3n));
    await again;
    expect(room.messages.getSnapshot()[0]!.status).toBe('sent');
  });

  it('keeps values per event name and expires signals after the TTL', async () => {
    const { c, conn } = await connected({ signalTtlMs: 60 });
    const room = c.topic('chat/45');
    room.subscribe();
    const s = await conn.next('subscribe');
    conn.reply(s.corr, {
      type: 'subAck',
      topicId: 9n,
      delivery: DeliveryClass.Unspecified,
      catchingUp: false,
      snapshotFollows: false,
      deliveries: [DeliveryClass.Durable, DeliveryClass.LastValue, DeliveryClass.Ephemeral],
    });
    const typing = room.values('typing');
    let typingChanges = 0;
    typing.subscribe(() => typingChanges++);
    conn.reply(0n, {
      type: 'deliver',
      topicId: 9n,
      delivery: DeliveryClass.Unspecified,
      replayed: false,
      events: [
        event(9n, 0n, 0n, 'a', { delivery: DeliveryClass.LastValue, name: 'read', key: 'bob' }),
        event(9n, 0n, 0n, 'b', { delivery: DeliveryClass.LastValue, name: 'location', key: 'bob' }),
        event(9n, 0n, 0n, 'c', { delivery: DeliveryClass.Ephemeral, name: 'typing', publisher: 'carol' }),
      ],
    });
    await until(() => typing.size === 1);
    expect(room.values('read').get('bob')?.data).toBe('a');
    expect(room.values('location').get('bob')?.data).toBe('b');
    expect([...typing.keys()]).toEqual(['carol']);
    expect([...room.values().keys()].sort()).toEqual(['location/bob', 'read/bob', 'typing/carol']);
    await until(() => typing.size === 0, 1_000, 'signal expiry');
    expect(typingChanges).toBeGreaterThanOrEqual(2);
  });
});

describe('topic sets', () => {
  async function connected(limits: Partial<import('../src').Session['limits']> = {}) {
    const fake = new FakeStreamTransport();
    const c = client(fake);
    const conn = await fake.nextConn();
    await conn.welcome({ limits });
    await c.connect();
    return { c, conn };
  }
  const subAck = (topicId: bigint) =>
    ({ type: 'subAck', topicId, delivery: DeliveryClass.Durable, catchingUp: false, snapshotFollows: false, deliveries: [] }) as const;

  it('subscribes 200 topics in 4 packets and settles ready once every topic answered', async () => {
    const { c, conn } = await connected();
    const names = Array.from({ length: 200 }, (_, i) => `chat/${i}`);
    const before = conn.packets;
    const sub = c.topic(names).subscribe({ types: ['stream'] });
    await until(() => conn.sent('subscribe').length === 200);
    expect(conn.packets - before).toBe(4);
    const frames = conn.sent('subscribe');
    expect(frames.every((f) => f.msg.type === 'subscribe' && f.msg.subscribe.types?.[0] === DeliveryClass.Durable)).toBe(true);
    frames.forEach((f, i) => (i === 7 ? conn.reply(f.corr, { type: 'opError', code: Code.Forbidden, message: 'no', retryAfterMs: 0, topicId: 0n }) : conn.reply(f.corr, subAck(BigInt(i + 1)))));
    const { ok, failed } = await sub.ready;
    expect(ok).toHaveLength(199);
    expect(failed).toEqual([{ topic: 'chat/7', error: expect.objectContaining({ code: Code.Forbidden }) }]);
  });

  it('rejects ready with strict: true when a topic fails', async () => {
    const { c, conn } = await connected();
    const sub = c.topic(['a/1', 'a/2']).subscribe({ strict: true });
    const [f1, f2] = [await conn.next('subscribe'), await conn.next('subscribe')];
    conn.reply(f1.corr, subAck(1n));
    conn.reply(f2.corr, { type: 'opError', code: Code.Forbidden, message: 'no', retryAfterMs: 0, topicId: 0n });
    await expect(sub.ready).rejects.toMatchObject({ code: Code.Forbidden, topic: 'a/2' });
  });

  it('applies add and remove to the live subscription and delivers every topic to one handler', async () => {
    const { c, conn } = await connected();
    const got: string[] = [];
    const inbox = c.topic(['chat/a']);
    const sub = inbox.subscribe((m) => void got.push(`${m.topic}:${m.data}`));
    conn.reply((await conn.next('subscribe')).corr, subAck(1n));
    await sub.ready;
    inbox.add('chat/b');
    const sb = await conn.next('subscribe');
    expect(sb.msg.subscribe.topic).toEqual({ name: 'chat/b' });
    conn.reply(sb.corr, subAck(2n));
    conn.reply(0n, { type: 'deliver', topicId: 1n, delivery: DeliveryClass.Durable, replayed: false, events: [event(1n, EPOCH, 1n, 'x')] });
    conn.reply(0n, { type: 'deliver', topicId: 2n, delivery: DeliveryClass.Durable, replayed: false, events: [event(2n, EPOCH, 1n, 'y')] });
    await until(() => got.length === 2);
    expect(got.sort()).toEqual(['chat/a:x', 'chat/b:y']);
    inbox.remove('chat/a');
    const u = await conn.next('unsubscribe');
    expect(u.msg.topic).toEqual({ id: 1n });
    expect(sub.topics).toEqual(['chat/b']);
    expect(inbox.get('chat/b')).toBe(c.topic('chat/b'));
  });

  it('fails topics beyond limits.maxSubscriptions locally, before sending', async () => {
    const { c, conn } = await connected({ maxSubscriptions: 2 });
    const sub = c.topic(['x/1', 'x/2', 'x/3']).subscribe();
    const frames = [await conn.next('subscribe'), await conn.next('subscribe')];
    frames.forEach((f, i) => conn.reply(f.corr, subAck(BigInt(i + 1))));
    const { ok, failed } = await sub.ready;
    expect(ok).toEqual(['x/1', 'x/2']);
    expect(failed).toEqual([{ topic: 'x/3', error: expect.objectContaining({ code: Code.QuotaExceeded, local: true }) }]);
    expect(conn.sent('subscribe')).toHaveLength(2);
  });

  it('publishes to every topic and resolves with one receipt each', async () => {
    const { c, conn } = await connected();
    const p = c.topic(['n/1', 'n/2']).publish('notice', 'hi');
    const [a, b] = [await conn.next('publish'), await conn.next('publish')];
    expect([a.msg.publish.topic, b.msg.publish.topic]).toEqual([{ name: 'n/1' }, { name: 'n/2' }]);
    conn.reply(a.corr, { type: 'pubAck', topicId: 1n, level: AckMode.Accepted, cursor: { epoch: EPOCH, seq: 1n }, duplicate: false, serverTsMs: 1 });
    conn.reply(b.corr, { type: 'pubAck', topicId: 2n, level: AckMode.Accepted, cursor: { epoch: EPOCH, seq: 4n }, duplicate: false, serverTsMs: 1 });
    expect((await p).map((r) => [r.topic, r.id])).toEqual([
      ['n/1', `${EPOCH}:1`],
      ['n/2', `${EPOCH}:4`],
    ]);
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
    const c = new Realtime({
      endpoints: { http: 'http://fake' },
      transports: ['http'],
      token: mintToken('alice'),
      connectTimeoutMs: 0,
      transportOverrides: { request: http },
    });
    clients.push(c);
    await c.connect();
    expect(c.session?.identity).toBe('alice');
    const got: Message<string>[] = [];
    const sub = c.topic<{ '': string }>('chat/lobby').subscribe((m) => {
      got.push(m);
    }, { from: 'oldest' });
    await sub.ready;
    await until(() => got.length === 2);
    expect(got.map((m) => [m.data, m.replayed])).toEqual([
      ['first', true],
      ['second', false],
    ]);
    const r = await c.topic('chat/lobby').publish('message', 'hello');
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
    const c = new Realtime({
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
