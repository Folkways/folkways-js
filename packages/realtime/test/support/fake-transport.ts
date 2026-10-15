/**
 * In-memory transports with a scriptable "node" side, for engine tests.
 */
import type { ClientFrame, ClientMsg, ServerFrame, ServerMsg } from '../../src/transport/wire/model';
import { DEFAULT_LIMITS, type Limits } from '../../src/transport/wire/model';
import {
  type HttpPath,
  type HttpReply,
  type RequestTransport,
  type StreamCloseEvent,
  type StreamConnection,
  type StreamTransport,
  TransportError,
} from '../../src/transport/types';
import { decodeClientPacket, encodeServerPacket } from './server-codec';

type Waiter = { type?: ClientMsg['type']; resolve: (f: ClientFrame) => void };

/** One client connection, seen from the node. */
export class FakeConn implements StreamConnection {
  onPacket: (packet: Uint8Array) => void = () => {};
  onProtocolError: (message: string) => void = () => {};
  onClose: (e: StreamCloseEvent) => void = () => {};
  bufferedAmount = 0;
  closed = false;
  /** Every frame the client sent, in order. */
  readonly received: ClientFrame[] = [];
  /** Packets the client sent. */
  packets = 0;
  private unread: ClientFrame[] = [];
  private waiters: Waiter[] = [];

  // ---- client side
  send(packet: Uint8Array): void {
    if (this.closed) return;
    this.packets++;
    for (const f of decodeClientPacket(packet)) {
      this.received.push(f);
      const i = this.waiters.findIndex((w) => !w.type || w.type === f.msg.type);
      if (i >= 0) {
        const [w] = this.waiters.splice(i, 1);
        w!.resolve(f);
      } else {
        this.unread.push(f);
      }
    }
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose({ code, reason, wasClean: true });
  }

  // ---- node side
  /** The next frame of `type` the client sends (skipping others of different types). */
  next<T extends ClientMsg['type']>(type?: T, timeoutMs = 3_000): Promise<ClientFrame & { msg: Extract<ClientMsg, { type: T }> }> {
    const i = this.unread.findIndex((f) => !type || f.msg.type === type);
    if (i >= 0) return Promise.resolve(this.unread.splice(i, 1)[0] as never);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no ${type ?? 'frame'} within ${timeoutMs} ms`)), timeoutMs);
      this.waiters.push({
        type,
        resolve: (f) => {
          clearTimeout(t);
          resolve(f as never);
        },
      });
    });
  }

  sent(type: ClientMsg['type']): ClientFrame[] {
    return this.received.filter((f) => f.msg.type === type);
  }

  push(...frames: ServerFrame[]): void {
    if (!this.closed) this.onPacket(encodeServerPacket(frames));
  }

  reply(corr: bigint, msg: ServerMsg): void {
    this.push({ corr, msg });
  }

  /** Answers the Hello with a Welcome. */
  async welcome(opts: { identity?: string; limits?: Partial<Limits>; expiresAtMs?: number } = {}): Promise<ClientFrame> {
    const hello = await this.next('hello');
    this.reply(hello.corr, {
      type: 'welcome',
      protoMinor: 0,
      server: 'fake',
      serverTimeMs: Date.now(),
      sessionId: { hi: 1n, lo: 2n },
      resumed: false,
      identity: opts.identity ?? 'alice',
      expiresAtMs: opts.expiresAtMs ?? Date.now() + 600_000,
      limits: { ...DEFAULT_LIMITS, ...opts.limits },
      features: [],
    });
    return hello;
  }

  /** Sends an RTE Close, then drops the socket like the node does. */
  serverClose(code: number, reason = '', retryAfterMs = 0): void {
    this.push({ corr: 0n, msg: { type: 'close', code, reason, retryAfterMs } });
    this.drop(1008);
  }

  /** The connection dies without a Close (network loss). */
  drop(code = 1006): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose({ code, reason: '', wasClean: false });
  }
}

export class FakeStreamTransport implements StreamTransport {
  readonly kind = 'websocket' as const;
  readonly conns: FakeConn[] = [];
  /** Connect attempts to refuse before accepting. */
  refuse = 0;
  attempts = 0;
  private waiters: ((c: FakeConn) => void)[] = [];

  available(): boolean {
    return true;
  }

  async connect(): Promise<StreamConnection> {
    this.attempts++;
    if (this.refuse > 0) {
      this.refuse--;
      throw new TransportError('connection refused');
    }
    const c = new FakeConn();
    this.conns.push(c);
    const w = this.waiters.shift();
    if (w) queueMicrotask(() => w(c));
    return c;
  }

  /** The next connection the client opens (or the latest unclaimed one). */
  nextConn(timeoutMs = 3_000): Promise<FakeConn> {
    const claimed = this.claimed;
    if (this.conns.length > claimed) {
      this.claimed++;
      return Promise.resolve(this.conns[claimed]!);
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no connection')), timeoutMs);
      this.waiters.push((c) => {
        clearTimeout(t);
        this.claimed++;
        resolve(c);
      });
    });
  }

  private claimed = 0;
}

export type HttpHandler = (
  path: HttpPath,
  token: string,
  frames: ClientFrame[],
  signal?: AbortSignal,
) => Promise<{ status?: number; frames: ServerFrame[] }> | { status?: number; frames: ServerFrame[] };

export class FakeRequestTransport implements RequestTransport {
  readonly kind = 'http' as const;
  readonly calls: { path: HttpPath; token: string; frames: ClientFrame[] }[] = [];

  constructor(public handler: HttpHandler) {}

  available(): boolean {
    return true;
  }

  async request(_base: string, path: HttpPath, token: string, packet: Uint8Array, signal?: AbortSignal): Promise<HttpReply> {
    if (signal?.aborted) throw new TransportError('aborted', true);
    const frames = decodeClientPacket(packet);
    this.calls.push({ path, token, frames });
    const out = await this.handler(path, token, frames, signal);
    if (signal?.aborted) throw new TransportError('aborted', true);
    return { status: out.status ?? 200, packets: out.frames.map((f) => encodeServerPacket([f])) };
  }
}

/** Resolves when `fn` returns truthy (polling every 5 ms). */
export async function until<T>(fn: () => T, timeoutMs = 3_000, what = 'condition'): Promise<NonNullable<T>> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
