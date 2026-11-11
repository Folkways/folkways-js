/**
 * Talks to the example token server (apps/token-server), which Vite proxies
 * at /api so the app and the server share one origin.
 */

export interface SignIn {
  name: string;
  /** `user:<name>`: what the node knows this user as. */
  identity: string;
  /** Signed session string, sent as `Authorization: Bearer` for tokens. */
  session: string;
  expiresAt: number;
}

/** Thrown when the token server no longer accepts the session (it restarted, or the session expired). */
export class SignedOut extends Error {
  constructor() {
    super('Your sign-in has expired. Sign in again.');
    this.name = 'SignedOut';
  }
}

const SERVER_DOWN = "Can't reach the token server. Start it with `pnpm --filter @folkwaysio/token-server dev`.";
// sessionStorage, not localStorage: every tab is its own sign-in, so two tabs
// can be two different people, or the same person twice.
const STORAGE_KEY = 'folkways-example:sign-in';

export function savedSignIn(): SignIn | null {
  try {
    const s = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null') as SignIn | null;
    if (s && typeof s.session === 'string' && typeof s.identity === 'string' && s.expiresAt > Date.now()) return s;
  } catch {
    // Storage blocked or corrupt: sign in again.
  }
  return null;
}

export function saveSignIn(s: SignIn | null): void {
  try {
    if (s) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage blocked: the sign-in lasts until the tab reloads.
  }
}

async function post(path: string, body: unknown, session?: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(session ? { authorization: `Bearer ${session}` } : {}) },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(SERVER_DOWN);
  }
  // A 5xx is Vite's proxy failing to reach the token server.
  if (res.status >= 500) throw new Error(SERVER_DOWN);
  return res;
}

export async function login(name: string): Promise<SignIn> {
  const res = await post('/login', { name });
  const json = (await res.json().catch(() => ({}))) as Partial<SignIn> & { error?: string };
  if (!res.ok || !json.session) throw new Error(json.error ?? `Sign-in failed (HTTP ${res.status})`);
  return json as SignIn;
}

/** A Folkways token for the signed-in user. The SDK calls this on connect and again before each token expires. */
export async function realtimeToken(session: string, reason: string): Promise<string> {
  const res = await post('/realtime-token', { reason }, session);
  if (res.status === 401) throw new SignedOut();
  const json = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!res.ok || !json.token) throw new Error(json.error ?? `The token server answered HTTP ${res.status}`);
  return json.token;
}

/** `user:alice` → `alice`. */
export const nameOf = (identity: string) => identity.replace(/^user:/, '');
