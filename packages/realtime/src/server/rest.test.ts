import { describe, expect, it, vi } from 'vitest';

import { decodeClientPacket, encodeServerPacket } from '../../test/support/server-codec';
import { Code } from '../shared/codes';
import { AckMode, type ClientFrame, type ServerMsg, joinLengthPrefixed } from '../transport';
import { Folkways, Rest } from './index';

const EPOCH = 1879046969544933376n;
const SEG = 'c7e5a92b-62a1-4b14-bd8f-8bb74c77d3ff';
const SECRET = 'dev-only-secret-change-me-0123456789';
const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

type Call = { url: string; auth: string; body: Uint8Array };

/** A node answering /v1/publish with frames; it has no /v1/token for Rest to call. */
function fakeNode(answer: (frame: ClientFrame, token: string) => ServerMsg, status = 200) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string, init: { headers: Record<string, string>; body: Uint8Array }) => {
    const auth = init.headers.Authorization ?? init.headers.authorization ?? '';
    calls.push({ url, auth, body: init.body });
    if (!url.endsWith('/v1/publish')) throw new Error(`unexpected call to ${url}`);
    const [frame] = decodeClientPacket(init.body);
    const packet = encodeServerPacket([{ corr: frame!.corr, msg: answer(frame!, auth.slice(7)) }]);
    return {
      status,
      headers: { get: (n: string) => (n === 'content-type' ? 'application/octet-stream' : null) },
      arrayBuffer: async () => joinLengthPrefixed([packet]).buffer as ArrayBuffer,
    };
  });
  return { fetch, calls };
}

function b64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function decode(token: string): { header: Record<string, unknown>; claims: Record<string, unknown>; input: Uint8Array<ArrayBuffer>; sig: Uint8Array<ArrayBuffer> } {
  const [h, p, s] = token.split('.');
  return { header: JSON.parse(dec.decode(b64url(h!))), claims: JSON.parse(dec.decode(b64url(p!))), input: enc.encode(`${h}.${p}`), sig: b64url(s!) };
}

function pem(der: ArrayBuffer): string {
  const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  return `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`;
}

/** A fresh key pair as the dashboard hands it out: PKCS#8 PEM private key, public key to verify with. */
async function pair(alg: 'EdDSA' | 'ES256') {
  const params = alg === 'EdDSA' ? { name: 'Ed25519' } : { name: 'ECDSA', namedCurve: 'P-256' };
  const keys = (await subtle.generateKey(params, true, ['sign', 'verify'])) as CryptoKeyPair;
  const verifyParams = alg === 'EdDSA' ? { name: 'Ed25519' } : { name: 'ECDSA', hash: 'SHA-256' };
  return {
    privateKey: pem(await subtle.exportKey('pkcs8', keys.privateKey)),
    verify: (token: string) => {
      const { input, sig } = decode(token);
      return subtle.verify(verifyParams, keys.publicKey, sig, input);
    },
  };
}

async function hs256Verify(token: string, secret: string): Promise<boolean> {
  const key = await subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const { input, sig } = decode(token);
  return subtle.verify('HMAC', key, sig, input);
}

const rest = (extra: Partial<ConstructorParameters<typeof Rest>[0]> = {}) =>
  new Rest({ url: 'http://localhost:3000', segment: SEG, signingKey: { kid: 'dev-1', privateKey: SECRET }, ...extra });

