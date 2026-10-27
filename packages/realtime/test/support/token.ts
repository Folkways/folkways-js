import { createHmac } from 'node:crypto';

/** The Local Dev segment from rte/seeds/workspaces.json (free tier, HS256). */
export const DEV_SEGMENT = 'c7e5a92b-62a1-4b14-bd8f-8bb74c77d3ff';
export const DEV_KID = 'dev-1';
export const DEV_SECRET = 'dev-only-secret-change-me';

export interface Capability {
  topic: string;
  ops: ('publish' | 'subscribe' | 'signal' | 'history' | 'presence')[];
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url');

/** Signs a test token for the integration tests' node. */
export function mintToken(
  sub: string,
  opts: { ttlSecs?: number; cap?: Capability[]; seg?: string; secret?: string; kid?: string; now?: number } = {},
): string {
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const header = { alg: 'HS256', typ: 'JWT', kid: opts.kid ?? DEV_KID };
  const claims = {
    seg: opts.seg ?? DEV_SEGMENT,
    sub,
    iat: now,
    exp: now + (opts.ttlSecs ?? 600),
    cap: opts.cap ?? [{ topic: '>', ops: ['publish', 'subscribe', 'signal'] }],
  };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = createHmac('sha256', opts.secret ?? DEV_SECRET).update(input).digest('base64url');
  return `${input}.${sig}`;
}
