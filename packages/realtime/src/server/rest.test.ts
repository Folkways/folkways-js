import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { decodeClientPacket, encodeServerPacket } from '../../test/support/server-codec';
import { Code } from '../shared/codes';
import { AckMode, type ClientFrame, type ServerMsg, joinLengthPrefixed } from '../transport';
import { Folkways, Rest } from './index';

const EPOCH = 1879046969544933376n;
const SEG = '00000000-0000-4000-8000-000000000042';
/** The key most tests sign with; the ones about signing make their own. */
const DEV = generateKeyPairSync('ed25519');
const DEV_KEY = DEV.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
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

const rest = (extra: Partial<ConstructorParameters<typeof Rest>[0]> = {}) =>
  new Rest({ url: 'http://localhost:9006', segment: SEG, signingKey: { kid: 'fixture-key', privateKey: DEV_KEY }, ...extra });

describe('Folkways.Rest', () => {
  it('rejects invalid UTF-8 event-name lengths before sending', async () => {
    const fetch = vi.fn();
    const api = rest({ fetch });
    for (const name of ['', 'a'.repeat(65), 'é'.repeat(33), '😀'.repeat(17)]) {
      await expect(api.publish('chat/lobby', name, 'x')).rejects.toMatchObject({ code: Code.InvalidArgument, local: true });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('signs tokens in process with an Ed25519 key, without calling the node', async () => {
    const key = await pair('EdDSA');
    const fetch = vi.fn();
    const folkways = new Folkways.Rest({ url: 'https://realtime.example.com/', segment: SEG, signingKey: { kid: 'backend-1', privateKey: key.privateKey }, fetch });
    const before = Math.floor(Date.now() / 1000);
    const t = await folkways.createToken({ identity: 'user:42', capabilities: [{ topics: 'chat/*', ops: ['subscribe', 'publish'] }], ttlMs: 120_000 });

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
    expect(t.jti).toBe(claims.jti);
  });

  it('signs with P-256 keys too', async () => {
    const key = await pair('ES256');
    const es = await rest({ signingKey: { kid: 'ec-1', privateKey: key.privateKey } }).createToken({ identity: 'agent:7', kind: 'agent' });
    expect(decode(es.token).header).toMatchObject({ alg: 'ES256', kid: 'ec-1' });
    expect(await key.verify(es.token)).toBe(true);
  });

  it('signs with a private JWK object', async () => {
    const jwk = DEV.privateKey.export({ format: 'jwk' }) as JsonWebKey;
    const t = await rest({ signingKey: { kid: 'jwk-1', privateKey: jwk } }).createToken({ identity: 'alice' });
    const { header, input, sig } = decode(t.token);
    expect(header).toMatchObject({ alg: 'EdDSA', kid: 'jwk-1' });
    expect(verify(null, input, DEV.publicKey, sig)).toBe(true);
  });

  it('mints anonymous tokens without a sub, and caps the lifetime at 15 minutes', async () => {
    const t = await rest().createToken({ kind: 'anonymous', ttlMs: 86_400_000 });
    const { claims } = decode(t.token);
    expect(claims).not.toHaveProperty('sub');
    expect(claims.kind).toBe('anonymous');
    expect((claims.exp as number) - (claims.iat as number)).toBe(900);
    expect(t.identity).toBeNull();
    expect(t.jti).toBe(claims.jti);
  });

  it('exposes a unique signed token identifier for every issued token', async () => {
    const api = rest();
    const issued = await Promise.all([
      api.createToken({ identity: 'alice' }),
      api.createToken({ identity: 'alice' }),
      api.createToken({ kind: 'anonymous' }),
      api.createToken({ kind: 'service', identity: 'backend' }),
      api.createToken({ kind: 'agent', identity: 'agent:1' }),
    ]);
    expect(new Set(issued.map(t => t.jti)).size).toBe(issued.length);
    for (const t of issued) {
      const signed = decode(t.token);
      expect(t.jti).toBe(signed.claims.jti);
      expect(verify(null, signed.input, DEV.publicKey, signed.sig)).toBe(true);
    }
  });

  it('refuses tokens the node would refuse', async () => {
    const folkways = rest();
    await expect(folkways.createToken({})).rejects.toMatchObject({ code: Code.InvalidArgument, message: expect.stringContaining('identity is required') });
    await expect(folkways.createToken({ kind: 'anonymous', identity: 'bob' })).rejects.toMatchObject({ code: Code.InvalidArgument });
    await expect(folkways.createToken({ identity: 'anon:1' })).rejects.toMatchObject({ code: Code.InvalidArgument });
    await expect(folkways.createToken({ identity: 'x'.repeat(257) })).rejects.toMatchObject({ code: Code.InvalidArgument });
    await expect(folkways.createToken({ identity: 'a', capabilities: [{ topics: 'chat/>', ops: [] }] })).rejects.toMatchObject({ code: Code.InvalidArgument });
  });

  it('reports a key it cannot use when signing', async () => {
    const pub = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA\n-----END PUBLIC KEY-----';
    await expect(rest({ signingKey: { kid: 'k', privateKey: pub } }).createToken({ identity: 'a' })).rejects.toMatchObject({
      message: expect.stringContaining('is a public key; give the private key (the one the dashboard showed once'),
    });
    await expect(rest({ signingKey: { kid: 'k', privateKey: 'an-old-hs256-shared-secret-0123456789' } }).createToken({ identity: 'a' })).rejects.toMatchObject({
      message: expect.stringContaining('shared secrets (HS256) are no longer supported'),
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
    const folkways = rest({ fetch: node.fetch, identity: 'billing' });
    const r = await folkways.publish('chat/1', 'notice', { text: 'paid' });
    await folkways.publish('chat/1', 'notice', 'again');
    expect(r).toMatchObject({ topic: 'chat/1', delivery: 'stream', id: `${EPOCH}:3` });
    expect(node.calls.every((c) => c.url === 'http://localhost:9006/v1/publish')).toBe(true);
    // One token, cached across publishes
    expect(new Set(tokens).size).toBe(1);
    const { input, sig } = decode(tokens[0]!);
    expect(verify(null, input, DEV.publicKey, sig)).toBe(true);
    expect(decode(tokens[0]!).claims).toMatchObject({ seg: SEG, sub: 'billing', kind: 'service', cap: [{ topic: '>', ops: ['publish'] }] });
  });

  it('publishes to a personal topic with the configured service capability and returns the receipt', async () => {
    const target = '$user/user:42';
    const node = fakeNode((f, token) => {
      expect(f.msg).toMatchObject({ type: 'publish', publish: { topic: { name: target }, name: 'notice', ack: AckMode.Accepted } });
      const signed = decode(token);
      expect(verify(null, signed.input, DEV.publicKey, signed.sig)).toBe(true);
      expect(signed.claims).toMatchObject({ seg: SEG, sub: 'billing', kind: 'service', cap: [{ topic: target, ops: ['publish'] }] });
      return { type: 'pubAck', topicId: 1n, level: AckMode.Accepted, cursor: { epoch: EPOCH, seq: 3n }, duplicate: false, serverTsMs: 9 };
    });
    const api = rest({ fetch: node.fetch, identity: 'billing', capabilities: [{ topics: target, ops: ['publish'] }] });
    await expect(api.publish(target, 'notice', { text: 'paid' })).resolves.toMatchObject({ topic: target, delivery: 'stream', id: `${EPOCH}:3` });
    expect(node.calls).toHaveLength(1);
  });

  it('rejects invalid personal topics and other reserved topics before sending', async () => {
    const fetch = vi.fn();
    const api = rest({ fetch });
    for (const target of ['$user/', '$user/a/b', '$user/a b', '$user/é', '$user/*', '$user/>', '$user/' + 'a'.repeat(246), '$online/user:42', '$presence/chat/1', '$other/a']) {
      await expect(api.publish(target, 'notice', 'x')).rejects.toMatchObject({ code: Code.InvalidTopic, local: true });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves a service denial for personal topics without widening token rights or retrying', async () => {
    const target = '$user/user:42';
    const node = fakeNode((f, token) => {
      expect(f.msg).toMatchObject({ type: 'publish', publish: { topic: { name: target } } });
      expect(decode(token).claims.cap).toEqual([{ topic: 'chat/>', ops: ['publish'] }]);
      return { type: 'opError', code: Code.Forbidden, message: 'not allowed', retryAfterMs: 0, topicId: 0n };
    }, 403);
    const api = rest({ fetch: node.fetch, capabilities: [{ topics: 'chat/>', ops: ['publish'] }] });
    await expect(api.publish(target, 'notice', 'x')).rejects.toMatchObject({ code: Code.Forbidden, topic: target });
    expect(node.calls).toHaveLength(1);
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

  it('does not replace a revoked service token or retry the publish', async () => {
    const node = fakeNode(() => ({ type: 'close', code: Code.AuthRevoked, reason: 'revoked', retryAfterMs: 0 }), 401);
    const service = rest({ fetch: node.fetch });
    await expect(service.publish('chat/1', 'm', 'x')).rejects.toMatchObject({
      code: Code.AuthRevoked,
      message: 'AuthRevoked: revoked',
    });
    await expect(service.publish('chat/1', 'm', 'again')).rejects.toMatchObject({ code: Code.AuthRevoked });
    expect(node.calls).toHaveLength(1);
  });

  it('turns OpError into a RealtimeError and refuses signals', async () => {
    const node = fakeNode(() => ({ type: 'opError', code: Code.Forbidden, message: 'no', retryAfterMs: 0, topicId: 0n }));
    const folkways = rest({ fetch: node.fetch });
    await expect(folkways.publish('chat/1', 'm', 'x')).rejects.toMatchObject({ code: Code.Forbidden, topic: 'chat/1' });
    await expect(folkways.publish('chat/1', 'typing', {}, { delivery: 'signal' })).rejects.toMatchObject({ code: Code.InvalidArgument });
  });

  it('refuses API keys and bad options with a pointer to signing keys', () => {
    expect(() => new Rest({ apiKey: 'rte_sk_x.y', url: 'http://localhost:9006' } as never)).toThrow(/secret API keys/);
    expect(() => rest({ signingKey: { kid: 'k', privateKey: 'rte_sk_backend.0123456789abcdef0123456789abcdef' } })).toThrow(/API key/);
    expect(() => rest({ segment: 'Local Dev' })).toThrow(/segment id/);
    expect(() => rest({ signingKey: { kid: '', privateKey: DEV_KEY } })).toThrow(/kid/);
    expect(() => rest({ signingKey: { kid: 'k', privateKey: '  ' } })).toThrow(/privateKey/);
    expect(() => rest({ url: 'realtime.example.com' })).toThrow(/url/);
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
