import { describe, expect, it, vi } from 'vitest';

import { event } from '../../test/support/server-codec';
import { mintToken } from '../../test/support/token';
import { Code } from '../shared/codes';
import { RealtimeError, localError } from '../shared/errors';
import { silentLogger } from '../shared/logger';
import { AckMode, DeliveryClass, OnGap, StartAt } from '../transport';
import { Backoff } from './backoff';
import { localStorageCursorStore, memoryCursorStore } from './cursor-store';
import { packetize } from './packets';
import { type OutboundPublish, PublishQueue } from './publish-queue';
import { SubscriptionRegistry, type TopicListener } from './subscriptions';
import { TokenManager, authUrlProvider, peekJwt } from './token';

describe('Backoff', () => {
  it('grows exponentially with full jitter, capped, floored at retry_after', () => {
    const b = new Backoff({ initialDelayMs: 100, maxDelayMs: 1_000 }, () => 0.999);
    expect([b.next(), b.next(), b.next(), b.next(), b.next()]).toEqual([99, 199, 399, 799, 999]);
    expect(new Backoff({ initialDelayMs: 100, maxDelayMs: 1_000 }, () => 0).next(250)).toBe(250);
    b.reset();
    expect(b.next()).toBe(99);
  });
});

describe('TokenManager', () => {
  it('reads exp and sub from a JWT', () => {
    const t = mintToken('carol', { ttlSecs: 300, now: 1_700_000_000_000 });
    expect(peekJwt(t)).toMatchObject({ exp: 1_700_000_300_000, sub: 'carol' });
    expect(peekJwt('garbage')).toEqual({});
  });

  it('caches, refreshes near expiry, and shares one provider call', async () => {
    let now = 1_700_000_000_000;
    let n = 0;
    const provider = vi.fn(async (_ctx: { reason: string }) => mintToken(`u${++n}`, { ttlSecs: 120, now }));
    const tm = new TokenManager(provider, () => now);
    const a = await tm.get();
    expect(await tm.get()).toBe(a);
    now += 61_000; // within 60 s of exp
    const [b, c] = await Promise.all([tm.get(), tm.refresh('expiring')]);
    expect(b).toBe(c);
    expect(b).not.toBe(a);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(provider.mock.calls.map((c) => c[0].reason)).toEqual(['initial', 'expiring']);
    tm.invalidate();
    await tm.get();
    expect(provider.mock.calls[2]![0]).toEqual({ reason: 'rejected' });
  });

  it('reads seg, kind and cap without verifying', () => {
    const t = mintToken('dan', { seg: 'seg-1', cap: [{ topic: 'chat/*', ops: ['publish', 'subscribe'] }] });
    expect(peekJwt(t)).toMatchObject({ sub: 'dan', seg: 'seg-1', cap: [{ topic: 'chat/*', ops: ['publish', 'subscribe'] }] });
  });

  it('fetches tokens from authUrl as JSON or text, with extra headers', async () => {
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const reply = (status: number, type: string, body: string) => ({
      status,
      headers: { get: (n: string) => (n === 'content-type' ? type : null) },
      arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
    });
    let next = reply(200, 'application/json', JSON.stringify({ token: 'tok-json' }));
    const fetchFn = async (url: string, init: { headers: Record<string, string>; body: Uint8Array }) => {
      calls.push({ url, headers: init.headers, body: new TextDecoder().decode(init.body) });
      return next;
    };
    const p = authUrlProvider('/api/rte-token', { 'x-app': 'yes' }, fetchFn);
    expect(await p({ reason: 'initial' })).toBe('tok-json');
    expect(calls[0]).toMatchObject({ url: '/api/rte-token', headers: { 'x-app': 'yes' }, body: '{"reason":"initial"}' });
    next = reply(200, 'text/plain', ' tok-text\n');
    expect(await p({ reason: 'expiring' })).toBe('tok-text');
    next = reply(403, 'text/plain', 'no');
    await expect(p({ reason: 'rejected' })).rejects.toMatchObject({ code: Code.AuthRequired, local: true });
  });

  it('reports provider failures as AuthRequired', async () => {
    const tm = new TokenManager(() => {
      throw new Error('backend down');
    });
    await expect(tm.get()).rejects.toMatchObject({ code: Code.AuthRequired, local: true });
  });
});

