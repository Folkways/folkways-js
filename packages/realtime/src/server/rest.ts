import { deliveryCode, encodePayload } from '../api/message';
import { toReceipt } from '../api/topic';
import type { ContentTypeName, Delivery, Permission, PublishReceipt } from '../api/types';
import { Code } from '../shared/codes';
import { RealtimeError } from '../shared/errors';
import { parse128, random128 } from '../shared/random';
import { assertTopic } from '../shared/topic';
import { AckMode, type FetchLike, HttpTransport, type PublishBody, decodeServerPacket, encodeClientPacket } from '../transport';
import { type Signer, type SigningKey, importSigner, signJwt } from './sign';

export interface RestOptions {
  /** Base URL of the node's HTTP port, e.g. `https://rte.example.com`. */
  url: string;
  /** The segment's id (a UUID, from the dashboard). Every token names it. */
  segment: string;
  /** One of the segment's signing keys, with its private half. Tokens are signed here, never by the node. */
  signingKey: SigningKey;
  /** Identity this server publishes as. Default `server`. */
  identity?: string;
  /** Rights of this server's own token, used by `publish()`. Default: publish on every topic. */
  capabilities?: readonly Permission[];
  /** fetch implementation, for runtimes without a global one. */
  fetch?: FetchLike;
  /** Request timeout (ms). Default 10 000. */
  timeoutMs?: number;
}

export interface CreateTokenOptions {
  /** Who the token is for. Required unless `kind` is `anonymous`. */
  identity?: string;
  /** Default `user`. */
  kind?: 'user' | 'agent' | 'service' | 'anonymous';
  /** Rights for the token. Default: none, so the token can only connect. */
  capabilities?: readonly Permission[];
  /** Lifetime (ms). Default 600 000; at most 15 minutes, the longest the node accepts. */
  ttlMs?: number;
}

export interface IssuedToken {
  readonly token: string;
  readonly expiresAt: number;
  readonly identity: string | null;
  readonly kind: string;
  readonly capabilities: readonly Permission[];
}

export interface RestPublishOptions {
  delivery?: Delivery;
  key?: string;
  ttlMs?: number;
  remove?: boolean;
  headers?: Record<string, string>;
  contentType?: ContentTypeName | number;
  idempotencyKey?: string;
}

/** Refresh the server's own token this long before it expires. */
const REFRESH_LEAD_MS = 60_000;
const DEFAULT_TTL_MS = 600_000;
/** The longest token lifetime the node accepts. */
const MAX_TTL_MS = 900_000;
/** The longest `sub` the node accepts, in UTF-8 bytes. */
const MAX_IDENTITY_BYTES = 256;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SERVER_RIGHTS: readonly Permission[] = [{ topics: '>', ops: ['publish'] }];

const invalid = (message: string) => new RealtimeError(Code.InvalidArgument, { message, local: true });

function isBrowser(): boolean {
  const g = globalThis as { window?: unknown; document?: unknown };
  return typeof g.window !== 'undefined' && typeof g.document !== 'undefined';
}

/**
 * The backend side of Folkways: signs short-lived tokens for your users with
 * one of the segment's signing keys, and publishes over HTTP without keeping
 * a connection. Signing happens in process; minting a token makes no network
 * call. There are no secret API keys (ADR-008).
 *
 *   import { Folkways } from '@folkwaysio/realtime/server';
 *   const rte = new Folkways.Rest({
 *     url: 'https://rte.example.com',
 *     segment: process.env.RTE_SEGMENT!,
 *     signingKey: { kid: 'backend-2026-10', privateKey: process.env.RTE_PRIVATE_KEY! },
 *   });
 *   const { token } = await rte.createToken({ identity: 'user:42', capabilities: [{ topics: 'chat/*', ops: ['subscribe', 'publish'] }] });
 *
 * Member lists and DMs (`rte.members`, `rte.dm`) arrive with the node's endpoints for them.
 */
export class Rest {
  private readonly http: HttpTransport;
  private readonly base: string;
  private signer?: Promise<Signer>;
  private own?: { token: string; expiresAt: number };
  private ownInflight?: Promise<string>;

  constructor(private readonly opts: RestOptions) {
    if (!opts) throw invalid('Rest needs options');
    if ((opts as { apiKey?: unknown }).apiKey !== undefined) {
      throw invalid('apiKey was removed: secret API keys no longer exist (ADR-008). Pass segment and signingKey: { kid, privateKey } instead');
    }
    if (isBrowser()) {
      throw invalid('Rest signs tokens with a private key and must never run in a browser; mint tokens on your server and use authUrl in the client');
    }
    if (typeof opts.url !== 'string' || !/^https?:\/\//.test(opts.url)) {
      throw invalid('Rest needs the node\'s HTTP url (http:// or https://)');
    }
    if (typeof opts.segment !== 'string' || !UUID.test(opts.segment)) throw invalid('Rest needs the segment id (a UUID)');
    const key = opts.signingKey;
    if (!key || typeof key.kid !== 'string' || key.kid.length === 0) throw invalid('Rest needs signingKey.kid');
    if (typeof key.privateKey !== 'string' || key.privateKey.trim().length === 0) throw invalid('Rest needs signingKey.privateKey');
    if (key.privateKey.trim().startsWith('rte_')) {
      throw invalid('signingKey.privateKey is an API key; give the private key of a signing key (ADR-008)');
    }
    this.base = opts.url.replace(/\/+$/, '');
    this.http = new HttpTransport(opts.fetch);
  }

