import { splitLengthPrefixed } from './length-prefixed';
import { type HttpPath, type HttpReply, type RequestTransport, TransportError } from './types';

export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: Uint8Array; signal?: AbortSignal },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/**
 * HTTP transport: `POST <base>/v1/publish` and `POST <base>/v1/poll` with
 * one client packet as the body and the token as a Bearer header. Replies are
 * `[u32 LE len][server packet]...`.
 */
export class HttpTransport implements RequestTransport {
  readonly kind = 'http' as const;

  constructor(
    private readonly impl?: FetchLike,
    private readonly maxPacketBytes = 1 << 24,
  ) {}

  private fetchFn(): FetchLike | undefined {
    if (this.impl) return this.impl;
    const f = (globalThis as { fetch?: FetchLike }).fetch;
    return f ? f.bind(globalThis) : undefined;
  }

  available(): boolean {
    return typeof this.fetchFn() === 'function';
  }

  async request(base: string, path: HttpPath, token: string, packet: Uint8Array, signal?: AbortSignal): Promise<HttpReply> {
    const fetchFn = this.fetchFn();
    if (!fetchFn) throw new TransportError('no fetch implementation in this runtime');
    const url = base.replace(/\/+$/, '') + path;
    let res: Awaited<ReturnType<FetchLike>>;
    let body: ArrayBuffer;
    try {
      res = await fetchFn(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
          Accept: 'application/octet-stream',
        },
        body: packet,
        signal,
      });
      body = await res.arrayBuffer();
    } catch (e) {
      const aborted = signal?.aborted ?? (e as { name?: string })?.name === 'AbortError';
      throw new TransportError(aborted ? 'request aborted' : `request to ${path} failed`, aborted, e);
    }
    const contentType = res.headers.get('content-type') ?? '';
    // A proxy or load balancer answered instead of the node.
    if (!contentType.includes('application/octet-stream')) {
      if (res.status >= 200 && res.status < 300) {
        throw new TransportError(`unexpected content type "${contentType}" from ${path}`);
      }
      return { status: res.status, packets: [], retryAfterMs: retryAfter(res.headers.get('retry-after')) };
    }
    return {
      status: res.status,
      packets: splitLengthPrefixed(new Uint8Array(body), this.maxPacketBytes),
      retryAfterMs: retryAfter(res.headers.get('retry-after')),
    };
  }
}