describe('cursor stores', () => {
  it('persists "epoch:seq" in a Storage', async () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    };
    const s = localStorageCursorStore('app', storage);
    await s.set('chat/lobby', { epoch: 18446744073709551615n, seq: 3n });
    expect(data.get('app:chat/lobby')).toBe('18446744073709551615:3');
    expect(await s.get('chat/lobby')).toEqual({ epoch: 18446744073709551615n, seq: 3n });
    const m = memoryCursorStore();
    expect(await m.get('x')).toBeUndefined();
  });
});

describe('packetize', () => {
  const ping = (i: number) => ({ corr: BigInt(i), msg: { type: 'pong', nonce: 1n, tsMs: 0 } as const });

  it('respects the frame count and byte limits and isolates frames that never fit', () => {
    const frames = Array.from({ length: 130 }, (_, i) => ping(i + 1));
    const { packets } = packetize(frames, { maxFrameBytes: 65_536, maxFramesPerPacket: 64 });
    expect(packets.map((p) => p.frames.length)).toEqual([64, 64, 2]);
    const big = { corr: 999n, msg: { type: 'reauth', token: 'x'.repeat(500) } as const };
    const small = packetize([ping(1), big, ping(2)], { maxFrameBytes: 200, maxFramesPerPacket: 64 });
    expect(small.oversize).toEqual([big]);
    expect(small.packets.flatMap((p) => p.frames)).toEqual([ping(1), ping(2)]);
    expect(small.packets.every((p) => p.bytes.length <= 200)).toBe(true);
  });
});

describe('PublishQueue', () => {
  const body = { topic: { name: 't/x' }, payload: new Uint8Array(1), ack: AckMode.Accepted };

  function queue(opts: { online?: boolean; maxQueued?: number; timeoutMs?: number } = {}) {
    const sent: OutboundPublish[][] = [];
    let online = opts.online ?? true;
    const q = new PublishQueue(
      { canSend: () => online, send: (items) => sent.push(items), refusal: () => undefined },
      { maxQueued: opts.maxQueued ?? 10, timeoutMs: opts.timeoutMs ?? 1_000, retries: 2, logger: silentLogger },
    );
    return { q, sent, setOnline: (v: boolean) => (online = v) };
  }

  it('batches submits of one tick into one send', async () => {
    const { q, sent } = queue();
    void q.submit('t/x', body, true);
    void q.submit('t/x', body, true);
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(2);
  });

  it('puts in-flight publishes back in order when the session drops', async () => {
    const { q, sent } = queue();
    void q.submit('t/x', body, true);
    void q.submit('t/x', body, true);
    await new Promise((r) => setTimeout(r, 0));
    q.sessionLost();
    q.flush();
    expect(sent[1]!.map((p) => p.id)).toEqual(sent[0]!.map((p) => p.id));
  });

  it('bounds the offline queue and times out', async () => {
    const { q } = queue({ online: false, maxQueued: 1, timeoutMs: 20 });
    const a = q.submit('t/x', body, true);
    await expect(q.submit('t/x', body, true)).rejects.toMatchObject({ code: Code.QueueFull });
    await expect(a).rejects.toMatchObject({ code: Code.Timeout, local: true });
    await expect(q.submit('t/x', body, false)).resolves.toBeUndefined();
  });

  it('does not retry local or non-retryable errors', async () => {
    const { q, sent } = queue();
    const p = q.submit('t/x', body, true);
    await new Promise((r) => setTimeout(r, 0));
    q.failed(sent[0]![0]!, new RealtimeError(Code.Forbidden));
    await expect(p).rejects.toMatchObject({ code: Code.Forbidden, topic: 't/x' });
    const p2 = q.submit('t/x', body, true);
    await new Promise((r) => setTimeout(r, 0));
    q.failed(sent[1]![0]!, localError(Code.PayloadTooLarge));
    await expect(p2).rejects.toMatchObject({ code: Code.PayloadTooLarge });
  });
});

