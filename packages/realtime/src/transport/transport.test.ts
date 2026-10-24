import { describe, expect, it } from 'vitest';

import { encodeServerPacket } from '../../test/support/server-codec';
import { type FetchLike, HttpTransport } from './http';
import { joinLengthPrefixed, splitLengthPrefixed } from './length-prefixed';
import { TransportError } from './types';
import { type WebSocketLike, WebSocketTransport } from './websocket';

describe('length-prefixed bodies', () => {
  it('splits u32-LE prefixed packets', () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([4]);
    expect(splitLengthPrefixed(joinLengthPrefixed([a, b]))).toEqual([a, b]);
    expect(splitLengthPrefixed(new Uint8Array(0))).toEqual([]);
  });

  it('rejects truncated, empty and oversized packets', () => {
    const body = joinLengthPrefixed([new Uint8Array(10)]);
    expect(() => splitLengthPrefixed(body.subarray(0, 3))).toThrow(TransportError);
    expect(() => splitLengthPrefixed(body.subarray(0, 8))).toThrow(/truncated/);
    expect(() => splitLengthPrefixed(new Uint8Array(4))).toThrow(/empty/);
    expect(() => splitLengthPrefixed(body, 5)).toThrow(/exceeds/);
  });
});

describe('HttpTransport', () => {
  function fetchReturning(status: number, body: Uint8Array, contentType = 'application/octet-stream') {
    const seen: { url: string; headers: Record<string, string>; body: Uint8Array }[] = [];
    const f: FetchLike = async (url, init) => {
      seen.push({ url, headers: init.headers, body: init.body });
      return {
        status,
        headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? contentType : n === 'retry-after' ? '2' : null) },
        arrayBuffer: async () => body.slice().buffer,
      };
    };
    return { f, seen };
  }

  it('posts the packet with a Bearer token and splits the reply', async () => {
    const packet = encodeServerPacket([{ corr: 1n, msg: { type: 'opOk' } }]);
    const { f, seen } = fetchReturning(200, joinLengthPrefixed([packet, packet]));
    const t = new HttpTransport(f);
    const reply = await t.request('http://node:3000/', '/v1/publish', 'tok', new Uint8Array([9]));
    expect(seen[0]!.url).toBe('http://node:3000/v1/publish');
    expect(seen[0]!.headers.Authorization).toBe('Bearer tok');
    expect(seen[0]!.headers['Content-Type']).toBe('application/octet-stream');
    expect(reply.packets).toHaveLength(2);
    expect(reply.retryAfterMs).toBe(2000);
  });

  it('treats a non-RTE error page as a bare status', async () => {
    const { f } = fetchReturning(502, new TextEncoder().encode('<html>bad gateway</html>'), 'text/html');
    const reply = await new HttpTransport(f).request('http://n', '/v1/poll', 't', new Uint8Array(1));
    expect(reply).toMatchObject({ status: 502, packets: [] });
  });

  it('wraps network failures and aborts in TransportError', async () => {
    const t = new HttpTransport(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(t.request('http://n', '/v1/poll', 't', new Uint8Array(1))).rejects.toMatchObject({ name: 'TransportError', aborted: false });
    const ac = new AbortController();
    ac.abort();
    const t2 = new HttpTransport(async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    await expect(t2.request('http://n', '/v1/poll', 't', new Uint8Array(1), ac.signal)).rejects.toMatchObject({ aborted: true });
  });
});

class FakeWs implements WebSocketLike {
  static last?: FakeWs;
  binaryType = 'blob';
  readyState = 0;
  bufferedAmount = 0;
  sent: unknown[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string; wasClean?: boolean }) => void) | null = null;
  constructor(readonly url: string) {
    FakeWs.last = this;
  }
  send(data: ArrayBufferView | ArrayBuffer): void {
    this.sent.push(data);
  }
  close(code?: number): void {
    this.readyState = 3;
    this.onclose?.({ code, wasClean: true });
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
}

describe('WebSocketTransport', () => {
  it('opens in arraybuffer mode, passes binary messages up and flags text', async () => {
    const t = new WebSocketTransport(FakeWs);
    const p = t.connect('ws://node/v1/ws');
    const ws = FakeWs.last!;
    expect(ws.binaryType).toBe('arraybuffer');
    ws.open();
    const conn = await p;
    const got: Uint8Array[] = [];
    const errors: string[] = [];
    conn.onPacket = (b) => got.push(b);
    conn.onProtocolError = (m) => errors.push(m);
    ws.onmessage!({ data: new Uint8Array([1, 2]).buffer });
    ws.onmessage!({ data: 'text' });
    expect(got).toEqual([new Uint8Array([1, 2])]);
    expect(errors).toHaveLength(1);
    conn.send(new Uint8Array([3]));
    expect(ws.sent).toHaveLength(1);
    const closes: number[] = [];
    conn.onClose = (e) => closes.push(e.code);
    ws.onclose!({ code: 1006 });
    expect(closes).toEqual([1006]);
  });

  it('rejects when the socket closes before opening, and when aborted', async () => {
    const t = new WebSocketTransport(FakeWs);
    const p = t.connect('ws://node/v1/ws');
    FakeWs.last!.onclose!({ code: 1006 });
    await expect(p).rejects.toBeInstanceOf(TransportError);
    const ac = new AbortController();
    const q = t.connect('ws://node/v1/ws', ac.signal);
    ac.abort();
    await expect(q).rejects.toMatchObject({ aborted: true });
  });

  it('is unavailable without a WebSocket implementation', () => {
    const g = globalThis as { WebSocket?: unknown };
    const saved = g.WebSocket;
    g.WebSocket = undefined;
    try {
      expect(new WebSocketTransport().available()).toBe(false);
      expect(new WebSocketTransport(FakeWs).available()).toBe(true);
    } finally {
      g.WebSocket = saved;
    }
  });
});
