import { sign } from 'node:crypto';

/**
 * The Local Dev segment of the control plane's dev seed, and its Ed25519 signing key `dev-1`.
 * The private key is published dev seed data (control-tower `db/seed/dev-keys/dev-1.pem`).
 * Tests sign with it as a backend would.
 */
export const DEV_SEGMENT = 'c7e5a92b-62a1-4b14-bd8f-8bb74c77d3ff';
export const DEV_KID = 'dev-1';
export const DEV_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIFNE/eS8vRt60gICKiUv3IPz/0xDD5cSZlw4+4z+esne
-----END PRIVATE KEY-----
`;

export interface Capability {
  topic: string;
  ops: ('publish' | 'subscribe' | 'signal' | 'history' | 'presence')[];
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url');

/** Signs a test token for the integration tests' node. */
export function mintToken(
  sub: string,
  opts: { ttlSecs?: number; cap?: Capability[]; seg?: string; kid?: string; now?: number } = {},
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
  return `${input}.${b64url(sign(null, Buffer.from(input), DEV_PRIVATE_KEY))}`;
}
