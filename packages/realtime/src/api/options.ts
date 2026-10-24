import {
  type CursorStore,
  type EngineConfig,
  type FetchLike,
  type RequestTransport,
  type StreamTransport,
  type TokenSource,
  type TransportKind,
  type WebSocketConstructor,
  authUrlProvider,
  memoryCursorStore,
} from '../engine';
import { Code } from '../shared/codes';
import { RealtimeError } from '../shared/errors';
import { type Logger, silentLogger } from '../shared/logger';
import { VERSION } from './version';

export interface RealtimeOptions {
  /**
   * Base URL of the node, e.g. `https://rte.example.com`. Gives
   * `wss://rte.example.com/v1/ws` and `https://rte.example.com/v1/{publish,poll}`.
   */
  url?: string;
  /** Explicit endpoints; each overrides what `url` gives. */
  endpoints?: { websocket?: string; http?: string };
  /**
   * A token, or a function that fetches one; called again with
   * `{ reason: 'expiring' | 'rejected' }` to refresh. Give this or `authUrl`.
   */
  token?: TokenSource;
  /**
   * Shorthand for a token provider: your backend's endpoint that trades its
   * API key for a short-lived token. POSTed `{ reason }`; answers `{ token }`
   * JSON or the token as text.
   */
  authUrl?: string;
  /** Extra headers for `authUrl` (e.g. your app's session), or a function returning them. */
  authHeaders?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  /** Transports in order of preference. Default `['websocket', 'http']`. */
  transports?: TransportKind[];
  /** Sent in `Hello.client` for troubleshooting. Default `folkways-js/<version>`. */
  clientName?: string;
  /** Sent in `Hello.device`, e.g. `ios` or `web-chrome`. Descriptive only; never used for authorization. */
  device?: string;
  /** `connect()` rejects with `Timeout` after this long (the client keeps trying). Default 15 000; 0 waits forever. */
  connectTimeoutMs?: number;
  /** One attempt: socket open + `Welcome`. Default 10 000. */
  openTimeoutMs?: number;
  /** Subscribe, unsubscribe and reauth replies. Default 10 000. */
  requestTimeoutMs?: number;
  /** Whole life of a publish, retries included. Default 30 000. */
  publishTimeoutMs?: number;
  /** Retries of `RateLimited`/`QuotaExceeded`/`Internal`/`Overloaded` publishes. Default 3. */
  publishRetries?: number;
  /** Reconnect policy, or `false` to give up on the first disconnect. */
  reconnect?: Partial<{ initialDelayMs: number; maxDelayMs: number; maxAttempts: number }> | false;
  /** WebSocket failures (before any session opened) before falling back to HTTP. Default 2. */
  fallbackAfterFailures?: number;
  /** After this long of failed reconnecting the state becomes `offline` and publishes stop waiting. Default 120 000. */
  offlineAfterMs?: number;
  /** While on HTTP after a fallback, try WebSocket again this often (ms); 0 never. Default 300 000. */
  webSocketRetryMs?: number;
  /** Extra silence tolerated after a missed heartbeat. Default 10 000. */
  pongTimeoutMs?: number;
  /** How often processed cursors are hinted to the node; 0 disables. Default 5 000. */
  cursorAckIntervalMs?: number;
  /** Publishes kept while offline (default `{ maxSize: 1000 }`), or `false` to reject them. */
  offlineQueue?: { maxSize?: number } | false;
  /** Where processed cursors are kept. Default: in memory for the client's lifetime. */
  cursorStore?: CursorStore;
  /** How long an Ephemeral signal stays in `Subscription.values`. Default 5 000. */
  signalTtlMs?: number;
  /** HTTP long-poll tuning. */
  longPoll?: Partial<{ waitMs: number; maxEvents: number; emptyStateRecheckMs: number }>;
  /** WebSocket constructor, for runtimes without a global one (e.g. the `ws` package on Node 20). */
  webSocket?: WebSocketConstructor;
  /** fetch implementation, for runtimes without a global one. */
  fetch?: FetchLike;
  /** Diagnostics. Default silent; try `consoleLogger('debug')`. */
  logger?: Logger;
  /** Advanced: replace the transports (tests, custom runtimes). */
  transportOverrides?: { stream?: StreamTransport; request?: RequestTransport };
}

export interface ResolvedOptions {
  engine: EngineConfig;
  connectTimeoutMs: number;
  signalTtlMs: number;
}

function invalid(message: string): RealtimeError {
  return new RealtimeError(Code.InvalidArgument, { message, local: true });
}

