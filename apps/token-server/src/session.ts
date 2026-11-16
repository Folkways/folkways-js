import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * A stand-in for your app's real login, so the example has someone to issue
 * tokens for: anyone can sign in with a name. Signing in returns a session
 * string (the name and an expiry, HMAC-signed so the browser can't change it)
 * that the app sends back as `Authorization: Bearer <session>`.
 *
 * Each browser tab keeps its own session, so the same name can be signed in
 * from several tabs or browsers at once: one user, several connections.
 *
 * Replace this with your own sessions. The token endpoint only needs to know
 * who the signed-in user is.
 */
const SESSION_MS = 8 * 60 * 60 * 1000;

export interface Session {
  name: string;
  expiresAt: number;
}

export class Sessions {
  constructor(
    private readonly secret: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** A signed session string for `name`. */
  issue(name: string): { session: string; expiresAt: number } {
    const expiresAt = this.now() + SESSION_MS;
    const payload = Buffer.from(JSON.stringify({ name, expiresAt })).toString('base64url');
    return { session: `${payload}.${this.sign(payload)}`, expiresAt };
  }

  /** The user of an `Authorization: Bearer <session>` header, or undefined when it is missing, altered or expired. */
  read(authorization: string | undefined): Session | undefined {
    const value = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
    const dot = value?.lastIndexOf('.') ?? -1;
    if (!value || dot <= 0) return undefined;
    const payload = value.slice(0, dot);
    const given = Buffer.from(value.slice(dot + 1));
    const expected = Buffer.from(this.sign(payload));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
    try {
      const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<Session>;
      if (typeof session.name !== 'string' || typeof session.expiresAt !== 'number') return undefined;
      if (session.expiresAt <= this.now()) return undefined;
      return { name: session.name, expiresAt: session.expiresAt };
    } catch {
      return undefined;
    }
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }
}
