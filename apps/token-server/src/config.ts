import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SigningKey } from '@folkwaysio/realtime/server';

export interface Config {
  host: string;
  port: number;
  /** The node URL, e.g. `https://rte.example.com`. */
  rteUrl: string;
  /** The segment ID (a UUID). */
  segment: string;
  /** The signing key's `kid` and private half. Never log `privateKey`. */
  signingKey: SigningKey;
  /** Where the private key was read from, for log lines. */
  keySource: string;
  tokenTtlMs: number;
  sessionSecret: string;
  /** False when SESSION_SECRET was unset and a random secret was made. */
  sessionSecretFromEnv: boolean;
  /** Mark the sign-in cookie `Secure` (NODE_ENV=production). */
  secureCookies: boolean;
}

/** Every problem with the environment, one per line. */
export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join('\n'));
    this.name = 'ConfigError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KID = /^[A-Za-z0-9._-]{1,64}$/;
const KEY_VARS = ['RTE_PRIVATE_KEY_FILE', 'RTE_PRIVATE_KEY', 'RTE_SECRET'] as const;
const DEFAULT_TTL_SECONDS = 600;
/** The node refuses tokens that live longer than 15 minutes. */
const MAX_TTL_SECONDS = 900;
const MIN_TTL_SECONDS = 60;
const MIN_SESSION_SECRET_LENGTH = 32;

/**
 * Reads the server's settings from environment variables (`.env` is loaded
 * into them first). Relative paths are resolved against `cwd`.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): Config {
  const problems: string[] = [];
  const read = (name: string) => env[name]?.trim() ?? '';

  const rteUrl = read('RTE_URL');
  if (!rteUrl) problems.push("RTE_URL is not set: use the node URL from the segment's Connect tab");
  else if (!/^https?:\/\/[^/]/.test(rteUrl)) problems.push(`RTE_URL must start with https:// or http://, got "${rteUrl}"`);

  const segment = read('RTE_SEGMENT_ID');
  if (!segment) problems.push("RTE_SEGMENT_ID is not set: use the segment ID from the segment's Connect tab");
  else if (!UUID.test(segment)) problems.push(`RTE_SEGMENT_ID must be a UUID, got "${segment}"`);

  const kid = read('RTE_KEY_ID');
  if (!kid) problems.push("RTE_KEY_ID is not set: use the key ID (kid) from the segment's Signing keys tab");
  else if (!KID.test(kid)) problems.push(`RTE_KEY_ID must be 1 to 64 letters, digits, dots, dashes or underscores, got "${kid}"`);

  const key = readPrivateKey(env, cwd, problems);

  const ttlSeconds = readInt(read('RTE_TOKEN_TTL_SECONDS'), DEFAULT_TTL_SECONDS);
  if (ttlSeconds === undefined || ttlSeconds < MIN_TTL_SECONDS || ttlSeconds > MAX_TTL_SECONDS) {
    problems.push(`RTE_TOKEN_TTL_SECONDS must be a whole number from ${MIN_TTL_SECONDS} to ${MAX_TTL_SECONDS}`);
  }

  const port = readInt(read('PORT'), 8787);
  if (port === undefined || port < 0 || port > 65535) problems.push('PORT must be a port number');

  let sessionSecret = read('SESSION_SECRET');
  const sessionSecretFromEnv = sessionSecret.length > 0;
  if (sessionSecretFromEnv && sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
    problems.push(`SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters`);
  }
  if (!sessionSecretFromEnv) sessionSecret = randomBytes(32).toString('base64url');

  if (problems.length > 0 || !key) throw new ConfigError(problems);
  return {
    host: read('HOST') || '127.0.0.1',
    port: port!,
    rteUrl,
    segment,
    signingKey: { kid, privateKey: key.privateKey, ...(key.alg ? { alg: key.alg } : {}) },
    keySource: key.source,
    tokenTtlMs: ttlSeconds! * 1000,
    sessionSecret,
    sessionSecretFromEnv,
    secureCookies: env.NODE_ENV === 'production',
  };
}

interface PrivateKey {
  privateKey: string;
  alg?: 'HS256';
  source: string;
}

function readPrivateKey(env: NodeJS.ProcessEnv, cwd: string, problems: string[]): PrivateKey | undefined {
  const set = KEY_VARS.filter((name) => (env[name]?.trim() ?? '').length > 0);
  if (set.length === 0) {
    problems.push("Set RTE_PRIVATE_KEY_FILE, RTE_PRIVATE_KEY or RTE_SECRET to the signing key's private half");
    return undefined;
  }
  if (set.length > 1) {
    problems.push(`Set only one of RTE_PRIVATE_KEY_FILE, RTE_PRIVATE_KEY and RTE_SECRET; found ${set.join(', ')}`);
    return undefined;
  }
  const name = set[0]!;
  const value = env[name]!.trim();

  if (name === 'RTE_SECRET') {
    if (value.startsWith('-----BEGIN')) {
      problems.push('RTE_SECRET holds a PEM: put a private key in RTE_PRIVATE_KEY_FILE or RTE_PRIVATE_KEY');
      return undefined;
    }
    return { privateKey: value, alg: 'HS256', source: 'RTE_SECRET' };
  }

  let pem: string;
  let source: string;
  if (name === 'RTE_PRIVATE_KEY_FILE') {
    const path = resolve(cwd, value);
    try {
      pem = readFileSync(path, 'utf8').trim();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'unreadable';
      const hint = code === 'ENOENT' ? ': save the private key there, or point RTE_PRIVATE_KEY_FILE at it' : '';
      problems.push(`RTE_PRIVATE_KEY_FILE: cannot read ${value} (${code})${hint}`);
      return undefined;
    }
    source = value;
  } else {
    // Platforms that store secrets on one line keep the PEM's newlines as \n.
    pem = value.replace(/\\n/g, '\n');
    source = 'RTE_PRIVATE_KEY';
  }
  if (!pem.startsWith('-----BEGIN')) {
    problems.push(`${name}: expected a PEM private key (-----BEGIN PRIVATE KEY-----); for a shared secret, use RTE_SECRET`);
    return undefined;
  }
  if (pem.includes('PUBLIC KEY')) {
    problems.push(`${name}: this is the public key; the server needs the private key the dashboard showed you once`);
    return undefined;
  }
  return { privateKey: pem, source };
}

function readInt(value: string, fallback: number): number | undefined {
  if (value === '') return fallback;
  return /^\d+$/.test(value) ? Number(value) : undefined;
}
