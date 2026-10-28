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
  return new Folkways.Rest({ url: config.rteUrl, segment: config.segment, signingKey: config.signingKey });
}

export const identityOf = (name: string) => `user:${name}`;

/**
 * The HTTP API:
 *
 *   GET    /healthz              liveness
 *   GET    /api/session          who is signed in ({ identity: null } when nobody)
 *   POST   /api/session          sign in with { name }
 *   DELETE /api/session          sign out
 *   POST   /api/realtime-token   a token for the signed-in user (the SDK's authUrl)
 */
export function createApp(config: Config, rte: Rest = createRest(config), log: Log = console.log): express.Express {
  const sessions = new Sessions(config.sessionSecret, config.secureCookies);
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '4kb' }));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/session', (req, res) => {
    const session = sessions.read(req);
    res.json({ identity: session ? identityOf(session.name) : null });
  });

  app.post('/api/session', (req, res) => {
    const name: unknown = req.body?.name;
    if (typeof name !== 'string' || !NAME.test(name.trim())) {
      res.status(400).json({ error: 'Use a name of 1 to 32 letters, digits, dots, dashes or underscores' });
      return;
    }
    sessions.start(res, name.trim());
    res.json({ identity: identityOf(name.trim()) });
  });

  app.delete('/api/session', (_req, res) => {
    sessions.end(res);
    res.status(204).end();
  });

  // The SDK POSTs { reason } here: 'initial' on connect, 'expiring' about a
  // minute before the current token expires, 'rejected' when the node refused
  // it. Each token is good for every connect and reconnect until it expires.
  app.post('/api/realtime-token', async (req, res) => {
    res.set('cache-control', 'no-store');
    const session = sessions.read(req);
    if (!session) {
      res.status(401).json({ error: 'Not signed in' });
      return;
    }
    const identity = identityOf(session.name);
    const reason: unknown = req.body?.reason;
    const issued = await rte.createToken({ identity, capabilities: permissionsFor(identity), ttlMs: config.tokenTtlMs });
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
