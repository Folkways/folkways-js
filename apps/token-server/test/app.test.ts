import { createHmac, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, verify } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { type Config, ConfigError, loadConfig } from '../src/config.js';

const SEGMENT = randomUUID();
const SECRET = randomBytes(32).toString('base64url');
const BASE_ENV = { RTE_URL: 'https://rte.example.com', RTE_SEGMENT_ID: SEGMENT, RTE_KEY_ID: 'backend-1' };

const dir = mkdtempSync(join(tmpdir(), 'token-server-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function decode(token: string) {
  const [header, claims, signature] = token.split('.');
  const json = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  return { header: json(header!), claims: json(claims!), input: `${header}.${claims}`, signature: signature! };
}

/** Starts the app on a free port and returns a fetch that keeps the session cookie, like a browser. */
async function start(config: Config) {
  const server = await new Promise<Server>((res) => {
    const s = createApp(config, undefined, () => {}).listen(0, '127.0.0.1', () => res(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0]!;
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : undefined };
  };
  return {
    call,
    setCookie: (value: string) => (cookie = value),
    getCookie: () => cookie,
    stop: () => new Promise<void>((res) => server.close(() => res())),
  };
}

describe('token endpoint (HS256)', () => {
  let app: Awaited<ReturnType<typeof start>>;
  beforeAll(async () => {
    app = await start(loadConfig({ ...BASE_ENV, RTE_SECRET: SECRET }, dir));
  });
  afterAll(() => app.stop());
  afterEach(() => app.setCookie(''));

  it('refuses a token to someone who has not signed in', async () => {
    const res = await app.call('POST', '/api/realtime-token', { reason: 'initial' });
    expect(res.status).toBe(401);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('signs a short-lived token for the signed-in user', async () => {
    expect((await app.call('POST', '/api/session', { name: 'alice' })).body).toEqual({ identity: 'user:alice' });
    expect((await app.call('GET', '/api/session')).body).toEqual({ identity: 'user:alice' });

    const res = await app.call('POST', '/api/realtime-token', { reason: 'initial' });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const { header, claims, input, signature } = decode(res.body.token);
    expect(header).toEqual({ alg: 'HS256', kid: 'backend-1', typ: 'JWT' });
    expect(claims).toMatchObject({
      seg: SEGMENT,
      sub: 'user:alice',
      kind: 'user',
      cap: [
        { topic: 'chat/>', ops: ['subscribe', 'publish'] },
        { topic: 'typing/>', ops: ['subscribe', 'signal'] },
      ],
    });
    expect(claims.exp - claims.iat).toBe(600);
    expect(res.body.expiresAt).toBe(claims.exp * 1000);
    expect(signature).toBe(createHmac('sha256', SECRET).update(input).digest('base64url'));
  });

  it('ignores a session cookie that was changed in the browser', async () => {
    await app.call('POST', '/api/session', { name: 'alice' });
    const [payload, mac] = app.getCookie().split('=')[1]!.split('.');
    const forged = Buffer.from(JSON.stringify({ name: 'admin', expiresAt: JSON.parse(Buffer.from(payload!, 'base64url').toString()).expiresAt })).toString('base64url');
    app.setCookie(`example_session=${forged}.${mac}`);
    expect((await app.call('POST', '/api/realtime-token')).status).toBe(401);
  });

  it('signs out', async () => {
    await app.call('POST', '/api/session', { name: 'alice' });
    expect((await app.call('DELETE', '/api/session')).status).toBe(204);
    expect((await app.call('GET', '/api/session')).body).toEqual({ identity: null });
    expect((await app.call('POST', '/api/realtime-token')).status).toBe(401);
  });

  it('refuses names that would make a bad identity', async () => {
    for (const name of ['', 'two words', 'anon:x', 'x'.repeat(33), 42]) {
      expect((await app.call('POST', '/api/session', { name })).status).toBe(400);
    }
    expect((await app.call('POST', '/api/session')).status).toBe(400);
  });
});

describe('token endpoint (Ed25519 key file)', () => {
  it('signs with the private key file, and the public key verifies the token', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    writeFileSync(join(dir, 'signing-key.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const app = await start(loadConfig({ ...BASE_ENV, RTE_PRIVATE_KEY_FILE: './signing-key.pem', RTE_TOKEN_TTL_SECONDS: '900' }, dir));
    try {
      await app.call('POST', '/api/session', { name: 'bob' });
      const res = await app.call('POST', '/api/realtime-token', { reason: 'expiring' });
      const { header, claims, input, signature } = decode(res.body.token);
      expect(header.alg).toBe('EdDSA');
      expect(claims.sub).toBe('user:bob');
      expect(claims.exp - claims.iat).toBe(900);
      expect(verify(null, Buffer.from(input), createPublicKey(publicKey.export({ type: 'spki', format: 'pem' })), Buffer.from(signature, 'base64url'))).toBe(true);
    } finally {
      await app.stop();
    }
  });
});

describe('loadConfig', () => {
  const problems = (env: NodeJS.ProcessEnv) => {
    try {
      loadConfig(env, dir);
    } catch (err) {
      if (err instanceof ConfigError) return err.problems.join('\n');
      throw err;
    }
    return '';
  };

  it('lists every missing setting at once', () => {
    const text = problems({});
    for (const name of ['RTE_URL', 'RTE_SEGMENT_ID', 'RTE_KEY_ID', 'RTE_PRIVATE_KEY_FILE']) expect(text).toContain(name);
  });

  it('takes exactly one private key setting', () => {
    expect(problems({ ...BASE_ENV, RTE_SECRET: SECRET, RTE_PRIVATE_KEY_FILE: './k.pem' })).toMatch(/only one of/);
  });

  it('reads a PEM with \\n escapes from RTE_PRIVATE_KEY', () => {
    const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const config = loadConfig({ ...BASE_ENV, RTE_PRIVATE_KEY: pem.trim().replace(/\n/g, '\\n') }, dir);
    expect(config.signingKey.privateKey).toBe(pem.trim());
    expect(config.keySource).toBe('RTE_PRIVATE_KEY');
  });

  it('explains a public key, a missing file and a PEM given as a secret', () => {
    const pub = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(problems({ ...BASE_ENV, RTE_PRIVATE_KEY: pub })).toMatch(/public key/);
    expect(problems({ ...BASE_ENV, RTE_PRIVATE_KEY_FILE: './missing.pem' })).toMatch(/cannot read .*ENOENT/);
    expect(problems({ ...BASE_ENV, RTE_SECRET: pub })).toMatch(/RTE_SECRET holds a PEM/);
  });

  it('keeps token lifetimes within what the node accepts', () => {
    expect(problems({ ...BASE_ENV, RTE_SECRET: SECRET, RTE_TOKEN_TTL_SECONDS: '901' })).toMatch(/RTE_TOKEN_TTL_SECONDS/);
    expect(problems({ ...BASE_ENV, RTE_SECRET: SECRET, RTE_TOKEN_TTL_SECONDS: '10m' })).toMatch(/RTE_TOKEN_TTL_SECONDS/);
  });

  it('checks the segment ID and node URL', () => {
    expect(problems({ ...BASE_ENV, RTE_SECRET: SECRET, RTE_SEGMENT_ID: 'my-segment' })).toMatch(/must be a UUID/);
    expect(problems({ ...BASE_ENV, RTE_SECRET: SECRET, RTE_URL: 'rte.example.com' })).toMatch(/RTE_URL must start/);
  });
});
