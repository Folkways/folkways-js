import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { Code, Rest, type DmOpened } from './index';
import type { FetchLike } from '../transport/http';

const key = generateKeyPairSync('ed25519');
const segment = '00000000-0000-4000-8000-000000000042';
const options = {
  url: 'https://realtime.example.com/',
  segment,
  signingKey: { kid: 'fixture-key', privateKey: key.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string },
  capabilities: [{ topics: 'dm/>', ops: ['publish'] as const }, { topics: '$user/>', ops: ['publish'] as const }],
};
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const members = ['alice', 'bob'];
const topic = 'dm/0123456789abcdef01234567';
function opened(duplicate = false, room = topic): DmOpened {
  return { topic: room, members, invites: members.map(identity => ({ identity, topic: '$user/' + identity, duplicate })) };
}
function response(status: number, body: unknown) {
  return {
    status,
    headers: { get: (name: string) => name === 'content-type' ? 'application/json' : null },
    arrayBuffer: async () => encoder.encode(JSON.stringify(body)).buffer as ArrayBuffer,
  };
}

describe('backend direct message rooms', () => {
  it('sends canonical distinct members and signed scoped credentials, and returns service deduplication flags', async () => {
    const bodies: unknown[] = [];
    const tokens: string[] = [];
    const fetch: FetchLike = vi.fn(async (url, init) => {
      expect(url).toBe('https://realtime.example.com/v1/dm/open');
      expect(init.method).toBe('POST');
      expect(init.headers['Content-Type']).toBe('application/json');
      const token = init.headers.Authorization!.slice(7);
      const [header, claims, signature] = token.split('.');
      expect(verify(null, Buffer.from(`${header}.${claims}`), key.publicKey, Buffer.from(signature!, 'base64url'))).toBe(true);
      expect(JSON.parse(Buffer.from(claims!, 'base64url').toString())).toMatchObject({
        seg: segment, kind: 'service', cap: [{ topic: 'dm/>', ops: ['publish'] }, { topic: '$user/>', ops: ['publish'] }],
      });
      tokens.push(token);
      bodies.push(JSON.parse(decoder.decode(init.body)));
      return response(200, opened(bodies.length === 2));
    });
    const api = new Rest({ ...options, fetch });
    const first = await api.dm.open(['bob', 'alice', 'bob'], { data: { startedBy: 'alice', nested: [true, null, 1] } });
    const second = await api.dm.open(['alice', 'bob'], { data: { startedBy: 'alice', nested: [true, null, 1] } });
    expect(first).toEqual(opened());
    expect(second).toEqual(opened(true));
    expect(bodies).toEqual(Array(2).fill({ members, data: { startedBy: 'alice', nested: [true, null, 1] } }));
    expect(new Set(tokens).size).toBe(1);
    expect(Object.isFrozen(first.invites[0])).toBe(true);
  });

  it('supports a custom prefix and explicit null metadata', async () => {
    const room = 'support/teams/0123456789abcdef01234567';
    const fetch: FetchLike = vi.fn(async (_url, init) => {
      expect(JSON.parse(decoder.decode(init.body))).toEqual({ members, prefix: 'support/teams', data: null });
      return response(200, opened(false, room));
    });
    const api = new Rest({ ...options, fetch });
    expect((await api.dm.open(members, { prefix: 'support/teams', data: null })).topic).toBe(room);
  });

  it('validates distinct-member limits and identities, room prefix and JSON data locally', async () => {
    const fetch = vi.fn(async () => response(200, opened()));
    const api = new Rest({ ...options, fetch });
    for (const ids of [[], ['alice'], ['alice', 'alice'], ['alice', 'anon:bob'], ['alice', 'a/b'], ['alice', 'é'], ['alice', 'a\n'], ['alice', 'a'.repeat(246)], Array.from({ length: 51 }, (_, i) => 'u' + i)]) {
      await expect(api.dm.open(ids)).rejects.toMatchObject({ code: Code.InvalidArgument, local: true });
    }
    for (const prefix of ['', '$user/a', 'dm/*', 'a//b', 'a\n', 'a'.repeat(231), Array(16).fill('a').join('/')]) {
      await expect(api.dm.open(members, { prefix })).rejects.toMatchObject({ code: Code.InvalidTopic, local: true });
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const data of [1n, NaN, { missing: undefined }, cyclic]) {
      await expect(api.dm.open(members, { data: data as never })).rejects.toMatchObject({ code: Code.InvalidArgument, local: true });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('accepts fifty distinct identities after removing duplicates', async () => {
    const ids = Array.from({ length: 50 }, (_, i) => 'u' + i).sort();
    const fetch: FetchLike = vi.fn(async (_url, init) => {
      expect(JSON.parse(decoder.decode(init.body))).toEqual({ members: ids });
      return response(200, { topic, members: ids, invites: ids.map(identity => ({ identity, topic: '$user/' + identity, duplicate: false })) });
    });
    await expect(new Rest({ ...options, fetch }).dm.open([...ids, ...ids])).resolves.toMatchObject({ members: ids });
  });

  it.each([[403, Code.Forbidden], [429, Code.QuotaExceeded], [429, Code.RateLimited], [503, Code.Unavailable]])('preserves errors and never automatically repeats an invite request (%s/%s)', async (status, code) => {
    const fetch = vi.fn(async () => response(status, { code, message: 'refused', retry_after_ms: 1200 }));
    const api = new Rest({ ...options, fetch });
    await expect(api.dm.open(members)).rejects.toMatchObject({ code, retryAfterMs: 1200, local: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed success responses and invitations for the wrong identity', async () => {
    for (const body of [
      { ...opened(), topic: 'other/room' },
      { ...opened(), members: ['bob', 'alice'] },
      { ...opened(), invites: [{ identity: 'alice', topic: '$user/bob', duplicate: false }, opened().invites[1]] },
      { ...opened(), invites: [] },
      { ...opened(), invites: opened().invites.map(i => ({ ...i, duplicate: 'false' })) },
    ]) {
      const api = new Rest({ ...options, fetch: vi.fn(async () => response(200, body)) });
      await expect(api.dm.open(members)).rejects.toMatchObject({ code: Code.BadFrame });
    }
  });

  it('shares revocation with other backend operations', async () => {
    const fetch = vi.fn(async () => response(401, { code: Code.AuthRevoked, message: 'revoked' }));
    const api = new Rest({ ...options, fetch });
    await expect(api.dm.open(members)).rejects.toMatchObject({ code: Code.AuthRevoked });
    await expect(api.members.list(topic)).rejects.toMatchObject({ code: Code.AuthRevoked });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
