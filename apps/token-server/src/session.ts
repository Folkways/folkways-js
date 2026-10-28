import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';

/**
 * A stand-in for your app's real login, so the example has someone to issue
 * tokens for: anyone can sign in with a name. The name lives in a cookie,
 * signed so the browser can't change it, and the cookie is `HttpOnly` and
 * `SameSite=Lax`, so other sites can neither read it nor send it with a POST.
 *
 * Replace this with your own sessions. The token endpoint only needs to know
 * who the signed-in user is.
 */
export const SESSION_COOKIE = 'example_session';
const SESSION_MS = 8 * 60 * 60 * 1000;

export interface Session {
  name: string;
  expiresAt: number;
}

export class Sessions {
  constructor(
    private readonly secret: string,
    private readonly secure: boolean,
    private readonly now: () => number = Date.now,
  ) {}

  /** Signs `name` in, by setting the session cookie on `res`. */
  start(res: Response, name: string): Session {
    const session = { name, expiresAt: this.now() + SESSION_MS };
    const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
    res.cookie(SESSION_COOKIE, `${payload}.${this.sign(payload)}`, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.secure,
      path: '/',
      maxAge: SESSION_MS,
    });
    return session;
  }

  /** The signed-in user, or undefined when the cookie is missing, altered or expired. */
  read(req: Request): Session | undefined {
    const value = cookie(req, SESSION_COOKIE);
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

  /** Signs out, by clearing the cookie. */
  end(res: Response): void {
    res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', secure: this.secure, path: '/' });
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }
}

function cookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}
