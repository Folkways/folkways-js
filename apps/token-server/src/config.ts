import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SigningKey } from '@folkwaysio/realtime/server';

export interface Config {
  host: string;
  port: number;
  /** The node URL, e.g. `https://realtime.example.com`. */
  serviceUrl: string;
  /** The node's WebSocket URL, only when it serves WebSocket apart from HTTP (a local node). */
  webSocketUrl?: string;
  /** The segment ID (a UUID). */
  segment: string;
  /** The signing key's `kid` and private half, as read; the SDK parses it. Never log `privateKey`. */
  signingKey: SigningKey;
  /** Where the private key was read from, for log lines. */
  keySource: string;
  tokenTtlMs: number;
  sessionSecret: string;
  /** False when SESSION_SECRET was unset and a random secret was made. */
  sessionSecretFromEnv: boolean;
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

  const serviceUrl = read('FOLKWAYS_URL');
  if (!serviceUrl) problems.push("FOLKWAYS_URL is not set: use the node URL from the segment's Connect tab");
  else if (!/^https?:\/\/[^/]/.test(serviceUrl)) problems.push(`FOLKWAYS_URL must start with https:// or http://, got "${serviceUrl}"`);

  const webSocketUrl = read('FOLKWAYS_WS_URL');
  if (webSocketUrl && !/^wss?:\/\/[^/]/.test(webSocketUrl)) problems.push(`FOLKWAYS_WS_URL must start with wss:// or ws://, got "${webSocketUrl}"`);

  const segment = read('FOLKWAYS_SEGMENT_ID');
  if (!segment) problems.push("FOLKWAYS_SEGMENT_ID is not set: use the segment ID from the segment's Connect tab");
  else if (!UUID.test(segment)) problems.push(`FOLKWAYS_SEGMENT_ID must be a UUID, got "${segment}"`);

  const kid = read('FOLKWAYS_KEY_ID');
  if (!kid) problems.push("FOLKWAYS_KEY_ID is not set: use the key ID (kid) from the segment's Signing keys tab");
  else if (!KID.test(kid)) problems.push(`FOLKWAYS_KEY_ID must be 1 to 64 letters, digits, dots, dashes or underscores, got "${kid}"`);

  const key = readPrivateKey(env, cwd, problems);

  const ttlSeconds = readInt(read('FOLKWAYS_TOKEN_TTL_SECONDS'), DEFAULT_TTL_SECONDS);
  if (ttlSeconds === undefined || ttlSeconds < MIN_TTL_SECONDS || ttlSeconds > MAX_TTL_SECONDS) {
    problems.push(`FOLKWAYS_TOKEN_TTL_SECONDS must be a whole number from ${MIN_TTL_SECONDS} to ${MAX_TTL_SECONDS}`);
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
    serviceUrl,
    ...(webSocketUrl ? { webSocketUrl } : {}),
    segment,
    signingKey: { kid, privateKey: key.privateKey },
    keySource: key.source,
    tokenTtlMs: ttlSeconds! * 1000,
    sessionSecret,
    sessionSecretFromEnv,
  };
}

interface PrivateKey {
  privateKey: string;
  source: string;
}

/**
 * Reads the private key from one of two places, as the README explains:
 * - `FOLKWAYS_PRIVATE_KEY_FILE`: the path of the key file, for a server with a disk (local, VM, mounted secret);
 * - `FOLKWAYS_PRIVATE_KEY`: the key itself, for platforms that inject secrets as environment variables.
 * The value is not parsed here: the SDK reads every common key format, and the server signs a
 * token at startup, so a key that can't sign stops it with the SDK's explanation.
 */
function readPrivateKey(env: NodeJS.ProcessEnv, cwd: string, problems: string[]): PrivateKey | undefined {
  const read = (name: string) => env[name]?.trim() ?? '';
  if (read('FOLKWAYS_SECRET')) {
    problems.push(
      'FOLKWAYS_SECRET is no longer supported: shared secrets (HS256) were removed. Signing keys are key pairs; put the private key in FOLKWAYS_PRIVATE_KEY_FILE (a path to the .pem) or FOLKWAYS_PRIVATE_KEY (the key itself), and remove FOLKWAYS_SECRET',
    );
    return undefined;
  }
  const file = read('FOLKWAYS_PRIVATE_KEY_FILE');
  const inline = read('FOLKWAYS_PRIVATE_KEY');
  if (file && inline) {
    problems.push('Set only one of FOLKWAYS_PRIVATE_KEY_FILE and FOLKWAYS_PRIVATE_KEY');
    return undefined;
  }
  if (!file && !inline) {
    problems.push("Set FOLKWAYS_PRIVATE_KEY_FILE to the path of the signing key's private key (.pem), or FOLKWAYS_PRIVATE_KEY to the key itself");
    return undefined;
  }
  if (inline) {
    if (/^[^\n{]*\.pem$/.test(inline) && !inline.includes('-----')) {
      problems.push(`FOLKWAYS_PRIVATE_KEY looks like a file path ("${inline}"): put the path in FOLKWAYS_PRIVATE_KEY_FILE instead`);
      return undefined;
    }
    return { privateKey: inline, source: 'FOLKWAYS_PRIVATE_KEY' };
  }
  if (file.includes('-----BEGIN') || file.startsWith('{')) {
    problems.push('FOLKWAYS_PRIVATE_KEY_FILE holds a key, not a path: put the key itself in FOLKWAYS_PRIVATE_KEY instead');
    return undefined;
  }
  try {
    return { privateKey: readFileSync(resolve(cwd, file), 'utf8'), source: file };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'unreadable';
    const hint = code === 'ENOENT' ? ': save the private key there, or point FOLKWAYS_PRIVATE_KEY_FILE at it' : '';
    problems.push(`FOLKWAYS_PRIVATE_KEY_FILE: cannot read ${file} (${code})${hint}`);
    return undefined;
  }
}

function readInt(value: string, fallback: number): number | undefined {
  if (value === '') return fallback;
  return /^\d+$/.test(value) ? Number(value) : undefined;
}
