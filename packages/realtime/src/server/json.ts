import { Code } from '../shared/codes';
import { RealtimeError } from '../shared/errors';
import { type FetchLike, parseRetryAfter } from '../transport/http';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function fallbackCode(status: number): number {
  switch (status) {
    case 400: return Code.InvalidArgument;
    case 401: return Code.AuthRequired;
    case 403: return Code.Forbidden;
    case 413: return Code.PayloadTooLarge;
    case 429: return Code.RateLimited;
    case 504: return Code.Timeout;
    default: return Code.Unavailable;
  }
}

export function jsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Authenticated JSON service calls, never include raw response bodies or credentials in fallback errors. */
export async function requestJson(
  impl: FetchLike | undefined, base: string, path: string, token: string,
  body: object, expected: 200 | 204, signal: AbortSignal, topic?: string,
): Promise<unknown> {
  const fetchFn = impl ?? (globalThis as { fetch?: FetchLike }).fetch?.bind(globalThis);
  if (!fetchFn) throw new RealtimeError(Code.TransportUnavailable, { message: 'no fetch implementation', local: true });
  const res = await fetchFn(base + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: encoder.encode(JSON.stringify(body)),
    signal,
  });
  if (res.status === 204 && expected === 204) return undefined;
  const bytes = await res.arrayBuffer();
  let parsed: unknown;
  if ((res.headers.get('content-type') ?? '').toLowerCase().includes('application/json') && bytes.byteLength <= 16 * 1024 * 1024) {
    try { parsed = JSON.parse(decoder.decode(bytes)); } catch { /* malformed response */ }
  }
  if (res.status === expected && expected === 200 && parsed !== undefined) return parsed;
  if (res.status >= 200 && res.status < 300) {
    throw new RealtimeError(Code.BadFrame, { message: 'unexpected JSON service response', topic });
  }
  const error = jsonObject(parsed) ? parsed : undefined;
  const code = typeof error?.code === 'number' && Number.isInteger(error.code) && error.code > 0 && error.code < 1000 ? error.code : fallbackCode(res.status);
  const wait = error?.retry_after_ms;
  throw new RealtimeError(code, {
    message: typeof error?.message === 'string' ? error.message : `HTTP ${res.status} from ${path}`,
    retryAfterMs: typeof wait === 'number' && Number.isFinite(wait) && wait >= 0 ? wait : parseRetryAfter(res.headers.get('retry-after')),
    topic,
  });
}
