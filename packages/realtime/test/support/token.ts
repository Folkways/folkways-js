import { generateKeyPairSync, sign } from 'node:crypto';

/** Local-only fixtures; never used as service credentials. */
export const DEV_SEGMENT = '00000000-0000-4000-8000-000000000042';
export const DEV_KID = 'fixture-key';
const TEST_KEY = generateKeyPairSync('ed25519').privateKey;

export interface Capability {
  topic: string;
  ops: ('publish' | 'subscribe' | 'signal' | 'history' | 'presence')[];
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url');

/** Signs a test token with an ephemeral fixture key or explicit test credentials. */
export function mintToken(
  sub: string,
  opts: { ttlSecs?: number; cap?: Capability[]; seg?: string; kid?: string; now?: number; privateKey?: string } = {},
): string {
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const header = { alg: 'EdDSA', typ: 'JWT', kid: opts.kid ?? DEV_KID };
  const claims = {
    seg: opts.seg ?? DEV_SEGMENT,
    sub,
    iat: now,
    exp: now + (opts.ttlSecs ?? 600),
    cap: opts.cap ?? [{ topic: '>', ops: ['publish', 'subscribe', 'signal'] }],
  };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  return `${input}.${b64url(sign(null, Buffer.from(input), opts.privateKey ?? TEST_KEY))}`;
}
