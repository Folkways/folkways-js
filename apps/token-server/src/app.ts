import express, { type NextFunction, type Request, type Response } from 'express';
import { Folkways, type Rest } from '@folkwaysio/realtime/server';
import type { Config } from './config.js';
import { permissionsFor } from './permissions.js';
import { Sessions } from './session.js';

/** Names people can sign in with; the token's identity is `user:<name>`. */
const NAME = /^[A-Za-z0-9._-]{1,32}$/;
const REASONS = new Set(['initial', 'expiring', 'rejected']);

export type Log = (line: string) => void;

/** The `Rest` client that signs tokens with the segment's signing key. */
export function createRest(config: Config): Rest {
  return new Folkways.Rest({ url: config.serviceUrl, segment: config.segment, signingKey: config.signingKey });
}

export const identityOf = (name: string) => `user:${name}`;

/**
 * The HTTP API:
 *
 *   GET    /healthz              liveness
 *   GET    /api/connection       where the app connects: { url, endpoints? }, ready for Folkways.connect
 *   POST   /api/login            sign in with { name }; answers { name, identity, session, expiresAt }
 *   POST   /api/realtime-token   a token for the session in `Authorization: Bearer` (the SDK's authUrl)
 *
 * The same name may sign in any number of times: every session gets the same
 * identity, so the node sees one user with several connections.
 */
export function createApp(config: Config, folkways: Rest = createRest(config), log: Log = console.log): express.Express {
  const sessions = new Sessions(config.sessionSecret);
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '4kb' }));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  // The app connects to the node this server signs tokens for, so the segment's
  // settings live in one place (.env here) and the app needs none of its own.
  app.get('/api/connection', (_req, res) => {
    res.json({ url: config.serviceUrl, ...(config.webSocketUrl ? { endpoints: { websocket: config.webSocketUrl } } : {}) });
  });

  app.post('/api/login', (req, res) => {
    const raw: unknown = req.body?.name;
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (!NAME.test(name)) {
      res.status(400).json({ error: 'Use 1 to 32 letters, digits, dots, dashes or underscores' });
      return;
    }
    const { session, expiresAt } = sessions.issue(name);
    log(`sign-in as ${identityOf(name)}`);
    res.set('cache-control', 'no-store');
    res.json({ name, identity: identityOf(name), session, expiresAt });
  });

  // The SDK POSTs { reason } here: 'initial' on connect, 'expiring' about a
  // minute before the current token expires, 'rejected' when the node refused
  // it. Each token is good for every connect and reconnect until it expires.
  app.post('/api/realtime-token', async (req, res) => {
    res.set('cache-control', 'no-store');
    const session = sessions.read(req.headers.authorization);
    if (!session) {
      res.status(401).json({ error: 'Not signed in' });
      return;
    }
    const identity = identityOf(session.name);
    const reason: unknown = req.body?.reason;
    const issued = await folkways.createToken({ identity, capabilities: permissionsFor(identity), ttlMs: config.tokenTtlMs });
    log(`token for ${identity} (${typeof reason === 'string' && REASONS.has(reason) ? reason : 'no reason'}), expires ${new Date(issued.expiresAt).toISOString()}`);
    res.json({ token: issued.token, expiresAt: issued.expiresAt });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Express hands thrown and rejected errors here. Client errors (bad JSON)
  // keep their status; anything else is logged, never echoed to the client.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    void _next;
    const status = (err as { status?: unknown }).status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      res.status(status).json({ error: 'Bad request' });
      return;
    }
    log(`error: ${err instanceof Error ? err.message : String(err)}`);
    res.status(500).json({ error: 'Internal error' });
  });

  return app;
}