/** Derives the WebSocket and HTTP endpoints from a base URL. */
export function endpointsFromUrl(url: string): { websocket: string; http: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw invalid(`url "${url}" is not a valid URL`);
  }
  const secure = u.protocol === 'https:' || u.protocol === 'wss:';
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) {
    throw invalid(`url must be http(s) or ws(s), got ${u.protocol}`);
  }
  let base = u.pathname.replace(/\/+$/, '');
  if (base.endsWith('/v1/ws')) base = base.slice(0, -'/v1/ws'.length);
  const host = u.host;
  return {
    websocket: `${secure ? 'wss' : 'ws'}://${host}${base}/v1/ws`,
    http: `${secure ? 'https' : 'http'}://${host}${base}`,
  };
}

const positive = (v: number | undefined, d: number, name: string): number => {
  if (v === undefined) return d;
  if (typeof v !== 'number' || !(v >= 0)) throw invalid(`${name} must be a non-negative number`);
  return v;
};

export function resolveOptions(o: RealtimeOptions): ResolvedOptions {
  if (!o) throw invalid('options are required');
  let token: TokenSource;
  if (o.token !== undefined) {
    if (typeof o.token !== 'string' && typeof o.token !== 'function') {
      throw invalid('options.token must be a token string or a function returning one');
    }
    if (typeof o.token === 'string' && o.token.length === 0) throw invalid('options.token is empty');
    if (o.authUrl !== undefined) throw invalid('give options.token or options.authUrl, not both');
    token = o.token;
  } else if (typeof o.authUrl === 'string' && o.authUrl.length > 0) {
    token = authUrlProvider(o.authUrl, o.authHeaders, o.fetch);
  } else {
    throw invalid('give options.token (a token or a provider) or options.authUrl');
  }
  const fromUrl = o.url ? endpointsFromUrl(o.url) : {};
  const endpoints = { ...fromUrl, ...(o.endpoints ?? {}) };
  if (!endpoints.websocket && !endpoints.http) throw invalid('give options.url or options.endpoints');
  const transports = o.transports ?? ['websocket', 'http'];
  if (transports.length === 0 || transports.some((t) => t !== 'websocket' && t !== 'http')) {
    throw invalid('options.transports must list "websocket" and/or "http"');
  }
  const rc = o.reconnect;
  const reconnect =
    rc === false
      ? (false as const)
      : {
          initialDelayMs: positive(rc?.initialDelayMs, 500, 'reconnect.initialDelayMs'),
          maxDelayMs: positive(rc?.maxDelayMs, 30_000, 'reconnect.maxDelayMs'),
          maxAttempts: positive(rc?.maxAttempts, Number.POSITIVE_INFINITY, 'reconnect.maxAttempts'),
        };
  const engine: EngineConfig = {
    endpoints,
    token,
    transports,
    clientName: o.clientName ?? `folkways-js/${VERSION}`,
    device: o.device,
    openTimeoutMs: positive(o.openTimeoutMs, 10_000, 'openTimeoutMs'),
    requestTimeoutMs: positive(o.requestTimeoutMs, 10_000, 'requestTimeoutMs'),
    publishTimeoutMs: positive(o.publishTimeoutMs, 30_000, 'publishTimeoutMs'),
    publishRetries: positive(o.publishRetries, 3, 'publishRetries'),
    reconnect,
    fallbackAfterFailures: positive(o.fallbackAfterFailures, 2, 'fallbackAfterFailures'),
    offlineAfterMs: positive(o.offlineAfterMs, 120_000, 'offlineAfterMs'),
    webSocketRetryMs: positive(o.webSocketRetryMs, 300_000, 'webSocketRetryMs'),
    pongTimeoutMs: positive(o.pongTimeoutMs, 10_000, 'pongTimeoutMs'),
    cursorAckIntervalMs: positive(o.cursorAckIntervalMs, 5_000, 'cursorAckIntervalMs'),
    offlineQueueMax: o.offlineQueue === false ? 0 : positive(o.offlineQueue?.maxSize, 1_000, 'offlineQueue.maxSize'),
    cursorStore: o.cursorStore ?? memoryCursorStore(),
    longPoll: {
      waitMs: positive(o.longPoll?.waitMs, 25_000, 'longPoll.waitMs'),
      maxEvents: positive(o.longPoll?.maxEvents, 100, 'longPoll.maxEvents'),
      emptyStateRecheckMs: positive(o.longPoll?.emptyStateRecheckMs, 2_000, 'longPoll.emptyStateRecheckMs'),
    },
    webSocket: o.webSocket,
    fetch: o.fetch,
    streamTransport: o.transportOverrides?.stream,
    requestTransport: o.transportOverrides?.request,
    logger: o.logger ?? silentLogger,
  };
  return {
    engine,
    connectTimeoutMs: positive(o.connectTimeoutMs, 15_000, 'connectTimeoutMs'),
    signalTtlMs: positive(o.signalTtlMs, 5_000, 'signalTtlMs'),
  };
}
