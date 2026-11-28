import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { Code, Rest } from './index';
import type { FetchLike } from '../transport/http';

const key = generateKeyPairSync('ed25519');
const segment = '00000000-0000-4000-8000-000000000042';
const topic = 'private/room';
const encode = new TextEncoder();
const decode = new TextDecoder();
const options = {
  url: 'https://realtime.example.com/',
  segment,
  signingKey: { kid: 'fixture-key', privateKey: key.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string },
  capabilities: [{ topics: topic, ops: ['publish'] as const }],
};

function response(status: number, body?: unknown, headers: Record<string, string> = {}) {
  return {
    status,
    headers: { get: (name: string) => headers[name] ?? (name === 'content-type' ? 'application/json' : null) },
    arrayBuffer: async () => encode.encode(body === undefined ? '' : JSON.stringify(body)).buffer as ArrayBuffer,
  };
}

describe('backend topic membership', () => {
  it('uses the exact JSON contract, scoped signed credentials, and typed results', async () => {
    const requests: { path: string; body: unknown; token: string }[] = [];
    const fetch: FetchLike = vi.fn(async (url, init) => {
      expect(init.method).toBe('POST');
      expect(init.headers['Content-Type']).toBe('application/json');
      expect(init.headers.Accept).toBe('application/json');
      const token = init.headers.Authorization!.slice(7);
      const [header, claims, signature] = token.split('.');
      expect(verify(null, Buffer.from(`${header}.${claims}`), key.publicKey, Buffer.from(signature!, 'base64url'))).toBe(true);
      expect(JSON.parse(Buffer.from(claims!, 'base64url').toString())).toMatchObject({
        seg: segment, kind: 'service', cap: [{ topic, ops: ['publish'] }],
      });
      requests.push({ path: url, body: JSON.parse(decode.decode(init.body)), token });
      return url.endsWith('/list') ? response(200, { topic, members: [{ identity: 'bob', ops: ['subscribe'] }] }) : response(204);
    });
    const api = new Rest({ ...options, fetch });
    await expect(api.members.add(topic, ['alice', 'bob'], ['subscribe', 'publish'])).resolves.toBeUndefined();
    await expect(api.members.set(topic, 'bob', ['subscribe'])).resolves.toBeUndefined();
    await expect(api.members.remove(topic, ['alice'])).resolves.toBeUndefined();
    const result = await api.members.list(topic);
    expect(result).toEqual({ topic, members: [{ identity: 'bob', ops: ['subscribe'] }] });
    expect(Object.isFrozen(result.members[0]!.ops)).toBe(true);
    await expect(api.members.clear(topic)).resolves.toBeUndefined();
    expect(requests.map(({ path, body }) => [path, body])).toEqual([
      ['https://realtime.example.com/v1/members/add', { topic, identities: ['alice', 'bob'], ops: ['subscribe', 'publish'] }],
      ['https://realtime.example.com/v1/members/set', { topic, identity: 'bob', ops: ['subscribe'] }],
      ['https://realtime.example.com/v1/members/remove', { topic, identities: ['alice'] }],
      ['https://realtime.example.com/v1/members/list', { topic }],
      ['https://realtime.example.com/v1/members/clear', { topic }],
    ]);
    expect(new Set(requests.map(r => r.token)).size).toBe(1);
  });

  it('rejects invalid requests locally and enforces identity and batch boundaries', async () => {
    const fetch = vi.fn(async () => response(204));
    const api = new Rest({ ...options, fetch });
    for (const name of ['private/*', '$user/alice', 'private/']) {
      await expect(api.members.clear(name)).rejects.toMatchObject({ code: Code.InvalidArgument, local: true });
    }
    for (const identity of ['', 'anon:a', 'a/b', 'é', 'a\n', 'a'.repeat(246)]) {
      await expect(api.members.set(topic, identity, ['subscribe'])).rejects.toMatchObject({ code: Code.InvalidArgument, local: true });
    }
    await expect(api.members.add(topic, [], ['subscribe'])).rejects.toMatchObject({ code: Code.InvalidArgument });
    await expect(api.members.remove(topic, Array.from({length: 1001}, (_, i) => `u${i}`))).rejects.toMatchObject({ code: Code.InvalidArgument });
    await expect(api.members.set(topic, 'alice', [])).rejects.toMatchObject({ code: Code.InvalidArgument });
    await expect(api.members.set(topic, 'alice', ['unknown' as never])).rejects.toMatchObject({ code: Code.InvalidArgument });
    expect(fetch).not.toHaveBeenCalled();
    await api.members.add(topic, Array.from({length: 1000}, (_, i) => `u${i}`), ['subscribe']);
    await api.members.set(topic, 'a'.repeat(245), ['subscribe']);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    [403, Code.Forbidden], [429, Code.QuotaExceeded], [429, Code.RateLimited], [503, Code.Unavailable],
  ])('preserves service error %s/%s and does not retry mutations', async (status, code) => {
    const fetch = vi.fn(async () => response(status, { code, message: 'refused', retry_after_ms: 1234 }));
    const api = new Rest({ ...options, fetch });
    await expect(api.members.remove(topic, ['alice'])).rejects.toMatchObject({ code, topic, retryAfterMs: 1234, local: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('uses status and Retry-After when a gateway response is not JSON', async () => {
    const fetch = vi.fn(async () => response(429, 'gateway body', { 'content-type': 'text/plain', 'retry-after': '2' }));
    const api = new Rest({ ...options, fetch });
    await expect(api.members.list(topic)).rejects.toMatchObject({ code: Code.RateLimited, retryAfterMs: 2000 });
  });

  it('rejects malformed successful lists rather than returning unvalidated data', async () => {
    for (const body of [{ topic: 'private/other', members: [] }, { topic, members: [{ identity: 'alice', ops: ['invalid'] }] }, { topic }]) {
      const api = new Rest({ ...options, fetch: vi.fn(async () => response(200, body)) });
      await expect(api.members.list(topic)).rejects.toMatchObject({ code: Code.BadFrame });
    }
  });

  it('shares the terminal revocation latch with publishing and never replaces the credential automatically', async () => {
    const fetch = vi.fn(async () => response(401, { code: Code.AuthRevoked, message: 'revoked' }));
    const api = new Rest({ ...options, fetch });
    await expect(api.members.clear(topic)).rejects.toMatchObject({ code: Code.AuthRevoked });
    await expect(api.members.list(topic)).rejects.toMatchObject({ code: Code.AuthRevoked });
    await expect(api.publish(topic, 'message', 'x')).rejects.toMatchObject({ code: Code.AuthRevoked });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('aborts a timed-out request without retrying', async () => {
    const fetch: FetchLike = vi.fn(async (_url, init) => new Promise<never>((_resolve, reject) => {
      const abort = () => reject(new Error('aborted'));
      if (init.signal?.aborted) abort();
      else init.signal?.addEventListener('abort', abort, { once: true });
    }));
    const api = new Rest({ ...options, fetch, timeoutMs: 20 });
    await expect(api.members.clear(topic)).rejects.toMatchObject({ code: Code.Timeout, local: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
