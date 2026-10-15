import { Code } from '../shared/codes';
import { RealtimeError } from '../shared/errors';

export type TokenReason = 'connect' | 'refresh' | 'expired' | 'invalid';

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
export function peekJwt(token: string): { exp?: number; sub?: string } {
  try {
    const part = token.split('.')[1];
    if (!part) return {};
    const claims = JSON.parse(base64UrlDecode(part)) as { exp?: unknown; sub?: unknown };
    return {
      exp: typeof claims.exp === 'number' ? claims.exp * 1000 : undefined,
      sub: typeof claims.sub === 'string' ? claims.sub : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Hands out tokens: caches the current one, refreshes it through the
 * provider (one call at a time) and never logs it.
 */
export class TokenManager {
  private token?: string;
  private expiresAt?: number;
  private inflight?: Promise<string>;

  constructor(
    private readonly source: TokenSource,
    private readonly now: () => number = Date.now,
  ) {
    if (typeof source === 'string') this.set(source);
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
  async get(reason: TokenReason = 'connect'): Promise<string> {
    if (this.token && !this.expiringSoon()) return this.token;
    if (!this.refreshable) {
      if (this.token) return this.token;
      throw new RealtimeError(Code.AuthRequired, { message: 'no token', local: true });
    }
    return this.refresh(this.token ? 'refresh' : reason);
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
