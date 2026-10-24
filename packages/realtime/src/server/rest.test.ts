import { describe, expect, it, vi } from 'vitest';

import { decodeClientPacket, encodeServerPacket } from '../../test/support/server-codec';
import { Code } from '../shared/codes';
import { AckMode, type ClientFrame, type ServerMsg, joinLengthPrefixed } from '../transport';
import { Folkways, Rest } from './index';

const EPOCH = 1879046969544933376n;
const enc = new TextEncoder();

type Call = { url: string; auth: string; body: Uint8Array };

/** A node answering /v1/token with JSON and /v1/publish with frames. */
function fakeNode(answer: (frame: ClientFrame, token: string) => ServerMsg, tokenStatus = 200) {
  const calls: Call[] = [];
  let minted = 0;
  const fetch = vi.fn(async (url: string, init: { headers: Record<string, string>; body: Uint8Array }) => {
    const auth = init.headers.Authorization ?? '';
    calls.push({ url, auth, body: init.body });
    if (url.endsWith('/v1/token')) {
      const req = JSON.parse(new TextDecoder().decode(init.body)) as Record<string, unknown>;
      const body =
        tokenStatus === 200
          ? { token: `tok-${++minted}`, expires_at_ms: Date.now() + 600_000, identity: req.sub ?? null, kind: req.kind ?? 'user', capabilities: req.cap ?? [] }
          : { code: Code.Suspended, error: 'Suspended', message: 'api key paused' };
      return { status: tokenStatus, headers: { get: () => 'application/json' }, arrayBuffer: async () => enc.encode(JSON.stringify(body)).buffer as ArrayBuffer };
    }
    const [frame] = decodeClientPacket(init.body);
    const packet = encodeServerPacket([{ corr: frame!.corr, msg: answer(frame!, auth.slice(7)) }]);
    return {
      status: 200,
      headers: { get: (n: string) => (n === 'content-type' ? 'application/octet-stream' : null) },
      arrayBuffer: async () => joinLengthPrefixed([packet]).buffer as ArrayBuffer,
    };
  });
  return { fetch, calls };
}

describe('Folkways.Rest', () => {
  it('mints tokens with the API key and maps the answer', async () => {
    const node = fakeNode(() => ({ type: 'opOk' }));
    const rte = new Folkways.Rest({ apiKey: 'rte_sk_backend.secret', url: 'https://rte.example.com/', fetch: node.fetch });
    const t = await rte.createToken({ identity: 'user:42', capabilities: [{ topics: 'chat/*', ops: ['subscribe', 'publish'] }], ttlMs: 120_000 });
    expect(t).toMatchObject({ token: 'tok-1', identity: 'user:42', capabilities: [{ topics: 'chat/*', ops: ['subscribe', 'publish'] }] });
    expect(node.calls[0]!.url).toBe('https://rte.example.com/v1/token');
    expect(node.calls[0]!.auth).toBe('Bearer rte_sk_backend.secret');
    expect(JSON.parse(new TextDecoder().decode(node.calls[0]!.body))).toEqual({
      sub: 'user:42',
      cap: [{ topic: 'chat/*', ops: ['subscribe', 'publish'] }],
      ttl_secs: 120,
    });
  });

  it('reports token errors with the node\'s code', async () => {
    const node = fakeNode(() => ({ type: 'opOk' }), 403);
    const rte = new Rest({ apiKey: 'rte_sk_x', url: 'http://localhost:3000', fetch: node.fetch });
    await expect(rte.createToken({ identity: 'a' })).rejects.toMatchObject({ code: Code.Suspended, message: expect.stringContaining('api key paused') });
  });

  it('publishes over HTTP with its own cached service token and resolves with the receipt', async () => {
    const node = fakeNode((f) => {
      expect(f.msg).toMatchObject({ type: 'publish', publish: { topic: { name: 'chat/1' }, name: 'notice', ack: AckMode.Accepted } });
      return { type: 'pubAck', topicId: 1n, level: AckMode.Accepted, cursor: { epoch: EPOCH, seq: 3n }, duplicate: false, serverTsMs: 9 };
    });
    const rte = new Rest({ apiKey: 'rte_sk_x', url: 'http://localhost:3000', fetch: node.fetch, identity: 'billing' });
    const r = await rte.publish('chat/1', 'notice', { text: 'paid' });
    await rte.publish('chat/1', 'notice', 'again');
    expect(r).toMatchObject({ topic: 'chat/1', delivery: 'stream', id: `${EPOCH}:3` });
    const tokenCalls = node.calls.filter((c) => c.url.endsWith('/v1/token'));
    expect(tokenCalls).toHaveLength(1);
    expect(JSON.parse(new TextDecoder().decode(tokenCalls[0]!.body))).toMatchObject({ sub: 'billing', kind: 'service' });
    expect(node.calls.filter((c) => c.url.endsWith('/v1/publish')).every((c) => c.auth === 'Bearer tok-1')).toBe(true);
  });

  it('turns OpError into a RealtimeError and refuses signals', async () => {
    const node = fakeNode(() => ({ type: 'opError', code: Code.Forbidden, message: 'no', retryAfterMs: 0, topicId: 0n }));
    const rte = new Rest({ apiKey: 'rte_sk_x', url: 'http://localhost:3000', fetch: node.fetch });
    await expect(rte.publish('chat/1', 'm', 'x')).rejects.toMatchObject({ code: Code.Forbidden, topic: 'chat/1' });
    await expect(rte.publish('chat/1', 'typing', {}, { delivery: 'signal' })).rejects.toMatchObject({ code: Code.InvalidArgument });
  });

  it('refuses to run with a secret key in a browser', () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {});
    try {
      expect(() => new Rest({ apiKey: 'rte_sk_x', url: 'https://rte.example.com' })).toThrow(/never reach a browser/);
      expect(() => new Rest({ apiKey: 'rte_pk_x', url: 'https://rte.example.com' })).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
