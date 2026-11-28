/** Integration tests against an externally provisioned test service. */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  Code,
  type Message,
  Realtime,
  type RealtimeOptions,
  type StreamTransport,
  connect,
} from '../src';
import { Rest } from '../src/server';
import type { StreamConnection } from '../src/transport/types';
import { WebSocketTransport } from '../src/transport/websocket';
import { until } from './support/fake-transport';
import { mintToken as signTestToken } from './support/token';

const env = process.env;
const enabled = env.FOLKWAYS_INTEGRATION === '1';
function required(name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing integration setting: ${name}`);
  return value;
}
function mintToken(sub: string, opts: Parameters<typeof signTestToken>[1] = {}) {
  return signTestToken(sub, { ...opts, seg: required('FOLKWAYS_TEST_SEGMENT_ID'), kid: required('FOLKWAYS_TEST_KEY_ID'), privateKey: required('FOLKWAYS_TEST_PRIVATE_KEY').replace(/\\n/g, '\n') });
}

const clients: Realtime[] = [];
let run = 0;

beforeAll(() => {
  if (!enabled) return;
  for (const name of ['FOLKWAYS_TEST_WS_URL', 'FOLKWAYS_TEST_HTTP_URL', 'FOLKWAYS_TEST_SEGMENT_ID', 'FOLKWAYS_TEST_KEY_ID', 'FOLKWAYS_TEST_PRIVATE_KEY']) required(name);
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

/** A unique topic suffix per test, so tests never see each other's events. */
const uniq = () => `t${Date.now().toString(36)}${(run++).toString(36)}`;

/** WebSocket transport that remembers its connections, so a test can cut them. */
class KillableWs implements StreamTransport {
  readonly kind = 'websocket' as const;
  readonly inner = new WebSocketTransport();
  conns: StreamConnection[] = [];
  available() {
    return this.inner.available();
  }
  async connect(url: string, signal?: AbortSignal) {
    const c = await this.inner.connect(url, signal);
    this.conns.push(c);
    return c;
  }
}

async function open(sub: string, opts: Partial<RealtimeOptions> = {}): Promise<Realtime> {
  const c = await connect({
    endpoints: { websocket: required('FOLKWAYS_TEST_WS_URL'), http: required('FOLKWAYS_TEST_HTTP_URL') },
    token: () => mintToken(sub),
    reconnect: { initialDelayMs: 10, maxDelayMs: 100 },
    longPoll: { waitMs: 2_000, emptyStateRecheckMs: 300 },
    ...opts,
  });
  clients.push(c);
  return c;
}

const live = describe.skipIf(!enabled);

for (const transport of ['websocket', 'http'] as const) {
  live(`over ${transport}`, () => {
    const opts = { transports: [transport] };

    it('publishes and delivers with receipts, headers and content types', async () => {
      const topic = `chat/${uniq()}`;
      const alice = await open('alice', opts);
      expect(alice.connection.transport).toBe(transport);
      const got: Message[] = [];
      const sub = alice.topic(topic).subscribe((m) => {
        got.push(m);
      });
      await sub.ready;
      expect(sub.deliveries).toEqual(['stream']);

      const bob = await open('bob', opts);
      const r1 = await bob.topic(topic).publish('message', { text: 'hi' }, { headers: { trace: 'abc' } });
      const r2 = await bob.topic(topic).publish('message', 'plain');
      const r3 = await bob.topic(topic).publish('message', new Uint8Array([1, 2, 3]));
      expect(r1).toMatchObject({ level: 'accepted', duplicate: false });
      expect(r2.cursor!.seq).toBe(r1.cursor!.seq + 1n);

      await until(() => got.length === 3, 8_000, 'three messages');
      expect(got.map((m) => m.data)).toEqual([{ text: 'hi' }, 'plain', new Uint8Array([1, 2, 3])]);
      expect(got[0]).toMatchObject({ publisher: 'bob', headers: { trace: 'abc' }, id: r1.id });
      expect(got.map((m) => m.id)).toEqual([r1.id, r2.id, r3.id]);
    });

    it('keeps LastValue state: snapshot, update, tombstone', async () => {
      const topic = `rides/${uniq()}/location`;
      const bob = await open('bob', opts);
      await bob.topic(topic).publish('location', { lat: 1 }, { delivery: 'kv', key: 'driver-1' });
      const alice = await open('alice', opts);
      const snapshots: Message[][] = [];
      const sub = alice.topic(topic).subscribe();
      sub.on('snapshot', (s) => snapshots.push(s));
      await sub.ready;
      await until(() => snapshots.length >= 1, 8_000, 'snapshot');
      expect(snapshots[0]!.map((m) => [m.key, m.data])).toEqual([['driver-1', { lat: 1 }]]);
      expect(sub.deliveries).toEqual(['kv']);

      await bob.topic(topic).publish('location', { lat: 2 }, { delivery: 'kv', key: 'driver-2', ttlMs: 60_000 });
      await until(() => alice.topic(topic).values('location').size === 2, 8_000, 'two values');
      await bob.topic(topic).publish('location', null, { delivery: 'kv', key: 'driver-1', remove: true });
      await until(() => alice.topic(topic).values('location').size === 1, 8_000, 'delete applied');
      expect([...alice.topic(topic).values('location').keys()]).toEqual(['driver-2']);
    });

    it('reports Forbidden for topics without a rule or right', async () => {
      const alice = await open('alice', opts);
      await expect(alice.topic(`other/${uniq()}`).publish('message', 'x')).rejects.toMatchObject({ code: Code.Forbidden, local: false });
      const sub = alice.topic(`other/${uniq()}`).subscribe();
      await expect(sub.ready).rejects.toMatchObject({ code: Code.Forbidden });
      const reader = await open('reader', {
        ...opts,
        token: () => mintToken('reader', { cap: [{ topic: 'chat/>', ops: ['subscribe'] }] }),
      });
      await expect(reader.topic(`chat/${uniq()}`).publish('message', 'x')).rejects.toMatchObject({ code: Code.Forbidden });
    });

    it('answers a retried publish with the original receipt and refuses a conflicting one', async () => {
      const topic = `chat/${uniq()}`;
      const bob = await open('bob', opts);
      const key = '0123456789abcdef0123456789abcdef';
      const a = await bob.topic(topic).publish('message', 'once', { idempotencyKey: key });
      const b = await bob.topic(topic).publish('message', 'once', { idempotencyKey: key });
      expect(b).toMatchObject({ id: a.id, duplicate: true });
      await expect(bob.topic(topic).publish('message', 'different', { idempotencyKey: key })).rejects.toMatchObject({
        code: Code.IdempotencyConflict,
      });
    });

    it('replays history with from: oldest and last N', async () => {
      const topic = `chat/${uniq()}`;
      const bob = await open('bob', opts);
      for (let i = 1; i <= 5; i++) await bob.topic(topic).publish('message', `m${i}`);
      const alice = await open('alice', opts);
      const all: string[] = [];
      alice.topic<{ message: string }>(topic).subscribe((m) => void all.push(m.data), { from: 'oldest' });
      await until(() => all.length === 5, 8_000, 'replay');
      expect(all).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
      const carol = await open('carol', opts);
      const last: string[] = [];
      carol.topic<{ message: string }>(topic).subscribe((m) => void last.push(m.data), { from: { last: 2 } });
      await until(() => last.length === 2, 8_000, 'last 2');
      expect(last).toEqual(['m4', 'm5']);
    });

    it('reports a Gap for a cursor from another epoch and continues from the oldest', async () => {
      const topic = `chat/${uniq()}`;
      const bob = await open('bob', opts);
      await bob.topic(topic).publish('message', 'kept');
      const alice = await open('alice', opts);
      const got: string[] = [];
      const sub = alice.topic<{ message: string }>(topic).subscribe((m) => void got.push(m.data), { from: { after: '1:1' } });
      const gap = new Promise((r) => sub.once('gap', r));
      await expect(gap).resolves.toMatchObject({ reason: 'epoch-lost', resumed: true });
      await until(() => got.length === 1, 8_000, 'replay after gap');
      expect(got).toEqual(['kept']);
    });

    it('carries messages, read receipts and typing in one room (rooms/* fixture)', async () => {
      const topic = `rooms/${uniq()}`;
      const alice = await open('alice', opts);
      const room = alice.topic(topic);
      const all: Message[] = [];
      const sub = room.subscribe((m) => void all.push(m));
      await sub.ready;
      expect(sub.deliveries).toEqual(['stream', 'kv', 'signal']);
      const inbox: Message[] = [];
      const carol = await open('carol', opts);
      await carol.topic(topic).subscribe((m) => void inbox.push(m), { types: ['stream'] }).ready;

      const bob = await open('bob', opts);
      const msg = await bob.topic(topic).publish('message', { text: 'hi' });
      const read = await bob.topic(topic).publish('read', { upTo: msg.uid }, { delivery: 'kv' });
      await bob.topic(topic).publish('typing', { on: true }, { delivery: 'signal', ttlMs: 10_000 });
      expect(msg.uid).toMatch(/^[0-9a-f]{32}$/);
      expect(msg.cursor!.seq).toBe(1n);
      expect(read.cursor).toBeUndefined();
      expect(read.uid).toMatch(/^[0-9a-f]{32}$/);

      await until(() => all.some((m) => m.name === 'message') && room.values('read').has('bob') && room.values('typing').has('bob'), 8_000, 'message, receipt and signal');
      // Only the stream promises an order; a state poll may coalesce values or deliver them separately.
      expect(all.map((m) => [m.name, m.delivery, m.publisher])).toEqual(expect.arrayContaining([
        ['message', 'stream', 'bob'],
        ['read', 'kv', 'bob'],
        ['typing', 'signal', 'bob'],
      ]));
      expect(room.values('read').get('bob')!.data).toEqual({ upTo: msg.uid });
      expect(room.values('typing').get('bob')!.data).toEqual({ on: true });

      // A later receipt arrives as a change, over long-poll too.
      await bob.topic(topic).publish('read', { upTo: 'later' }, { delivery: 'kv' });
      await until(() => (room.values('read').get('bob')?.data as { upTo: string } | undefined)?.upTo === 'later', 8_000, 'second receipt');

      // The inbox asked for stream events only.
      await new Promise((r) => setTimeout(r, 300));
      expect(inbox.map((m) => m.name)).toEqual(['message']);

      // The rule fixes each event's type, and read receipts belong to their publisher.
      await expect(bob.topic(topic).publish('typing', { on: true }, { delivery: 'stream' })).rejects.toMatchObject({ code: Code.ClassMismatch });
      await expect(alice.topic(topic).publish('read', { upTo: 'x' }, { delivery: 'kv', key: 'bob' })).rejects.toMatchObject({ code: Code.Forbidden });
    }, 20_000);

    it.each(['stream', 'kv'] as const)('recovers existing state when a %s subscription widens', async (initial) => {
      const topic = `rooms/${uniq()}`;
      const bob = await open('bob', opts);
      const pub = bob.topic(topic);
      await pub.publish('read', 'already present', { delivery: 'kv' });
      await pub.publish('typing', 'already typing', { delivery: 'signal', ttlMs: 30_000 });
      const alice = await open('alice', opts);
      const room = alice.topic(topic);
      const seen: string[] = [];
      await room.subscribe((m) => { if (m.delivery === 'stream') seen.push(m.id); }, { types: [initial] }).ready;
      const first = await pub.publish('message', 'first');
      if (initial === 'stream') await until(() => seen.length === 1, 8_000, 'first stream event');
      else await until(() => room.values('read').has('bob'), 8_000, 'initial KV snapshot');
      expect(room.values('typing').has('bob')).toBe(false);
      const expanded = room.subscribe();
      await expanded.ready;
      await until(() => room.values('read').has('bob') && room.values('typing').has('bob'), 8_000, 'existing state after filter expansion');
      expect(room.values('read').get('bob')?.data).toBe('already present');
      expect(room.values('typing').get('bob')?.data).toBe('already typing');
      const second = await pub.publish('message', 'second');
      await until(() => room.messages.getSnapshot().some((m) => m.id === second.id), 8_000, 'stream continues');
      if (initial === 'stream') expect(seen).toEqual([first.id, second.id]);
      else expect(seen).toEqual([]);
    }, 30_000);

    it('delivers authorized backend notices to personal topics and rejects unauthorized writes', async () => {
      const identity = `user:${uniq()}`;
      const topic = `$user/${identity}`;
      const alice = await open(identity, opts);
      const messages: Message[] = [];
      await alice.topic(topic).subscribe((m) => { messages.push(m); }).ready;
      const serviceOptions = {
        url: required('FOLKWAYS_TEST_HTTP_URL'),
        segment: required('FOLKWAYS_TEST_SEGMENT_ID'),
        signingKey: { kid: required('FOLKWAYS_TEST_KEY_ID'), privateKey: required('FOLKWAYS_TEST_PRIVATE_KEY').replace(/\\n/g, '\n') },
        identity: 'backend',
      };
      const service = new Rest({ ...serviceOptions, capabilities: [{ topics: topic, ops: ['publish'] }] });
      const receipt = await service.publish(topic, 'notice', 'paid');
      await until(() => messages.some((m) => m.id === receipt.id), 8_000, 'personal notice');
      expect(messages.find((m) => m.id === receipt.id)).toMatchObject({ name: 'notice', data: 'paid', publisher: 'backend' });
      const denied = new Rest({ ...serviceOptions, capabilities: [{ topics: 'chat/>', ops: ['publish'] }] });
      await expect(denied.publish(topic, 'notice', 'denied')).rejects.toMatchObject({ code: Code.Forbidden });
    }, 20_000);

    it('preserves stream ordering through state changes, reauthentication and snapshot recovery', async () => {
      const topic = `rooms/${uniq()}`;
      const alice = await open('alice', { ...opts, signalTtlMs: 50 });
      const bob = await open('bob', opts);
      const room = alice.topic(topic);
      const publisher = bob.topic(topic);
      const messages: Message[] = [];
      const sub = room.subscribe((m) => { if (m.delivery === 'stream') messages.push(m); });
      await sub.ready;
      const a = await publisher.publish('message', 'first');
      await until(() => messages.length === 1, 8_000, 'first stream event');
      await publisher.publish('read', 'first', { delivery: 'kv' });
      await until(() => room.values('read').get('bob')?.data === 'first', 8_000, 'read state');
      await expect(publisher.publish('typing', 'on', { delivery: 'signal', ttlMs: 6_000 })).resolves.toBeUndefined();
      const typing = room.values('typing');
      await until(() => typing.has('bob'), 8_000, 'signal visible');
      await new Promise((r) => setTimeout(r, 150));
      expect(typing.has('bob')).toBe(true); // exceeds the legacy 50 ms fallback
      await alice.updateToken(mintToken('alice', { ttlSecs: 900 }));
      await publisher.publish('read', null, { delivery: 'kv', remove: true });
      await until(() => !room.values('read').has('bob'), 8_000, 'tombstone');
      const b = await publisher.publish('message', 'second');
      expect(b.cursor).toEqual({ epoch: a.cursor!.epoch, seq: a.cursor!.seq + 1n });
      await until(() => messages.length === 2, 8_000, 'second stream event');
      expect(messages.map((m) => m.id)).toEqual([a.id, b.id]);
      await until(() => !typing.has('bob'), 8_000, 'signal expiry');
      // A new subscriber must replay only the stream after the requested cursor
      // and see an empty current-state snapshot.
      const fresh = await open('carol', opts);
      const replay: Message[] = [];
      const snapshots: Message[][] = [];
      const freshSub = fresh.topic(topic).subscribe((m) => { if (m.delivery === 'stream') replay.push(m); }, { from: { after: a.cursor! } });
      freshSub.on('snapshot', (events) => snapshots.push(events));
      await freshSub.ready;
      await until(() => replay.length === 1 && snapshots.length >= 1, 8_000, 'replay and empty state snapshot');
      expect(replay.map((m) => m.id)).toEqual([b.id]);
      expect(snapshots[0]).toEqual([]);
      expect(fresh.topic(topic).values().size).toBe(0);
    }, 45_000);
  });
}

live('topic membership', () => {
  it('adds, narrows, removes and clears access with service credentials', async () => {
    const topic = `private/${uniq()}`;
    const identity = `member:${uniq()}`;
    const options = {
      url: required('FOLKWAYS_TEST_HTTP_URL'),
      segment: required('FOLKWAYS_TEST_SEGMENT_ID'),
      signingKey: { kid: required('FOLKWAYS_TEST_KEY_ID'), privateKey: required('FOLKWAYS_TEST_PRIVATE_KEY').replace(/\\n/g, '\n') },
    };
    const backend = new Rest({ ...options, capabilities: [{ topics: topic, ops: ['publish'] }] });
    const denied = new Rest({ ...options, capabilities: [{ topics: topic, ops: ['subscribe'] }] });
    try {
      await expect(denied.members.list(topic)).rejects.toMatchObject({ code: Code.Forbidden });
      await backend.members.add(topic, [identity], ['subscribe', 'publish']);
      expect(await backend.members.list(topic)).toEqual({ topic, members: [{ identity, ops: ['subscribe', 'publish'] }] });
      const member = await open(identity, { transports: ['websocket'] });
      const room = member.topic(topic);
      const sub = room.subscribe();
      await sub.ready;
      await room.publish('message', 'allowed');
      await backend.members.set(topic, identity, ['subscribe']);
      await expect(room.publish('message', 'denied')).rejects.toMatchObject({ code: Code.Forbidden });
      expect((await backend.members.list(topic)).members).toEqual([{ identity, ops: ['subscribe'] }]);
      await backend.members.remove(topic, [identity]);
      expect((await backend.members.list(topic)).members).toEqual([]);
      await expect(room.publish('message', 'removed')).rejects.toMatchObject({ code: Code.Forbidden });
      await backend.members.add(topic, [identity], ['subscribe']);
      await backend.members.clear(topic);
      expect((await backend.members.list(topic)).members).toEqual([]);
    } finally {
      await backend.members.clear(topic);
    }
  }, 30_000);
});

live('direct message rooms', () => {
  it('opens one room, delivers invites to online and offline members, and preserves restrictions on reopen', async () => {
    const aliceId = `alice:${uniq()}`;
    const bobId = `bob:${uniq()}`;
    const options = {
      url: required('FOLKWAYS_TEST_HTTP_URL'),
      segment: required('FOLKWAYS_TEST_SEGMENT_ID'),
      signingKey: { kid: required('FOLKWAYS_TEST_KEY_ID'), privateKey: required('FOLKWAYS_TEST_PRIVATE_KEY').replace(/\\n/g, '\n') },
    };
    const backend = new Rest({ ...options, capabilities: [{ topics: 'dm/>', ops: ['publish'] }, { topics: '$user/>', ops: ['publish'] }] });
    const denied = new Rest({ ...options, capabilities: [{ topics: 'dm/>', ops: ['publish'] }, { topics: `$user/${aliceId}`, ops: ['publish'] }] });
    const alice = await open(aliceId, { transports: ['websocket'] });
    const invites: Message[] = [];
    await alice.topic(`$user/${aliceId}`).subscribe((m) => { invites.push(m); }).ready;
    const data = { startedBy: aliceId };
    await expect(denied.dm.open([aliceId, bobId], { data })).rejects.toMatchObject({ code: Code.Forbidden });
    const room = await backend.dm.open([bobId, aliceId, aliceId], { data });
    try {
      expect(room.members).toEqual([aliceId, bobId].sort());
      expect(room.invites.every((i) => !i.duplicate)).toBe(true);
      await until(() => invites.length === 1, 8_000, 'online invitation');
      expect(invites[0]).toMatchObject({ name: 'invite', data: { type: 'dm', topic: room.topic, members: room.members, data } });
      const bob = await open(bobId, { transports: ['http'] });
      const replayed: Message[] = [];
      await bob.topic(`$user/${bobId}`).subscribe((m) => { replayed.push(m); }, { from: 'oldest' }).ready;
      await until(() => replayed.length === 1, 8_000, 'offline invitation replay');
      expect(replayed[0]).toMatchObject({ name: 'invite', data: { type: 'dm', topic: room.topic, members: room.members, data } });
      await backend.members.set(room.topic, bobId, ['subscribe']);
      const again = await backend.dm.open([aliceId, bobId], { data });
      expect(again.topic).toBe(room.topic);
      expect(again.invites.every((i) => i.duplicate)).toBe(true);
      expect((await backend.members.list(room.topic)).members.find((m) => m.identity === bobId)?.ops).toEqual(['subscribe']);
      const changed = await backend.dm.open([aliceId, bobId], { data: { ...data, subject: 'New subject' } });
      expect(changed.topic).toBe(room.topic);
      expect(changed.invites.every((i) => !i.duplicate)).toBe(true);
      await until(() => invites.length === 2 && replayed.length === 2, 8_000, 'new invitation content');
    } finally {
      await backend.members.clear(room.topic);
    }
  }, 40_000);
});

live('ephemeral signals', () => {
  it('delivers signals and keeps the latest per sender', async () => {
    const topic = `typing/${uniq()}`;
    const alice = await open('alice');
    const sub = alice.topic(topic).subscribe();
    await sub.ready;
    expect(sub.deliveries).toEqual(['signal']);
    const bob = await open('bob');
    void bob.topic(topic).publish('typing', { typing: true }, { delivery: 'signal' });
    await until(() => alice.topic(topic).values('typing').get('bob'), 8_000, 'signal');
    expect(alice.topic(topic).values('typing').get('bob')!.data).toEqual({ typing: true });
    // A signal resolves without a receipt.
    await expect(bob.topic(topic).publish('typing', { typing: false }, { delivery: 'signal' })).resolves.toBeUndefined();
  });
});

live('resume after a dropped connection', () => {
  it('resubscribes from the last cursor without losing or duplicating events', async () => {
    const topic = `chat/${uniq()}`;
    const ws = new KillableWs();
    const alice = await open('alice', { transports: ['websocket'], transportOverrides: { stream: ws } });
    const got: Message<string>[] = [];
    const sub = alice.topic<{ message: string }>(topic).subscribe((m) => {
      got.push(m);
    });
    await sub.ready;
    const bob = await open('bob');
    await bob.topic(topic).publish('message', 'before');
    await until(() => got.length === 1, 8_000, 'first event');

    ws.conns[ws.conns.length - 1]!.close(4000, 'test drop');
    await until(() => alice.connection.state !== 'connected', 2_000, 'disconnect');
    await bob.topic(topic).publish('message', 'while-away-1');
    await bob.topic(topic).publish('message', 'while-away-2');
    await until(() => alice.connection.state === 'connected', 8_000, 'reconnect');
    await bob.topic(topic).publish('message', 'after');
    await until(() => got.length === 4, 8_000, 'all events');
    expect(got.map((m) => m.data)).toEqual(['before', 'while-away-1', 'while-away-2', 'after']);
    expect(got[1]!.replayed).toBe(true);
    expect(new Set(got.map((m) => m.id)).size).toBe(4);
    expect(ws.conns).toHaveLength(2);
  });

  it('queues publishes made while offline and sends them once', async () => {
    const topic = `chat/${uniq()}`;
    const ws = new KillableWs();
    const bob = await open('bob', { transports: ['websocket'], transportOverrides: { stream: ws } });
    const alice = await open('alice');
    const got: string[] = [];
    await alice.topic<{ message: string }>(topic).subscribe((m) => void got.push(m.data)).ready;
    ws.conns[ws.conns.length - 1]!.close(4000, 'test drop');
    const p = bob.topic(topic).publish('message', 'queued');
    await expect(p).resolves.toMatchObject({ duplicate: false });
    await until(() => got.length === 1, 8_000, 'queued publish delivered');
    await new Promise((r) => setTimeout(r, 200));
    expect(got).toEqual(['queued']);
  });
});

live('mixed transports', () => {
  it('a WebSocket publisher reaches a long-poll subscriber and back', async () => {
    const topic = `chat/${uniq()}`;
    const poller = await open('poller', { transports: ['http'] });
    const socket = await open('socket', { transports: ['websocket'] });
    const atPoller: string[] = [];
    const atSocket: string[] = [];
    await poller.topic<{ message: string }>(topic).subscribe((m) => void atPoller.push(m.data)).ready;
    await socket.topic<{ message: string }>(topic).subscribe((m) => void atSocket.push(m.data)).ready;
    await socket.topic(topic).publish('message', 'from-ws');
    await poller.topic(topic).publish('message', 'from-http');
    await until(() => atPoller.length === 2 && atSocket.length === 2, 8_000, 'both sides');
    expect(atPoller).toEqual(['from-ws', 'from-http']);
    expect(atSocket).toEqual(['from-ws', 'from-http']);
  });
});
