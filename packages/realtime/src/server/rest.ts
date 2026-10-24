import { deliveryCode, encodePayload } from '../api/message';
import { toReceipt } from '../api/topic';
import type { ContentTypeName, Delivery, Permission, PublishReceipt } from '../api/types';
import { VERSION } from '../api/version';
import { Code } from '../shared/codes';
import { RealtimeError } from '../shared/errors';
import { parse128, random128 } from '../shared/random';
import { assertTopic } from '../shared/topic';
import { AckMode, type FetchLike, HttpTransport, type PublishBody, decodeServerPacket, encodeClientPacket } from '../transport';

export interface RestOptions {
  /** A secret (`rte_sk_…`) or publishable (`rte_pk_…`) API key. Keep secret keys on your server. */
  apiKey: string;
  /** Base URL of the node's HTTP port, e.g. `https://rte.example.com`. */
  url: string;
  /** Identity this server publishes as (secret keys). Default `server`. */
  identity?: string;
  /** fetch implementation, for runtimes without a global one. */
  fetch?: FetchLike;
  /** Request timeout (ms). Default 10 000. */
  timeoutMs?: number;
}

export interface CreateTokenOptions {
  /** Who the token is for. Required unless `kind` is `anonymous`. */
  identity?: string;
  kind?: 'user' | 'agent' | 'service' | 'anonymous';
  /** Rights for the token, each within the key's. Default: all of the key's. */
  capabilities?: readonly Permission[];
  /** Lifetime (ms). Default 600 000; the node caps it at 15 minutes. */
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

function isBrowser(): boolean {
  const g = globalThis as { window?: unknown; document?: unknown };
  return typeof g.window !== 'undefined' && typeof g.document !== 'undefined';
}

/**
 * The backend side of Folkways: mints short-lived tokens for your users
 * and publishes over HTTP without keeping a connection.
 *
 *   import { Folkways } from '@folkways/realtime/server';
 *   const rte = new Folkways.Rest({ apiKey: process.env.RTE_SECRET_KEY, url: 'https://rte.example.com' });
 *   const { token } = await rte.createToken({ identity: 'user:42', capabilities: [{ topics: 'chat/*', ops: ['subscribe', 'publish'] }] });
 *
 * Member lists and DMs (`rte.members`, `rte.dm`) arrive with the node's endpoints for them.
 */
export class Rest {
  private readonly http: HttpTransport;
  private readonly base: string;
  private own?: { token: string; expiresAt: number };
  private ownInflight?: Promise<string>;

  constructor(private readonly opts: RestOptions) {
    if (!opts || typeof opts.apiKey !== 'string' || opts.apiKey.length === 0) {
      throw new RealtimeError(Code.InvalidArgument, { message: 'Rest needs an apiKey', local: true });
    }
    if (opts.apiKey.startsWith('rte_sk_') && isBrowser()) {
      throw new RealtimeError(Code.InvalidArgument, {
        message: 'a secret API key must never reach a browser; mint tokens on your server and use authUrl in the client',
        local: true,
      });
    }
    if (typeof opts.url !== 'string' || !/^https?:\/\//.test(opts.url)) {
      throw new RealtimeError(Code.InvalidArgument, { message: 'Rest needs the node\'s HTTP url (http:// or https://)', local: true });
    }
    this.base = opts.url.replace(/\/+$/, '');
    this.http = new HttpTransport(opts.fetch);
  }

  /** Trades the API key for a short-lived token (`POST /v1/token`). */
  async createToken(req: CreateTokenOptions = {}): Promise<IssuedToken> {
    const f = this.fetchFn();
    const body = JSON.stringify({
      sub: req.identity,
      kind: req.kind,
      cap: req.capabilities?.map((c) => ({ topic: c.topics, ops: c.ops })),
      ttl_secs: req.ttlMs !== undefined ? Math.max(1, Math.ceil(req.ttlMs / 1000)) : undefined,
    });
    const res = await this.withTimeout((signal) =>
      f(`${this.base}/v1/token`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.opts.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json', 'X-Client': `folkways-js/${VERSION}` },
        body: new TextEncoder().encode(body),
        signal,
      }),
    );
    const text = new TextDecoder().decode(await res.arrayBuffer());
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      /* a proxy answered */
    }
    if (res.status < 200 || res.status >= 300) {
      throw new RealtimeError(typeof json.code === 'number' ? json.code : Code.Unavailable, {
        message: typeof json.message === 'string' ? json.message : `HTTP ${res.status} from /v1/token`,
      });
    }
    const caps = Array.isArray(json.capabilities) ? (json.capabilities as { topic: string; ops: string[] }[]) : [];
    return Object.freeze({
      token: String(json.token),
      expiresAt: Number(json.expires_at_ms),
      identity: typeof json.identity === 'string' ? json.identity : null,
      kind: String(json.kind ?? ''),
      capabilities: caps.map((c) => ({ topics: c.topic, ops: c.ops as Permission['ops'] })),
    });
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

  /** This server's own token, minted from the key and cached until shortly before it expires. */
  private async ownToken(): Promise<string> {
    if (this.own && this.own.expiresAt - Date.now() > REFRESH_LEAD_MS) return this.own.token;
    this.ownInflight ??= this.createToken({ identity: this.opts.identity ?? 'server', kind: 'service' })
      .then((t) => {
        this.own = { token: t.token, expiresAt: t.expiresAt };
        return t.token;
      })
      .finally(() => {
        this.ownInflight = undefined;
      });
    return this.ownInflight;
  }

  private fetchFn(): FetchLike {
    const f = this.opts.fetch ?? (globalThis as { fetch?: FetchLike }).fetch?.bind(globalThis);
    if (!f) throw new RealtimeError(Code.TransportUnavailable, { message: 'no fetch in this runtime (pass options.fetch)', local: true });
    return f;
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
