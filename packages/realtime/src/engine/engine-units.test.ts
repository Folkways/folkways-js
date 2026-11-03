import { afterEach, describe, expect, it, vi } from 'vitest';

import { event } from '../../test/support/server-codec';
import { mintToken } from '../../test/support/token';
import { Code } from '../shared/codes';
import { RealtimeError, localError } from '../shared/errors';
import { silentLogger } from '../shared/logger';
import { AckMode, DeliveryClass, FlowAction, OnGap, StartAt } from '../transport';
import { Backoff } from './backoff';
import { memoryCursorStore } from './cursor-store';
import { Outbox } from './outbox';
import { KEYS, ScopedStore, memoryStore, scopePrefix } from './store';
import { packetize } from './packets';
import { type FlowState, type OutboundPublish, PublishQueue } from './publish-queue';
import { SubscriptionRegistry, type TopicListener } from './subscriptions';
import { TokenManager, authUrlProvider, peekJwt, publishableKeyProvider } from './token';
import { resolveOptions } from '../api/options';

describe('Backoff', () => {
  it('grows exponentially with full jitter, capped, floored at retry_after', () => {
    const b = new Backoff({ initialDelayMs: 100, maxDelayMs: 1_000 }, () => 0.999);
    expect([b.next(), b.next(), b.next(), b.next(), b.next()]).toEqual([99, 199, 399, 799, 999]);
    expect(new Backoff({ initialDelayMs: 100, maxDelayMs: 1_000 }, () => 0).next(250)).toBe(250);
    b.reset();
    expect(b.next()).toBe(99);
  });

  it('waits at least retry_after, plus jitter of up to min(cap, retry_after), so a herd spreads out', () => {
    const half = new Backoff({ initialDelayMs: 100, maxDelayMs: 1_000 }, () => 0.5);
    // Caps 100, 200, 400, 800: the jitter grows with them but never past the floor itself.
    expect([half.next(400), half.next(400), half.next(400), half.next(400)]).toEqual([450, 500, 600, 600]);
    const most = new Backoff({ initialDelayMs: 500, maxDelayMs: 30_000 }, () => 0.999);
    expect(most.next(5_000)).toBe(5_499);
    const many = Array.from({ length: 200 }, () => new Backoff({ initialDelayMs: 500, maxDelayMs: 30_000 }).next(5_000));
    expect(Math.min(...many)).toBeGreaterThanOrEqual(5_000);
    expect(Math.max(...many)).toBeLessThan(5_500);
    expect(new Set(many).size).toBeGreaterThan(50);
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

  it('trades a publishable key at the node for anonymous tokens, keeping the node\'s refusal code', async () => {
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    let next = { status: 200, body: { token: 'anon-tok', kind: 'anonymous', identity: null } as Record<string, unknown> };
    const fetchFn = async (url: string, init: { headers: Record<string, string>; body: Uint8Array }) => {
      calls.push({ url, headers: init.headers, body: new TextDecoder().decode(init.body) });
      return {
        status: next.status,
        headers: { get: () => 'application/json' },
        arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(next.body)).buffer as ArrayBuffer,
      };
    };
    const p = publishableKeyProvider('https://rte.example.com/', 'rte_pk_web.abc', fetchFn);
    expect(await p({ reason: 'initial' })).toBe('anon-tok');
    expect(calls[0]).toMatchObject({ url: 'https://rte.example.com/v1/token', headers: { authorization: 'Bearer rte_pk_web.abc' }, body: '{}' });
    next = { status: 403, body: { code: Code.Suspended, error: 'Suspended', message: 'api key paused' } };
    await expect(p({ reason: 'expiring' })).rejects.toMatchObject({ code: Code.Suspended, message: expect.stringContaining('api key paused') });
    next = { status: 429, body: { code: Code.RateLimited, error: 'RateLimited', message: 'too many failed authentications', retry_after_ms: 42_000 } };
    await expect(p({ reason: 'rejected' })).rejects.toMatchObject({ code: Code.RateLimited, retry: 'backoff', retryAfterMs: 42_000 });
  });

  it('takes the wait from Retry-After when a 429 body has no retry_after_ms', async () => {
    const fetchFn = async () => ({
      status: 429,
      headers: { get: (h: string) => (h.toLowerCase() === 'retry-after' ? '7' : null) },
      arrayBuffer: async () => new TextEncoder().encode('Too Many Requests').buffer as ArrayBuffer,
    });
    const p = publishableKeyProvider('https://rte.example.com', 'rte_pk_web.abc', fetchFn);
    await expect(p({ reason: 'initial' })).rejects.toMatchObject({ code: Code.AuthRequired, retryAfterMs: 7_000 });
  });

  it('takes one token source, and never a secret API key', () => {
    const base = { url: 'https://rte.example.com' };
    expect(resolveOptions({ ...base, publishableKey: 'rte_pk_web.abc' }).engine.token).toBeTypeOf('function');
    expect(() => resolveOptions({ ...base, publishableKey: 'rte_sk_backend.abc' })).toThrow(/sign tokens on your server/);
    expect(() => resolveOptions({ ...base, publishableKey: 'nope' })).toThrow(/rte_pk_/);
    expect(() => resolveOptions({ ...base, publishableKey: 'rte_pk_web.abc', token: 't' })).toThrow(/one of/);
    expect(() => resolveOptions({ ...base, authUrl: '/t', token: 't' })).toThrow(/one of/);
    expect(() => resolveOptions({ endpoints: { websocket: 'wss://rte.example.com/v1/ws' }, publishableKey: 'rte_pk_web.abc' })).toThrow(/HTTP endpoint/);
  });

  it('reports provider failures as AuthRequired', async () => {
    const tm = new TokenManager(() => {
      throw new Error('backend down');
    });
    await expect(tm.get()).rejects.toMatchObject({ code: Code.AuthRequired, local: true });
  });
});

describe('ScopedStore', () => {
  it('waits for the scope, keeps cursors forward-only and prunes topics no longer granted', async () => {
    const raw = memoryStore();
    const s = new ScopedStore(raw, silentLogger);
    const cursors = s.cursors();
    const pending = cursors.set('chat/a', { epoch: 1n, seq: 5n });
    s.setScope(scopePrefix('seg', 'user:7', false));
    await pending;
    expect(await raw.get('fw/seg/user%3A7/c/chat%2Fa')).toBe('1:5');
    await cursors.set('chat/a', { epoch: 1n, seq: 3n }); // behind: another tab is ahead
    expect(await cursors.get('chat/a')).toEqual({ epoch: 1n, seq: 5n });
    await cursors.set('chat/a', { epoch: 2n, seq: 1n }); // a new epoch always wins
    expect(await cursors.get('chat/a')).toEqual({ epoch: 2n, seq: 1n });
    await cursors.set('secret/x', { epoch: 1n, seq: 1n });
    await s.prune([{ topic: 'chat/*', ops: ['subscribe'] }]);
    expect(await s.keys(KEYS.cursor)).toEqual(['c/chat%2Fa']);
    expect(scopePrefix('seg', undefined, true)).toBe('fw/seg/~anon/');
    await s.wipe();
    expect(await raw.keys('fw/')).toEqual([]);
  });
});

describe('Outbox', () => {
  it('round-trips publish bodies through the store, encrypted with the cipher', async () => {
    const raw = { ...memoryStore(), persistent: true };
    const scoped = new ScopedStore(raw, silentLogger);
    scoped.setScope('fw/s/u/');
    const cipher = { encrypt: (v: string) => `enc:${btoa(v)}`, decrypt: (v: string) => atob(v.slice(4)) };
    const ob = new Outbox(scoped, 600_000, silentLogger, cipher);
    const body = {
      topic: { name: 'chat/1' },
      name: 'message',
      payload: new Uint8Array([0, 255, 7]),
      delivery: DeliveryClass.Durable,
      ack: AckMode.Accepted,
      idempotencyKey: { hi: 1n << 63n, lo: 9n },
      headers: [['k', 'v']] as const,
      clientTsMs: 5,
    };
    const key = ob.keyFor(body, 1_000);
    await ob.put({ key, topic: 'chat/1', body, createdAt: 1_000 });
    expect((await raw.get(`fw/s/u/${key}`))!.startsWith('enc:')).toBe(true);
    await raw.set('fw/s/u/o/garbage', 'not json');
    const [item, ...rest] = await ob.load();
    expect(rest).toEqual([]);
    expect(item).toEqual({ key, topic: 'chat/1', createdAt: 1_000, body: { ...body, headers: [['k', 'v']] } });
    expect(await raw.get('fw/s/u/o/garbage')).toBeUndefined();
    expect(ob.enabled).toBe(true);
    expect(new Outbox(new ScopedStore(memoryStore(), silentLogger), 1, silentLogger).enabled).toBe(false);
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
    const flows: string[] = [];
    let online = opts.online ?? true;
    const q = new PublishQueue(
      { canSend: () => online, send: (items) => sent.push(items), refusal: () => undefined },
      {
        maxQueued: opts.maxQueued ?? 10,
        timeoutMs: opts.timeoutMs ?? 1_000,
        retries: 2,
        logger: silentLogger,
        onFlow: (state: FlowState, ms: number) => flows.push(`${state}:${ms}`),
      },
    );
    return { q, sent, flows, setOnline: (v: boolean) => (online = v) };
  }

  const ack = { topicId: 1n, level: AckMode.Accepted, cursor: { epoch: 1n, seq: 1n }, duplicate: false, serverTsMs: 1 };
  const ids = (batches: OutboundPublish[][]) => batches.map((b) => b.map((p) => p.id));

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

  describe('retries and Flow (ADR-015)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('retries RateLimited after retry_after_ms without using up retries, until the deadline', async () => {
      vi.useFakeTimers();
      const { q, sent } = queue({ timeoutMs: 10_000 });
      const p = q.submit('t/x', body, true);
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 5; i++) {
        q.failed(sent[i]![0]!, new RealtimeError(Code.RateLimited, { retryAfterMs: 300 }));
        await vi.advanceTimersByTimeAsync(299);
        expect(sent).toHaveLength(i + 1); // never before retry_after_ms
        await vi.advanceTimersByTimeAsync(301); // floor + at most min(cap, floor) of jitter
        expect(sent).toHaveLength(i + 2);
      }
      // Same publish (and so the same idempotency key) every time; 5 retries > retries: 2.
      expect(new Set(sent.flat())).toEqual(new Set([sent[0]![0]]));
      q.acked(sent[5]![0]!, ack);
      await expect(p).resolves.toEqual(ack);
    });

    it('still bounds other backoff codes by retries, and RateLimited by the deadline', async () => {
      vi.useFakeTimers();
      const { q, sent } = queue({ timeoutMs: 2_000 });
      const p = q.submit('t/x', body, true);
      const pe = expect(p).rejects.toMatchObject({ code: Code.QuotaExceeded, topic: 't/x' });
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 3; i++) {
        q.failed(sent[i]![0]!, new RealtimeError(Code.QuotaExceeded, { retryAfterMs: 10 }));
        await vi.advanceTimersByTimeAsync(100);
      }
      await pe;
      expect(sent).toHaveLength(3); // the first send and retries: 2

      const r = q.submit('t/x', body, true);
      const re = expect(r).rejects.toMatchObject({ code: Code.Timeout, local: true });
      await vi.advanceTimersByTimeAsync(0);
      q.failed(sent[3]![0]!, new RealtimeError(Code.RateLimited, { retryAfterMs: 5_000 }));
      await vi.advanceTimersByTimeAsync(2_000);
      await re;
      expect(sent).toHaveLength(4);
    });

    it('sends in one batch per interval while throttled, and at once again on Resume', async () => {
      vi.useFakeTimers();
      const { q, sent, flows } = queue({ timeoutMs: 10_000 });
      q.flowControl(FlowAction.Throttle, 200, false);
      expect(q.flow).toBe('throttled');
      q.submit('t/x', body, true).catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
      expect(sent).toHaveLength(1); // the first batch goes at once
      q.submit('t/x', body, true).catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
      q.submit('t/x', body, true).catch(() => {});
      await vi.advanceTimersByTimeAsync(199);
      expect(sent).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(ids(sent)).toEqual([[1], [2, 3]]);
      // A new interval, clamped to [50, 1000] ms, starts after the batch already due.
      q.flowControl(FlowAction.Throttle, 60_000, false);
      q.submit('t/x', body, true).catch(() => {});
      await vi.advanceTimersByTimeAsync(200);
      expect(sent).toHaveLength(3);
      q.submit('t/x', body, true).catch(() => {});
      await vi.advanceTimersByTimeAsync(999);
      expect(sent).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(sent).toHaveLength(4);
      q.submit('t/x', body, true).catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
      q.flowControl(FlowAction.Resume, 0, false);
      expect(ids(sent)[sent.length - 1]).toEqual([6]);
      expect(q.flow).toBe('normal');
      expect(flows).toEqual(['throttled:200', 'normal:0']); // changes only
    });

    it('holds publishes while paused, drops fire-and-forget, and sends the held ones in order on Resume', async () => {
      vi.useFakeTimers();
      const { q, sent, flows } = queue({ maxQueued: 3, timeoutMs: 10_000 });
      q.submit('t/x', body, false).catch(() => {}); // a queued signal, dropped by the pause
      q.flowControl(FlowAction.Pause, 1_500, false);
      const held = [q.submit('t/x', body, true), q.submit('t/x', body, true), q.submit('t/x', body, true)];
      await expect(q.submit('t/x', body, false)).resolves.toBeUndefined();
      await expect(q.submit('t/x', body, true)).rejects.toMatchObject({ code: Code.QueueFull, message: expect.stringContaining('paused') });
      // The node sends Resume on its own: on WebSocket a pause has no expiry of its own.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(sent).toHaveLength(0);
      q.flowControl(FlowAction.Resume, 0, false);
      await vi.advanceTimersByTimeAsync(0);
      expect(ids(sent)).toEqual([[2, 3, 4]]);
      for (const p of sent[0]!) q.acked(p, ack);
      await expect(Promise.all(held)).resolves.toHaveLength(3);
      expect(flows).toEqual(['paused:1500', 'normal:0']);
    });

    it('rejects acknowledged publishes while paused when the offline queue is disabled', async () => {
      vi.useFakeTimers();
      const { q, sent } = queue({ maxQueued: 0, timeoutMs: 10_000 });
      q.flowControl(FlowAction.Pause, 1_500, false);
      await expect(q.submit('t/x', body, true)).rejects.toMatchObject({ code: Code.QueueFull, local: true, message: expect.stringContaining('disabled') });
      await expect(q.submit('t/x', body, false)).resolves.toBeUndefined();
      expect(q.size).toBe(0);
      q.flowControl(FlowAction.Resume, 0, false);
      const p = q.submit('t/x', body, true);
      await vi.advanceTimersByTimeAsync(0);
      expect(ids(sent)).toEqual([[1]]); // refused publishes never took an id
      q.acked(sent[0]![0]!, ack);
      await expect(p).resolves.toEqual(ack);
    });

    it('holds at most offlineQueue.maxSize publishes while paused', async () => {
      vi.useFakeTimers();
      const { q, sent } = queue({ maxQueued: 2, timeoutMs: 10_000 });
      q.flowControl(FlowAction.Pause, 1_500, false);
      const held = [q.submit('t/x', body, true), q.submit('t/x', body, true)];
      await expect(q.submit('t/x', body, true)).rejects.toMatchObject({ code: Code.QueueFull, message: expect.stringContaining('paused') });
      expect(q.size).toBe(2);
      q.flowControl(FlowAction.Resume, 0, false);
      await vi.advanceTimersByTimeAsync(0);
      expect(ids(sent)).toEqual([[1, 2]]);
      for (const p of sent[0]!) q.acked(p, ack);
      await expect(Promise.all(held)).resolves.toHaveLength(2);
    });

    it('never holds more than the limit through a long pause; deadlines free room for new publishes', async () => {
      vi.useFakeTimers();
      const { q, sent } = queue({ maxQueued: 2, timeoutMs: 1_000 });
      q.flowControl(FlowAction.Pause, 60_000, false);
      const outcomes: string[] = [];
      for (let t = 0; t < 30; t++) {
        q.submit('t/x', body, true).then(
          () => outcomes.push('ok'),
          (e: RealtimeError) => outcomes.push(e.codeName),
        );
        await vi.advanceTimersByTimeAsync(100);
        expect(q.size).toBeLessThanOrEqual(2);
      }
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sent).toHaveLength(0);
      expect(q.size).toBe(0);
      // Every publish settled loudly: refused at once, or timed out while held.
      expect(outcomes).toHaveLength(30);
      expect(outcomes.filter((o) => o === 'Timeout').length).toBeGreaterThanOrEqual(4);
      expect(outcomes.filter((o) => o === 'QueueFull').length).toBeGreaterThanOrEqual(20);
      expect(outcomes).not.toContain('ok');
    });

    it('takes publishes again once a full pause queue is sent on Resume', async () => {
      vi.useFakeTimers();
      const { q, sent } = queue({ maxQueued: 2, timeoutMs: 10_000 });
      q.flowControl(FlowAction.Pause, 1_500, false);
      q.submit('t/x', body, true).catch(() => {});
      q.submit('t/x', body, true).catch(() => {});
      await expect(q.submit('t/x', body, true)).rejects.toMatchObject({ code: Code.QueueFull });
      q.flowControl(FlowAction.Resume, 0, false);
      await vi.advanceTimersByTimeAsync(0);
      expect(ids(sent)).toEqual([[1, 2]]);
      // In flight no longer counts as held: the queue has room again.
      const more = [q.submit('t/x', body, true), q.submit('t/x', body, true), q.submit('t/x', body, true)];
      await vi.advanceTimersByTimeAsync(0);
      expect(ids(sent)).toEqual([[1, 2], [3, 4, 5]]);
      for (const p of sent.flat()) q.acked(p, ack);
      await expect(Promise.all(more)).resolves.toHaveLength(3);
    });

    it('keeps the deadline running while paused', async () => {
      vi.useFakeTimers();
      const { q, sent } = queue({ timeoutMs: 1_000 });
      q.flowControl(FlowAction.Pause, 5_000, false);
      const p = q.submit('t/x', body, true);
      const pe = expect(p).rejects.toMatchObject({ code: Code.Timeout, local: true });
      await vi.advanceTimersByTimeAsync(1_000);
      await pe;
      q.flowControl(FlowAction.Resume, 0, false);
      expect(sent).toHaveLength(0);
    });

    it('resends a publish the node refused during a pause once it resumes, after Pause → Throttle → Resume', async () => {
      vi.useFakeTimers();
      const { q, sent, flows } = queue({ timeoutMs: 10_000 });
      const p = q.submit('t/x', body, true);
      await vi.advanceTimersByTimeAsync(0);
      q.flowControl(FlowAction.Pause, 1_200, false);
      q.failed(sent[0]![0]!, new RealtimeError(Code.RateLimited, { message: 'publishing paused', retryAfterMs: 1_200 }));
      await vi.advanceTimersByTimeAsync(3_000); // the retry is due, but the pause holds it
      expect(sent).toHaveLength(1);
      q.flowControl(FlowAction.Throttle, 300, false);
      await vi.advanceTimersByTimeAsync(0);
      expect(sent).toHaveLength(2);
      expect(sent[1]![0]).toBe(sent[0]![0]);
      q.flowControl(FlowAction.Resume, 0, false);
      q.acked(sent[1]![0]!, ack);
      await expect(p).resolves.toEqual(ack);
      expect(flows).toEqual(['paused:1200', 'throttled:300', 'normal:0']);
    });

    it('lets an HTTP Flow lapse after its wait, since every request starts unthrottled', async () => {
      vi.useFakeTimers();
      const { q, sent, flows } = queue({ timeoutMs: 10_000 });
      q.flowControl(FlowAction.Pause, 1_500, true);
      q.submit('t/x', body, true).catch(() => {});
      await vi.advanceTimersByTimeAsync(1_499);
      expect(sent).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(sent).toHaveLength(1);
      expect(q.flow).toBe('normal');
      // A repeated Throttle restarts the wait.
      q.flowControl(FlowAction.Throttle, 400, true);
      await vi.advanceTimersByTimeAsync(300);
      q.flowControl(FlowAction.Throttle, 400, true);
      await vi.advanceTimersByTimeAsync(300);
      expect(q.flow).toBe('throttled');
      await vi.advanceTimersByTimeAsync(100);
      expect(q.flow).toBe('normal');
      expect(flows).toEqual(['paused:1500', 'normal:0', 'throttled:400', 'normal:0']);
    });

    it('forgets the flow state when the session drops', async () => {
      vi.useFakeTimers();
      const { q, flows } = queue();
      q.flowControl(FlowAction.Pause, 2_000, false);
      q.sessionLost();
      expect(q.flow).toBe('normal');
      q.flowControl(42 as FlowAction, 0, false); // an action from a newer node is ignored
      expect(q.flow).toBe('normal');
      expect(flows).toEqual(['paused:2000', 'normal:0']);
    });
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
