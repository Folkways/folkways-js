import { TransportError } from './types';

/**
 * Splits an HTTP response body of `[u32 LE len][packet]...` into packets.
 * Returned packets are views into `body`.
 */
export function splitLengthPrefixed(body: Uint8Array, maxPacketBytes = Number.POSITIVE_INFINITY): Uint8Array[] {
  const out: Uint8Array[] = [];
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  let at = 0;
  while (at < body.length) {
    if (body.length - at < 4) throw new TransportError('truncated length prefix in response body');
    const len = view.getUint32(at, true);
    at += 4;
    if (len === 0) throw new TransportError('empty packet in response body');
    if (len > maxPacketBytes) throw new TransportError(`response packet of ${len} bytes exceeds the limit`);
    if (len > body.length - at) throw new TransportError('truncated packet in response body');
    out.push(body.subarray(at, at + len));
    at += len;
  }
  return out;
}

/** The inverse of `splitLengthPrefixed`; used by tests and tools. */
export function joinLengthPrefixed(packets: readonly Uint8Array[]): Uint8Array {
  const total = packets.reduce((n, p) => n + 4 + p.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let at = 0;
  for (const p of packets) {
    view.setUint32(at, p.length, true);
    out.set(p, at + 4);
    at += 4 + p.length;
  }
  return out;
}
