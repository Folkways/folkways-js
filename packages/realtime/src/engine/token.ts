import { Code } from '../shared/codes';
import { RealtimeError } from '../shared/errors';
import type { FetchLike } from '../transport';

/**
 * Why a token is asked for: `initial` (no token yet), `expiring` (the
 * current one expires soon) or `rejected` (the node refused the current one).
 */
export type TokenReason = 'initial' | 'expiring' | 'rejected';

/** Returns a signed RTE token, typically by asking your backend. */
export type TokenProvider = (ctx: { reason: TokenReason }) => string | Promise<string>;

export type TokenSource = string | TokenProvider;

/** Refresh a cached token this long before its `exp`. */
const REFRESH_LEAD_MS = 60_000;

function base64UrlDecode(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const atobFn = (globalThis as { atob?: (s: string) => string }).atob;
  if (!atobFn) throw new Error('atob unavailable');
  const bin = atobFn(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * Reads claims from a JWT without verifying it. Only used to schedule
 * refreshes and label the HTTP session; the node verifies every token.
 */
export interface PeekedClaims {
  /** Expiry in Unix ms. */
  exp?: number;
  sub?: string;
  /** Segment id. */
  seg?: string;
  kind?: string;
  /** Rights: topic patterns and ops. */
  cap?: { topic: string; ops: string[] }[];
}

export function peekJwt(token: string): PeekedClaims {
  try {
    const part = token.split('.')[1];
    if (!part) return {};
    const claims = JSON.parse(base64UrlDecode(part)) as Record<string, unknown>;
    const out: PeekedClaims = {};
    if (typeof claims.exp === 'number') out.exp = claims.exp * 1000;
    if (typeof claims.sub === 'string') out.sub = claims.sub;
    if (typeof claims.seg === 'string') out.seg = claims.seg;
    if (typeof claims.kind === 'string') out.kind = claims.kind;
    if (Array.isArray(claims.cap)) {
      out.cap = claims.cap
        .filter((c): c is { topic: string; ops: unknown[] } => !!c && typeof c.topic === 'string' && Array.isArray(c.ops))
        .map((c) => ({ topic: c.topic, ops: c.ops.filter((o): o is string => typeof o === 'string') }));
    }
    return out;
  } catch {
    return {};
  }
}

/** A token provider that POSTs to your backend's `authUrl` and reads `{ token }` JSON or a plain-text token. */
export function authUrlProvider(
  url: string,
  headers: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>) | undefined,
  fetchFn: FetchLike | undefined,
): TokenProvider {
  return async ({ reason }) => {
    const g = (globalThis as { fetch?: FetchLike }).fetch;
    const f = fetchFn ?? g?.bind(globalThis);
    if (!f) throw new RealtimeError(Code.AuthRequired, { message: 'authUrl needs fetch (pass options.fetch)', local: true });
    const extra = typeof headers === 'function' ? await headers() : (headers ?? {});
    const res = await f(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/plain', ...extra },
      body: new TextEncoder().encode(JSON.stringify({ reason })),
    });
    const body = new TextDecoder().decode(await res.arrayBuffer());
    if (res.status < 200 || res.status >= 300) {
      throw new RealtimeError(Code.AuthRequired, { message: `authUrl answered HTTP ${res.status}`, local: true });
    }
    if ((res.headers.get('content-type') ?? '').includes('json')) {
      const parsed = JSON.parse(body) as { token?: unknown };
      if (typeof parsed.token === 'string') return parsed.token;
      throw new RealtimeError(Code.AuthRequired, { message: 'authUrl JSON has no "token" string', local: true });
    }
    return body.trim();
  };
}

/**
 * Hands out tokens: caches the current one, refreshes it through the
 * provider (one call at a time) and never logs it.
 */
export class TokenManager {
  private token?: string;
  private expiresAt?: number;
  private inflight?: Promise<string>;
  /** The node refused the last token: the next one is asked for as `rejected`. */
  private rejected = false;

  constructor(
    private source: TokenSource,
    private readonly now: () => number = Date.now,
  ) {
    if (typeof source === 'string') this.set(source);
  }

  /** Replaces the token source (`client.updateToken()`). */
  setSource(source: TokenSource): void {
    this.source = source;
    this.inflight = undefined;
    this.rejected = false;
    this.token = undefined;
    this.expiresAt = undefined;
    if (typeof source === 'string') this.set(source);
  }

  /** Caches a token already fetched from the current source. */
  adopt(token: string): void {
    this.set(token);
    this.rejected = false;
  }

  /** The current token, if one is cached. Never log it. */
  get current(): string | undefined {
    return this.token;
  }

  /** True when a provider can mint new tokens. */
  get refreshable(): boolean {
    return typeof this.source === 'function';
  }

  /** Expiry of the current token in Unix ms, when known. */
  get expiresAtMs(): number | undefined {
    return this.expiresAt;
  }

  /** The current token's `sub`, read without verification. */
  get subject(): string | undefined {
    return this.token ? peekJwt(this.token).sub : undefined;
  }

  /** Records the expiry the node announced (more trustworthy than the JWT). */
  setExpiry(expiresAtMs: number): void {
    if (expiresAtMs > 0) this.expiresAt = expiresAtMs;
  }

  /** A usable token: the cached one unless it is about to expire. */
  async get(): Promise<string> {
    if (this.token && !this.expiringSoon()) return this.token;
    if (!this.refreshable) {
      if (this.token) return this.token;
      throw new RealtimeError(Code.AuthRequired, { message: 'no token', local: true });
    }
    return this.refresh(this.rejected ? 'rejected' : this.token ? 'expiring' : 'initial');
  }

  /** Asks the provider for a new token. Concurrent callers share one call. */
  refresh(reason: TokenReason): Promise<string> {
    if (typeof this.source === 'string') return Promise.resolve(this.source);
    if (this.inflight) return this.inflight;
    const provider = this.source;
    const p = (async () => {
      try {
        const token = await provider({ reason });
        if (typeof token !== 'string' || token.length === 0) {
          throw new RealtimeError(Code.AuthRequired, { message: 'token provider returned no token', local: true });
        }
        this.set(token);
        this.rejected = false;
        return token;
      } catch (e) {
        if (e instanceof RealtimeError) throw e;
        throw new RealtimeError(Code.AuthRequired, { message: 'token provider failed', local: true, cause: e });
      } finally {
        this.inflight = undefined;
      }
    })();
    this.inflight = p;
    return p;
  }

  /** Forgets the cached token (after the node rejected it). */
  invalidate(): void {
    if (this.refreshable) {
      this.token = undefined;
      this.expiresAt = undefined;
      this.rejected = true;
    }
  }

  private set(token: string): void {
    this.token = token;
    this.expiresAt = peekJwt(token).exp;
  }

  private expiringSoon(): boolean {
    return this.expiresAt !== undefined && this.refreshable && this.expiresAt - this.now() < REFRESH_LEAD_MS;
  }
}