  /** Signs a short-lived token for one identity, in process. */
  async createToken(req: CreateTokenOptions = {}): Promise<IssuedToken> {
    const kind = req.kind ?? 'user';
    let identity: string | null = null;
    if (kind === 'anonymous') {
      if (req.identity !== undefined) throw invalid('an anonymous token has no identity');
    } else {
      const sub = req.identity;
      if (typeof sub !== 'string' || sub.length === 0) throw invalid('identity is required unless kind is anonymous');
      if (new TextEncoder().encode(sub).length > MAX_IDENTITY_BYTES) throw invalid(`identity is longer than ${MAX_IDENTITY_BYTES} bytes`);
      if (sub.startsWith('anon:')) throw invalid('identity must not start with anon:, which the node reserves');
      identity = sub;
    }
    const capabilities = req.capabilities ?? [];
    for (const c of capabilities) {
      if (!c || typeof c.topics !== 'string' || c.topics.length === 0 || !Array.isArray(c.ops) || c.ops.length === 0) {
        throw invalid('every capability needs topics and at least one op');
      }
    }
    const ttlMs = Math.min(Math.max(req.ttlMs ?? DEFAULT_TTL_MS, 1_000), MAX_TTL_MS);
    const now = Math.floor(Date.now() / 1000);
    const exp = now + Math.ceil(ttlMs / 1000);
    const claims: Record<string, unknown> = {
      seg: this.opts.segment,
      ...(identity !== null ? { sub: identity } : {}),
      kind,
      cap: capabilities.map((c) => ({ topic: c.topics, ops: [...c.ops] })),
      iat: now,
      exp,
      jti: crypto.randomUUID(),
    };
    const token = await signJwt(await this.signerFor(), claims);
    return Object.freeze({ token, expiresAt: exp * 1000, identity, kind, capabilities: capabilities.map((c) => ({ topics: c.topics, ops: [...c.ops] })) });
  }

  /** Publishes one event over HTTP and resolves with the node's receipt. Retrying with the same idempotencyKey is safe. */
  async publish(topic: string, event: string, data: unknown, opts: RestPublishOptions = {}): Promise<PublishReceipt> {
    assertTopic(topic);
    if (typeof event !== 'string' || event.length === 0) throw new RealtimeError(Code.InvalidArgument, { message: 'event name must be a non-empty string', topic, local: true });
    const delivery = opts.delivery ?? 'stream';
    if (delivery === 'signal') throw new RealtimeError(Code.InvalidArgument, { message: 'signals are for live clients; publish stream or kv events from a server', topic, local: true });
    const idempotencyKey = opts.idempotencyKey !== undefined ? parse128(opts.idempotencyKey) : random128();
    if (!idempotencyKey) throw new RealtimeError(Code.InvalidArgument, { message: 'idempotencyKey must be 32 hex digits or a UUID', topic, local: true });
    const { payload, contentType } = opts.remove ? { payload: new Uint8Array(0), contentType: 0 } : encodePayload(data, opts.contentType);
    const body: PublishBody = {
      topic: { name: topic },
      name: event,
      payload,
      contentType: contentType || undefined,
      delivery: deliveryCode(delivery),
      ack: AckMode.Accepted,
      idempotencyKey,
      key: opts.key,
      tombstone: opts.remove || undefined,
      ttlMs: opts.ttlMs,
      clientTsMs: Date.now(),
      headers: opts.headers ? Object.entries(opts.headers) : undefined,
    };
    const packet = encodeClientPacket([{ corr: 1n, msg: { type: 'publish', publish: body } }]);
    let token = await this.ownToken();
    let reply = await this.withTimeout((signal) => this.http.request(this.base, '/v1/publish', token, packet, signal));
    if (reply.status === 401) {
      this.own = undefined;
      token = await this.ownToken();
      reply = await this.withTimeout((signal) => this.http.request(this.base, '/v1/publish', token, packet, signal));
    }
    const frames = reply.packets.flatMap((p) => decodeServerPacket(p));
    for (const { msg } of frames) {
      if (msg.type === 'pubAck') return toReceipt(topic, delivery, msg);
      if (msg.type === 'opError') throw new RealtimeError(msg.code, { message: msg.message, retryAfterMs: msg.retryAfterMs, topic });
      if (msg.type === 'close') throw new RealtimeError(msg.code, { message: msg.reason, retryAfterMs: msg.retryAfterMs, topic });
    }
    throw new RealtimeError(Code.Unavailable, { message: `HTTP ${reply.status} without a receipt`, topic, retryAfterMs: reply.retryAfterMs });
  }

  /** This server's own `service` token, signed here and cached until shortly before it expires. */
  private async ownToken(): Promise<string> {
    if (this.own && this.own.expiresAt - Date.now() > REFRESH_LEAD_MS) return this.own.token;
    this.ownInflight ??= this.createToken({ identity: this.opts.identity ?? 'server', kind: 'service', capabilities: this.opts.capabilities ?? SERVER_RIGHTS, ttlMs: MAX_TTL_MS })
      .then((t) => {
        this.own = { token: t.token, expiresAt: t.expiresAt };
        return t.token;
      })
      .finally(() => {
        this.ownInflight = undefined;
      });
    return this.ownInflight;
  }

  /** The imported signing key; a key that fails to import is retried on the next call. */
  private signerFor(): Promise<Signer> {
    this.signer ??= importSigner(this.opts.signingKey).catch((e: unknown) => {
      this.signer = undefined;
      throw e;
    });
    return this.signer;
  }

  private async withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const ac = new AbortController();
    const ms = this.opts.timeoutMs ?? 10_000;
    const timer = setTimeout(() => ac.abort(), ms);
    try {
      return await fn(ac.signal);
    } catch (err) {
      if (err instanceof RealtimeError) throw err;
      throw new RealtimeError(ac.signal.aborted ? Code.Timeout : Code.Unavailable, { message: ac.signal.aborted ? `no answer within ${ms} ms` : 'request failed', local: true, cause: err });
    } finally {
      clearTimeout(timer);
    }
  }
}