describe('Folkways.Rest', () => {
  it('signs tokens in process with an Ed25519 key, without calling the node', async () => {
    const key = await pair('EdDSA');
    const fetch = vi.fn();
    const rte = new Folkways.Rest({ url: 'https://rte.example.com/', segment: SEG, signingKey: { kid: 'backend-1', privateKey: key.privateKey }, fetch });
    const before = Math.floor(Date.now() / 1000);
    const t = await rte.createToken({ identity: 'user:42', capabilities: [{ topics: 'chat/*', ops: ['subscribe', 'publish'] }], ttlMs: 120_000 });

    expect(fetch).not.toHaveBeenCalled();
    expect(t).toMatchObject({ identity: 'user:42', kind: 'user', capabilities: [{ topics: 'chat/*', ops: ['subscribe', 'publish'] }] });
    expect(await key.verify(t.token)).toBe(true);
    const { header, claims } = decode(t.token);
    expect(header).toEqual({ alg: 'EdDSA', kid: 'backend-1', typ: 'JWT' });
    expect(claims).toMatchObject({ seg: SEG, sub: 'user:42', kind: 'user', cap: [{ topic: 'chat/*', ops: ['subscribe', 'publish'] }] });
    expect(claims.exp).toBe((claims.iat as number) + 120);
    expect(claims.iat as number).toBeGreaterThanOrEqual(before);
    expect(t.expiresAt).toBe((claims.exp as number) * 1000);
    expect(claims.jti).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('signs with P-256 and HS256 keys too', async () => {
    const key = await pair('ES256');
    const es = await rest({ signingKey: { kid: 'ec-1', privateKey: key.privateKey } }).createToken({ identity: 'agent:7', kind: 'agent' });
    expect(decode(es.token).header).toMatchObject({ alg: 'ES256', kid: 'ec-1' });
    expect(await key.verify(es.token)).toBe(true);

    const hs = await rest().createToken({ identity: 'alice' });
    expect(decode(hs.token).header).toMatchObject({ alg: 'HS256', kid: 'dev-1' });
    expect(await hs256Verify(hs.token, SECRET)).toBe(true);
  });

  it('mints anonymous tokens without a sub, and caps the lifetime at 15 minutes', async () => {
    const t = await rest().createToken({ kind: 'anonymous', ttlMs: 86_400_000 });
    const { claims } = decode(t.token);
    expect(claims).not.toHaveProperty('sub');
    expect(claims.kind).toBe('anonymous');
    expect((claims.exp as number) - (claims.iat as number)).toBe(900);
    expect(t.identity).toBeNull();
  });

  it('refuses tokens the node would refuse', async () => {
    const rte = rest();
    await expect(rte.createToken({})).rejects.toMatchObject({ code: Code.InvalidArgument, message: expect.stringContaining('identity is required') });
    await expect(rte.createToken({ kind: 'anonymous', identity: 'bob' })).rejects.toMatchObject({ code: Code.InvalidArgument });
    await expect(rte.createToken({ identity: 'anon:1' })).rejects.toMatchObject({ code: Code.InvalidArgument });
    await expect(rte.createToken({ identity: 'x'.repeat(257) })).rejects.toMatchObject({ code: Code.InvalidArgument });
    await expect(rte.createToken({ identity: 'a', capabilities: [{ topics: 'chat/>', ops: [] }] })).rejects.toMatchObject({ code: Code.InvalidArgument });
  });

  it('reports a key it cannot use when signing', async () => {
    const pub = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA\n-----END PUBLIC KEY-----';
    await expect(rest({ signingKey: { kid: 'k', privateKey: pub } }).createToken({ identity: 'a' })).rejects.toMatchObject({
      message: expect.stringContaining('is a public key; give the private key (the one the dashboard showed once'),
    });
    await expect(rest({ signingKey: { kid: 'k', alg: 'EdDSA', privateKey: SECRET } }).createToken({ identity: 'a' })).rejects.toMatchObject({
      message: expect.stringContaining('not a PEM'),
    });
    await expect(rest({ signingKey: { kid: 'k', privateKey: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----' } }).createToken({ identity: 'a' })).rejects.toMatchObject({
      code: Code.InvalidArgument,
    });
  });

  it('publishes over HTTP with its own signed service token and resolves with the receipt', async () => {
    const tokens: string[] = [];
    const node = fakeNode((f, token) => {
      tokens.push(token);
      expect(f.msg).toMatchObject({ type: 'publish', publish: { topic: { name: 'chat/1' }, name: 'notice', ack: AckMode.Accepted } });
      return { type: 'pubAck', topicId: 1n, level: AckMode.Accepted, cursor: { epoch: EPOCH, seq: 3n }, duplicate: false, serverTsMs: 9 };
    });
    const rte = rest({ fetch: node.fetch, identity: 'billing' });
    const r = await rte.publish('chat/1', 'notice', { text: 'paid' });
    await rte.publish('chat/1', 'notice', 'again');
    expect(r).toMatchObject({ topic: 'chat/1', delivery: 'stream', id: `${EPOCH}:3` });
    expect(node.calls.every((c) => c.url === 'http://localhost:3000/v1/publish')).toBe(true);
    // One token, cached across publishes
    expect(new Set(tokens).size).toBe(1);
    expect(await hs256Verify(tokens[0]!, SECRET)).toBe(true);
    expect(decode(tokens[0]!).claims).toMatchObject({ seg: SEG, sub: 'billing', kind: 'service', cap: [{ topic: '>', ops: ['publish'] }] });
  });

  it('signs a new service token when the node refuses the cached one', async () => {
    let first = true;
    const node = fakeNode(() => {
      if (first) {
        first = false;
        return { type: 'close', code: Code.AuthExpired, reason: 'expired', retryAfterMs: 0 };
      }
      return { type: 'pubAck', topicId: 1n, level: AckMode.Accepted, cursor: { epoch: EPOCH, seq: 1n }, duplicate: false, serverTsMs: 1 };
    });
    const calls: string[] = [];
    const fetch = vi.fn(async (url: string, init: { headers: Record<string, string>; body: Uint8Array }) => {
      calls.push(init.headers.Authorization ?? '');
      const res = await node.fetch(url, init);
      return calls.length === 1 ? { ...res, status: 401 } : res;
    });
    const r = await rest({ fetch, capabilities: [{ topics: 'chat/>', ops: ['publish'] }] }).publish('chat/1', 'm', 'x');
    expect(r.id).toBe(`${EPOCH}:1`);
    expect(calls).toHaveLength(2);
    expect(calls[0]).not.toBe(calls[1]);
    expect(decode(calls[1]!.slice(7)).claims.cap).toEqual([{ topic: 'chat/>', ops: ['publish'] }]);
  });

  it('turns OpError into a RealtimeError and refuses signals', async () => {
    const node = fakeNode(() => ({ type: 'opError', code: Code.Forbidden, message: 'no', retryAfterMs: 0, topicId: 0n }));
    const rte = rest({ fetch: node.fetch });
    await expect(rte.publish('chat/1', 'm', 'x')).rejects.toMatchObject({ code: Code.Forbidden, topic: 'chat/1' });
    await expect(rte.publish('chat/1', 'typing', {}, { delivery: 'signal' })).rejects.toMatchObject({ code: Code.InvalidArgument });
  });

  it('refuses API keys and bad options with a pointer to signing keys', () => {
    expect(() => new Rest({ apiKey: 'rte_sk_x.y', url: 'http://localhost:3000' } as never)).toThrow(/ADR-008/);
    expect(() => rest({ signingKey: { kid: 'k', privateKey: 'rte_sk_backend.0123456789abcdef0123456789abcdef' } })).toThrow(/API key/);
    expect(() => rest({ segment: 'Local Dev' })).toThrow(/segment id/);
    expect(() => rest({ signingKey: { kid: '', privateKey: SECRET } })).toThrow(/kid/);
    expect(() => rest({ url: 'rte.example.com' })).toThrow(/url/);
  });

  it('refuses to run in a browser', () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {});
    try {
      expect(() => rest()).toThrow(/never run in a browser/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
