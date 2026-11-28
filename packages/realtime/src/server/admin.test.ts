import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { Code, Rest } from './index';
import type { FetchLike } from '../transport/http';

const key = generateKeyPairSync('ed25519');
const segment = '00000000-0000-4000-8000-000000000042';
const options = {
  url: 'https://realtime.example.com/',
  segment,
  signingKey: { kid: 'fixture-key', privateKey: key.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string },
  capabilities: [{ topics: '$user/>', ops: ['publish'] as const }],
};
const encoder = new TextEncoder();
const decoder = new TextDecoder();
function response(status: number, body?: unknown) {
  return {
    status,
    headers: { get: (name: string) => name === 'content-type' ? 'application/json' : null },
    arrayBuffer: async () => encoder.encode(body === undefined ? '' : JSON.stringify(body)).buffer as ArrayBuffer,
  };
}
function claims(token: string): Record<string, unknown> {
  const [header, payload, signature] = token.split('.');
  expect(verify(null, Buffer.from(`${header}.${payload}`), key.publicKey, Buffer.from(signature!, 'base64url'))).toBe(true);
  return JSON.parse(Buffer.from(payload!, 'base64url').toString()) as Record<string, unknown>;
}

describe('backend kick and revoke', () => {
  it('sends scoped signed service credentials and exact JSON bodies, accepting 204 without a body', async () => {
    const requests: { url: string; body: unknown; token: string }[] = [];
    const fetch: FetchLike = vi.fn(async (url, init) => {
      const token = init.headers.Authorization!.slice(7);
      expect(init.method).toBe('POST');
      expect(init.headers['Content-Type']).toBe('application/json');
      expect(claims(token)).toMatchObject({ seg: segment, kind: 'service', cap: [{ topic: '$user/>', ops: ['publish'] }] });
      requests.push({ url, body: JSON.parse(decoder.decode(init.body)), token });
      return response(204);
    });
    const api = new Rest({ ...options, fetch });
    const issued = await api.createToken({ identity: 'alice' });
    await expect(api.kick('alice')).resolves.toBeUndefined();
    await expect(api.revoke(issued.jti)).resolves.toBeUndefined();
    expect(requests.map(({ url, body }) => [url, body])).toEqual([
      ['https://realtime.example.com/v1/kick', { identity: 'alice' }],
      ['https://realtime.example.com/v1/revoke', { jti: issued.jti }],
    ]);
    expect(new Set(requests.map(r => r.token)).size).toBe(1);
  });

  it('validates identity and UTF-8 token identifier limits before any request', async () => {
    const fetch = vi.fn(async () => response(204));
    const api = new Rest({ ...options, fetch });
    for (const identity of ['', 'anon:a', 'a/b', 'é', 'a\n', 'a'.repeat(246)]) {
      await expect(api.kick(identity)).rejects.toMatchObject({ code: Code.InvalidArgument, local: true });
    }
    for (const jti of ['', 'a'.repeat(257), 'é'.repeat(129), '😀'.repeat(65), null as never]) {
      await expect(api.revoke(jti)).rejects.toMatchObject({ code: Code.InvalidArgument, local: true });
    }
    expect(fetch).not.toHaveBeenCalled();
    await api.kick('a'.repeat(245));
    await api.revoke('é'.repeat(128));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not widen credentials or retry a denied revocation', async () => {
    const fetch: FetchLike = vi.fn(async (_url, init) => {
      expect(claims(init.headers.Authorization!.slice(7))).toMatchObject({ cap: [{ topic: '$user/alice', ops: ['publish'] }] });
      return response(403, { code: Code.Forbidden, message: 'not allowed' });
    });
    const api = new Rest({ ...options, capabilities: [{ topics: '$user/alice', ops: ['publish'] }], fetch });
    await expect(api.revoke('token-id')).rejects.toMatchObject({ code: Code.Forbidden, local: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([[401, Code.AuthExpired], [429, Code.QuotaExceeded], [429, Code.RateLimited], [503, Code.Unavailable]])('preserves service errors without automatic retries (%s/%s)', async (status, code) => {
    const fetch = vi.fn(async () => response(status, { code, message: 'refused', retry_after_ms: 1200 }));
    const api = new Rest({ ...options, fetch });
    await expect(api.revoke('token-id')).rejects.toMatchObject({ code, retryAfterMs: 1200, local: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects an unexpected success status', async () => {
    const api = new Rest({ ...options, fetch: vi.fn(async () => response(200, {})) });
    await expect(api.kick('alice')).rejects.toMatchObject({ code: Code.BadFrame });
  });

  it('latches explicit credential revocation across backend operations', async () => {
    const fetch = vi.fn(async () => response(401, { code: Code.AuthRevoked, message: 'revoked' }));
    const api = new Rest({ ...options, fetch });
    await expect(api.kick('alice')).rejects.toMatchObject({ code: Code.AuthRevoked });
    await expect(api.revoke('other')).rejects.toMatchObject({ code: Code.AuthRevoked });
    await expect(api.members.list('private/room')).rejects.toMatchObject({ code: Code.AuthRevoked });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not mint a replacement after revoking its own cached credential', async () => {
    let jti: string | undefined;
    const fetch: FetchLike = vi.fn(async (_url, init) => {
      const signed = claims(init.headers.Authorization!.slice(7));
      jti ??= signed.jti as string;
      expect(signed.jti).toBe(jti);
      return response(204);
    });
    const api = new Rest({ ...options, fetch });
    await api.kick('alice');
    await api.revoke(jti!);
    await expect(api.kick('bob')).rejects.toMatchObject({ code: Code.AuthRevoked });
    await expect(api.publish('chat/1', 'message', 'x')).rejects.toMatchObject({ code: Code.AuthRevoked });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
