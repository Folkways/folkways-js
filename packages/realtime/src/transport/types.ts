/**
 * Layer 3 contracts. Transports move RTE packets as bytes and know nothing
 * about topics, tokens' meaning or frames: the engine (layer 2) does.
 */

export type TransportKind = 'websocket' | 'http';

export interface StreamCloseEvent {
  /** WebSocket close code (1006 when the connection dropped without one). */
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
}

/** An open, duplex, message-oriented connection carrying one packet per message. */
export interface StreamConnection {
  send(packet: Uint8Array): void;
  close(code?: number, reason?: string): void;
  /** Bytes queued but not yet sent, when the platform reports it. */
  readonly bufferedAmount: number;
  onPacket: (packet: Uint8Array) => void;
  /** A message the transport could not accept (e.g. a text frame). */
  onProtocolError: (message: string) => void;
  onClose: (e: StreamCloseEvent) => void;
}

export interface StreamTransport {
  readonly kind: 'websocket';
  /** True when this runtime can use the transport. */
  available(): boolean;
  /**
   * Opens a connection. Rejects with `TransportError` if the connection
   * cannot be established (or `signal` aborts first).
   */
  connect(url: string, signal?: AbortSignal): Promise<StreamConnection>;
}

export type HttpPath = '/v1/publish' | '/v1/poll';

export interface HttpReply {
  readonly status: number;
  /** The server packets of the body, in order. */
  readonly packets: Uint8Array[];
  /** `Retry-After` in milliseconds, when the response carried one. */
  readonly retryAfterMs?: number;
}

/** A request/response transport: one client packet in, a list of server packets out. */
export interface RequestTransport {
  readonly kind: 'http';
  available(): boolean;
  request(baseUrl: string, path: HttpPath, token: string, packet: Uint8Array, signal?: AbortSignal): Promise<HttpReply>;
}

/** The transport failed below the protocol (DNS, TCP, TLS, HTTP framing, aborted). */
export class TransportError extends Error {
  override readonly name = 'TransportError';
  constructor(
    message: string,
    readonly aborted = false,
    readonly cause?: unknown,
  ) {
    super(message);
  }
}