describe('SubscriptionRegistry', () => {
  const spec = { start: StartAt.Latest, lastN: 0, onGap: OnGap.FromOldest, snapshot: true, resume: true };

  function listener(types?: DeliveryClass[]) {
    const calls: string[] = [];
    const l: TopicListener = {
      types,
      onActive: () => void calls.push('active'),
      onEvent: (e) => void calls.push(`event:${e.event.seq}`),
      onSnapshot: (es) => void calls.push(`snapshot:${es.length}`),
      onGap: () => void calls.push('gap'),
      onResync: () => void calls.push('resync'),
      onFailed: (e) => void calls.push(`failed:${e.codeName}`),
      onEnded: (e) => void calls.push(`ended:${e.codeName}`),
    };
    return { l, calls };
  }

  it('builds resume bodies from the received or stored cursor', async () => {
    const store = memoryCursorStore();
    await store.set('chat/a', { epoch: 5n, seq: 9n });
    const r = new SubscriptionRegistry({ cursorStore: store, logger: silentLogger, onChange: () => {} });
    const e = r.add('chat/a', spec, listener().l);
    await e.loading;
    expect(e.subscribeBody()).toMatchObject({ start: StartAt.After, cursor: { epoch: 5n, seq: 9n } });
    const e2 = r.add('chat/b', { ...spec, resume: false }, listener().l);
    await e2.loading;
    expect(e2.subscribeBody()).toMatchObject({ start: StartAt.Latest });
  });

  it('recovers from InvalidCursor once by dropping the cursor', async () => {
    const store = memoryCursorStore();
    await store.set('chat/a', { epoch: 5n, seq: 9n });
    const r = new SubscriptionRegistry({ cursorStore: store, logger: silentLogger, onChange: () => {} });
    const { l, calls } = listener();
    const e = r.add('chat/a', spec, l);
    await e.loading;
    expect(r.onSubscribeError(e, new RealtimeError(Code.InvalidCursor))).toBe(true);
    expect(e.subscribeBody()).toMatchObject({ start: StartAt.Latest });
    expect(r.onSubscribeError(e, new RealtimeError(Code.Forbidden))).toBe(false);
    await e.chain;
    expect(calls).toEqual(['failed:Forbidden']);
  });

  it('runs callbacks in order and dedups by cursor across epochs', async () => {
    const r = new SubscriptionRegistry({ cursorStore: memoryCursorStore(), logger: silentLogger, onChange: () => {} });
    const { l, calls } = listener();
    const e = r.add('chat/a', spec, l);
    r.onSubAck(e, { topicId: 1n, delivery: DeliveryClass.Durable, catchingUp: false, snapshotFollows: false, deliveries: [] });
    const d = (epoch: bigint, ...seqs: bigint[]) => ({
      topicId: 1n,
      delivery: DeliveryClass.Durable,
      replayed: false,
      events: seqs.map((s) => event(1n, epoch, s, 'x')),
    });
    r.onDeliver(e, d(1n, 1n, 2n));
    r.onDeliver(e, d(1n, 2n, 3n));
    r.onDeliver(e, d(2n, 1n));
    await e.chain;
    expect(calls).toEqual(['active', 'event:1', 'event:2', 'event:3', 'event:1']);
    expect(e.processed).toEqual({ epoch: 2n, seq: 1n });
  });

  describe('events of several types in one topic (ADR-001)', () => {
    const { Durable: S, LastValue: KV, Ephemeral: SIG } = DeliveryClass;
    const deliver = (...events: ReturnType<typeof event>[]) => ({ topicId: 1n, delivery: DeliveryClass.Unspecified, replayed: false, events });

    it('takes the event\'s own type, scopes kv keys by event name and skips unnumbered events in dedup', async () => {
      const r = new SubscriptionRegistry({ cursorStore: memoryCursorStore(), logger: silentLogger, onChange: () => {} });
      const { l, calls } = listener();
      const e = r.add('chat/a', spec, l);
      r.onSubAck(e, { topicId: 1n, delivery: DeliveryClass.Unspecified, catchingUp: false, snapshotFollows: false, deliveries: [S, KV, SIG] });
      r.onDeliver(
        e,
        deliver(
          event(1n, 1n, 1n, 'hi', { delivery: S, name: 'message' }),
          event(1n, 0n, 0n, '{}', { delivery: KV, name: 'read', key: 'user:7' }),
          event(1n, 0n, 0n, '{}', { delivery: KV, name: 'location', key: 'user:7' }),
          event(1n, 0n, 0n, '{}', { delivery: SIG, name: 'typing', publisher: 'user:8' }),
          event(1n, 0n, 0n, '{}', { delivery: SIG, name: 'typing', publisher: 'user:8' }),
          event(1n, 1n, 2n, 'again', { delivery: S, name: 'message' }),
        ),
      );
      await e.chain;
      expect(calls).toEqual(['active', 'event:1', 'event:0', 'event:0', 'event:0', 'event:0', 'event:2']);
      expect(e.received).toEqual({ epoch: 1n, seq: 2n });
      expect(e.processed).toEqual({ epoch: 1n, seq: 2n });
      expect([...e.kv.keys()].sort()).toEqual(['location', 'read']);
      expect(e.kv.get('read')!.has('user:7')).toBe(true);
      expect(e.signals.get('typing')!.size).toBe(1);
      r.onDeliver(e, deliver(event(1n, 0n, 0n, '', { delivery: KV, name: 'read', key: 'user:7', tombstone: true })));
      expect(e.kv.has('read')).toBe(false);
      expect(e.kv.get('location')!.has('user:7')).toBe(true);
    });

    it('falls back to the frame and topic class for nodes before ADR-001', async () => {
      const r = new SubscriptionRegistry({ cursorStore: memoryCursorStore(), logger: silentLogger, onChange: () => {} });
      const types: number[] = [];
      const l: TopicListener = { ...listener().l, onEvent: (d) => void types.push(d.delivery) };
      const e = r.add('fleet/1', spec, l);
      r.onSubAck(e, { topicId: 1n, delivery: KV, catchingUp: false, snapshotFollows: false, deliveries: [] });
      r.onDeliver(e, { ...deliver(event(1n, 1n, 1n, '{}', { key: 'car-1' })), delivery: KV });
      await e.chain;
      expect(types).toEqual([KV]);
      expect(e.kv.get('')!.has('car-1')).toBe(true);
      expect(e.processed).toBeUndefined(); // state topics on old nodes resume from snapshots
    });

    it('asks the wire for the union of every listener\'s types and filters each listener locally', async () => {
      let changes = 0;
      const r = new SubscriptionRegistry({ cursorStore: memoryCursorStore(), logger: silentLogger, onChange: () => changes++ });
      const inbox = listener([S]);
      const e = r.add('chat/a', spec, inbox.l);
      await e.loading;
      expect(e.subscribeBody().types).toEqual([S]);
      r.onSubAck(e, { topicId: 1n, delivery: DeliveryClass.Unspecified, catchingUp: false, snapshotFollows: false, deliveries: [S, SIG] });
      const room = listener();
      const before = changes;
      r.add('chat/a', spec, room.l);
      expect(e.retype).toBe(true);
      expect(changes).toBe(before + 1);
      expect(e.subscribeBody().types).toEqual([]);
      expect(e.retype).toBe(false);
      r.onDeliver(
        e,
        deliver(event(1n, 1n, 1n, 'hi', { delivery: S, name: 'message' }), event(1n, 0n, 0n, '{}', { delivery: SIG, name: 'typing' })),
      );
      await e.chain;
      expect(inbox.calls).toEqual(['active', 'event:1']);
      expect(room.calls).toEqual(['active', 'snapshot:0', 'event:1', 'event:0']);
    });

    it('does not resubscribe when the wire already carries the newcomer\'s types', async () => {
      const r = new SubscriptionRegistry({ cursorStore: memoryCursorStore(), logger: silentLogger, onChange: () => {} });
      const e = r.add('chat/a', spec, listener().l);
      await e.loading;
      e.subscribeBody();
      r.onSubAck(e, { topicId: 1n, delivery: S, catchingUp: false, snapshotFollows: false, deliveries: [] });
      r.add('chat/a', spec, listener([S]).l);
      expect(e.retype).toBe(false);
    });
  });
});
