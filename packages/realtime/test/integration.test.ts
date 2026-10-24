/**
 * End-to-end tests against a real RTE node.
 *
 *   RTE_BIN=../../../rte/target/debug/realtime-transport-engine pnpm test:integration
 *
 * Skipped when RTE_BIN is unset.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  Code,
  type Message,
  Realtime,
  type RealtimeOptions,
  type StreamTransport,
  connect,
} from '../src';
import type { StreamConnection } from '../src/transport/types';
import { WebSocketTransport } from '../src/transport/websocket';
import { until } from './support/fake-transport';
import { type RteNode, startNode } from './support/rte-node';
import { mintToken } from './support/token';

let node: RteNode | undefined;
const clients: Realtime[] = [];
let run = 0;

beforeAll(async () => {
  node = await startNode();
}, 30_000);

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await node?.stop();
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
    endpoints: { websocket: node!.ws, http: node!.http },
    token: () => mintToken(sub),
    reconnect: { initialDelayMs: 10, maxDelayMs: 100 },
    longPoll: { waitMs: 2_000, emptyStateRecheckMs: 300 },
    ...opts,
  });
  clients.push(c);
  return c;
}

const live = describe.skipIf(!process.env.RTE_BIN);

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
      await until(() => sub.values.size === 2, 8_000, 'two values');
      await bob.topic(topic).publish('location', null, { delivery: 'kv', key: 'driver-1', remove: true });
      await until(() => sub.values.size === 1, 8_000, 'delete applied');
      expect([...sub.values.keys()]).toEqual(['driver-2']);
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
  });
}

live('ephemeral signals', () => {
  it('delivers signals and keeps the latest per sender', async () => {
    const topic = `typing/${uniq()}`;
    const alice = await open('alice');
    const sub = alice.topic(topic).subscribe();
    await sub.ready;
    expect(sub.deliveries).toEqual(['signal']);
    const bob = await open('bob');
    void bob.topic(topic).publish('typing', { typing: true }, { delivery: 'signal' });
    await until(() => sub.values.get('bob'), 8_000, 'signal');
    expect(sub.values.get('bob')!.data).toEqual({ typing: true });
    // publish() on an Ephemeral topic still gets a receipt.
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
