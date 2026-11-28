import { type KeyObject, generateKeyPairSync, randomUUID, verify } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, createRest } from '../src/app.js';
import { type Config, ConfigError, loadConfig } from '../src/config.js';

const SEGMENT = randomUUID();
/** The key most tests sign with, given to the server as FOLKWAYS_PRIVATE_KEY. */
const KEY = generateKeyPairSync('ed25519');
const KEY_PEM = KEY.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const BASE_ENV = { FOLKWAYS_URL: 'https://realtime.example.com', FOLKWAYS_SEGMENT_ID: SEGMENT, FOLKWAYS_KEY_ID: 'backend-1' };

const dir = mkdtempSync(join(tmpdir(), 'token-server-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function decode(token: string) {
  const [header, claims, signature] = token.split('.');
  const json = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  return { header: json(header!), claims: json(claims!), input: `${header}.${claims}`, signature: signature! };
}

/** True when `publicKey` verifies the token, as the node would (ES256 signatures are r‖s). */
function verifies(token: string, publicKey: KeyObject): boolean {
  const { header, input, signature } = decode(token);
  const digest = header.alg === 'ES256' ? 'sha256' : null;
  return verify(digest, Buffer.from(input), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'));
}

/** Starts the app on a free port and returns a fetch that sends `session` as a bearer, like the example app. */
async function start(config: Config) {
  const server = await new Promise<Server>((res) => {
    const s = createApp(config, undefined, () => {}).listen(0, '127.0.0.1', () => res(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, session?: string) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(session ? { authorization: `Bearer ${session}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : undefined };
  };
  const login = async (name: string) => (await call('POST', '/api/login', { name })).body.session as string;
  return { call, login, stop: () => new Promise<void>((res) => server.close(() => res())) };
}

describe('token endpoint', () => {
  let app: Awaited<ReturnType<typeof start>>;
  beforeAll(async () => {
    app = await start(loadConfig({ ...BASE_ENV, FOLKWAYS_PRIVATE_KEY: KEY_PEM }, dir));
  });
  afterAll(() => app.stop());

  it('refuses a token to someone who has not signed in', async () => {
    const res = await app.call('POST', '/api/realtime-token', { reason: 'initial' });
    expect(res.status).toBe(401);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('tells the app which node to connect to', async () => {
    const res = await app.call('GET', '/api/connection');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: 'https://realtime.example.com' });
  });

  it('signs in with a name', async () => {
    const res = await app.call('POST', '/api/login', { name: ' alice ' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'alice', identity: 'user:alice' });
    expect(typeof res.body.session).toBe('string');
    expect(res.body.expiresAt).toBeGreaterThan(Date.now());
  });

  it('signs a short-lived token for the signed-in user', async () => {
    const res = await app.call('POST', '/api/realtime-token', { reason: 'initial' }, await app.login('alice'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const { header, claims } = decode(res.body.token);
    expect(header).toEqual({ alg: 'EdDSA', kid: 'backend-1', typ: 'JWT' });
    expect(claims).toMatchObject({
      seg: SEGMENT,
      sub: 'user:alice',
      kind: 'user',
      cap: [
        { topic: 'chat/lobby', ops: ['subscribe', 'history', 'publish', 'set', 'signal', 'presence'] },
      ],
    });
    expect(claims.exp - claims.iat).toBe(600);
    expect(res.body.expiresAt).toBe(claims.exp * 1000);
    expect(verifies(res.body.token, KEY.publicKey)).toBe(true);
  });

  it('gives every sign-in with the same name the same identity', async () => {
    const [a, b] = [await app.login('alice'), await app.login('alice')];
    const sub = async (session: string) => decode((await app.call('POST', '/api/realtime-token', {}, session)).body.token).claims.sub;
    expect(await sub(a)).toBe('user:alice');
    expect(await sub(b)).toBe('user:alice');
  });

  it('ignores a session that was changed in the browser', async () => {
    const [payload, mac] = (await app.login('alice')).split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, 'base64url').toString()), name: 'admin' })).toString('base64url');
    expect((await app.call('POST', '/api/realtime-token', {}, `${forged}.${mac}`)).status).toBe(401);
    expect((await app.call('POST', '/api/realtime-token', {}, 'nonsense')).status).toBe(401);
  });

  it('refuses names that would make a bad identity', async () => {
    for (const name of ['', '  ', 'two words', 'anon:x', 'x'.repeat(33), 42]) {
      expect((await app.call('POST', '/api/login', { name })).status).toBe(400);
    }
    expect((await app.call('POST', '/api/login')).status).toBe(400);
  });
});

/** Signs one token through the app with the key in `env`, as the server does at startup and per request. */
async function tokenWith(env: NodeJS.ProcessEnv): Promise<string> {
  const app = await start(loadConfig({ ...BASE_ENV, ...env }, dir));
  try {
    const res = await app.call('POST', '/api/realtime-token', { reason: 'initial' }, await app.login('bob'));
    expect(res.status).toBe(200);
    return res.body.token as string;
  } finally {
    await app.stop();
  }
}

describe('the two ways to give the server its private key', () => {
  it('FOLKWAYS_PRIVATE_KEY_FILE: a path to the .pem, relative to the working directory', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    writeFileSync(join(dir, 'signing-key.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const config = loadConfig({ ...BASE_ENV, FOLKWAYS_PRIVATE_KEY_FILE: './signing-key.pem', FOLKWAYS_TOKEN_TTL_SECONDS: '900' }, dir);
    expect(config.keySource).toBe('./signing-key.pem');
    const token = await tokenWith({ FOLKWAYS_PRIVATE_KEY_FILE: './signing-key.pem', FOLKWAYS_TOKEN_TTL_SECONDS: '900' });
    const { header, claims } = decode(token);
    expect(header.alg).toBe('EdDSA');
    expect(claims.exp - claims.iat).toBe(900);
    expect(verifies(token, publicKey)).toBe(true);
  });

  it('FOLKWAYS_PRIVATE_KEY: the key itself, with real newlines or written as \\n', async () => {
    const config = loadConfig({ ...BASE_ENV, FOLKWAYS_PRIVATE_KEY: KEY_PEM }, dir);
    expect(config.keySource).toBe('FOLKWAYS_PRIVATE_KEY');
    expect(verifies(await tokenWith({ FOLKWAYS_PRIVATE_KEY: KEY_PEM }), KEY.publicKey)).toBe(true);
    expect(verifies(await tokenWith({ FOLKWAYS_PRIVATE_KEY: KEY_PEM.trim().replace(/\n/g, '\\n') }), KEY.publicKey)).toBe(true);
  });

  it('signs ES256 with a P-256 key, in PKCS#8 or SEC1, or as a bare base64 body', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const sec1 = privateKey.export({ type: 'sec1', format: 'pem' }) as string;
    const body = pkcs8.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
    for (const value of [pkcs8, sec1, body]) {
      const token = await tokenWith({ FOLKWAYS_PRIVATE_KEY: value });
      expect(decode(token).header.alg).toBe('ES256');
      expect(verifies(token, publicKey)).toBe(true);
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

  it('lists every missing setting at once, naming both key variables', () => {
    const text = problems({});
    for (const name of ['FOLKWAYS_URL', 'FOLKWAYS_SEGMENT_ID', 'FOLKWAYS_KEY_ID', 'FOLKWAYS_PRIVATE_KEY_FILE', 'FOLKWAYS_PRIVATE_KEY']) expect(text).toContain(name);
  });

  it('takes exactly one private key setting', () => {
    expect(problems({ ...BASE_ENV, FOLKWAYS_PRIVATE_KEY: KEY_PEM, FOLKWAYS_PRIVATE_KEY_FILE: './k.pem' })).toMatch(/only one of/);
  });

  it('spots a key in the file variable and a path in the key variable', () => {
    expect(problems({ ...BASE_ENV, FOLKWAYS_PRIVATE_KEY_FILE: KEY_PEM })).toMatch(/holds a key, not a path.*FOLKWAYS_PRIVATE_KEY/);
    expect(problems({ ...BASE_ENV, FOLKWAYS_PRIVATE_KEY: './secrets/signing-key.pem' })).toMatch(/looks like a file path.*FOLKWAYS_PRIVATE_KEY_FILE/);
  });

  it('explains a missing key file', () => {
    expect(problems({ ...BASE_ENV, FOLKWAYS_PRIVATE_KEY_FILE: './missing.pem' })).toMatch(/cannot read .*ENOENT.*point FOLKWAYS_PRIVATE_KEY_FILE at it/);
  });

  it('keeps token lifetimes within what the node accepts', () => {
    expect(problems({ ...BASE_ENV, FOLKWAYS_PRIVATE_KEY: KEY_PEM, FOLKWAYS_TOKEN_TTL_SECONDS: '901' })).toMatch(/FOLKWAYS_TOKEN_TTL_SECONDS/);
    expect(problems({ ...BASE_ENV, FOLKWAYS_PRIVATE_KEY: KEY_PEM, FOLKWAYS_TOKEN_TTL_SECONDS: '10m' })).toMatch(/FOLKWAYS_TOKEN_TTL_SECONDS/);
  });

  it('checks the segment ID and node URL', () => {
    expect(problems({ ...BASE_ENV, FOLKWAYS_PRIVATE_KEY: KEY_PEM, FOLKWAYS_SEGMENT_ID: 'my-segment' })).toMatch(/must be a UUID/);
    expect(problems({ ...BASE_ENV, FOLKWAYS_PRIVATE_KEY: KEY_PEM, FOLKWAYS_URL: 'realtime.example.com' })).toMatch(/FOLKWAYS_URL must start/);
    expect(problems({ ...BASE_ENV, FOLKWAYS_PRIVATE_KEY: KEY_PEM, FOLKWAYS_WS_URL: 'http://127.0.0.1:9005/v1/ws' })).toMatch(/FOLKWAYS_WS_URL must start/);
  });

  it('hands the app a separate WebSocket URL when one is set', async () => {
    const app = await start(loadConfig({ ...BASE_ENV, FOLKWAYS_PRIVATE_KEY: KEY_PEM, FOLKWAYS_WS_URL: 'ws://127.0.0.1:9005/v1/ws' }, dir));
    try {
      const res = await app.call('GET', '/api/connection');
      expect(res.body).toEqual({ url: 'https://realtime.example.com', endpoints: { websocket: 'ws://127.0.0.1:9005/v1/ws' } });
    } finally {
      await app.stop();
    }
  });
});

describe('a key that cannot sign is caught before the first user asks', () => {
  // server.ts signs one token with createRest at startup and exits with the SDK's message
  const startupError = (privateKey: string) =>
    createRest(loadConfig({ ...BASE_ENV, FOLKWAYS_PRIVATE_KEY: privateKey }, dir)).createToken({ identity: 'token-server', kind: 'service' });

  it('the public half of the key', async () => {
    const pub = KEY.publicKey.export({ type: 'spki', format: 'pem' }) as string;
    await expect(startupError(pub)).rejects.toThrow(/is a public key/);
  });

  it('an old HS256 shared secret moved into FOLKWAYS_PRIVATE_KEY', async () => {
    await expect(startupError('dev-only-secret-change-me-0123456789')).rejects.toThrow(/shared secrets \(HS256\) are no longer supported/);
  });
});
