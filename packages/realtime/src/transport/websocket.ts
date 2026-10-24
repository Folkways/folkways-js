import { type StreamCloseEvent, type StreamConnection, type StreamTransport, TransportError } from './types';

/** The subset of the WebSocket API the transport uses (browser, Node 22+, `ws`, React Native). */
export interface WebSocketLike {
  binaryType: string;
  readonly readyState: number;
  readonly bufferedAmount?: number;
  send(data: ArrayBufferView | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code?: number; reason?: string; wasClean?: boolean }) => void) | null;
}

export type WebSocketConstructor = new (url: string) => WebSocketLike;

const OPEN = 1;

function toBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  // `ws` delivers a list of Buffers when a message arrives in fragments.
  if (Array.isArray(data) && data.every((d) => ArrayBuffer.isView(d))) {
    const parts = data as ArrayBufferView[];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    let at = 0;
    for (const p of parts) {
      out.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), at);
      at += p.byteLength;
    }
    return out;
  }
  return undefined;
}

class WsConnection implements StreamConnection {
  onPacket: (packet: Uint8Array) => void = () => {};
  onProtocolError: (message: string) => void = () => {};
  onClose: (e: StreamCloseEvent) => void = () => {};
  private closed = false;

  constructor(private readonly ws: WebSocketLike) {
    ws.onmessage = (ev) => {
      if (this.closed) return;
      const bytes = toBytes(ev.data);
      if (bytes) this.onPacket(bytes);
      else this.onProtocolError('received a non-binary WebSocket message');
    };
    ws.onerror = () => {
      // Followed by onclose, which reports the end of the connection.
    };
    ws.onclose = (ev) => this.finish({ code: ev.code ?? 1006, reason: ev.reason ?? '', wasClean: ev.wasClean ?? false });
  }

  get bufferedAmount(): number {
    return this.ws.bufferedAmount ?? 0;
  }

  send(packet: Uint8Array): void {
    if (this.closed || this.ws.readyState !== OPEN) return;
    this.ws.send(packet);
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    try {
      this.ws.close(code, reason);
    } catch {
      this.ws.close();
    }
    // Do not wait for the close handshake: report the end now.
    this.finish({ code, reason, wasClean: true });
  }

  private finish(e: StreamCloseEvent): void {
    if (this.closed) return;
    this.closed = true;
    this.ws.onmessage = null;
    this.ws.onclose = null;
    this.ws.onerror = null;
    this.onClose(e);
  }
}

/** WebSocket transport: one RTE packet per binary message. */
export class WebSocketTransport implements StreamTransport {
  readonly kind = 'websocket' as const;

  constructor(private readonly impl?: WebSocketConstructor) {}

  private ctor(): WebSocketConstructor | undefined {
    return this.impl ?? (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket;
  }

  available(): boolean {
    return typeof this.ctor() === 'function';
  }

  connect(url: string, signal?: AbortSignal): Promise<StreamConnection> {
    const Ctor = this.ctor();
    if (!Ctor) return Promise.reject(new TransportError('no WebSocket implementation in this runtime'));
    return new Promise<StreamConnection>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new TransportError('connect aborted', true));
        return;
      }
      let ws: WebSocketLike;
      try {
        ws = new Ctor(url);
      } catch (e) {
        reject(new TransportError(`cannot open ${url}`, false, e));
        return;
      }
      ws.binaryType = 'arraybuffer';
      const onAbort = () => {
        cleanup();
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new TransportError('connect aborted', true));
      };
      const cleanup = () => {
        signal?.removeEventListener('abort', onAbort);
        ws.onopen = null;
        ws.onclose = null;
        ws.onerror = null;
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      ws.onopen = () => {
        cleanup();
        resolve(new WsConnection(ws));
      };
      ws.onerror = () => {
        // onclose follows with the details.
      };
      ws.onclose = (ev) => {
        cleanup();
        reject(new TransportError(`WebSocket closed before opening (code ${ev.code ?? 1006})`));
      };
    });
  }
}
