import { type ClientFrame, encodeClientPacket } from '../transport';

export interface PacketLimits {
  maxFrameBytes: number;
  maxFramesPerPacket: number;
}

export interface Packet {
  readonly bytes: Uint8Array;
  readonly frames: readonly ClientFrame[];
}

export interface Packed {
  packets: Packet[];
  /** Frames that cannot fit in a packet even alone. */
  oversize: ClientFrame[];
}

/**
 * Packs frames, in order, into as few packets as the limits allow: at most
 * `maxFramesPerPacket` frames each, and at most `maxFrameBytes` bytes (a
 * group that encodes too large is split in half until it fits).
 */
export function packetize(frames: readonly ClientFrame[], limits: PacketLimits): Packed {
  const out: Packed = { packets: [], oversize: [] };
  const perPacket = Math.max(1, Math.min(64, limits.maxFramesPerPacket || 64));
  for (let i = 0; i < frames.length; i += perPacket) {
    pack(frames.slice(i, i + perPacket), limits.maxFrameBytes, out);
  }
  return out;
}

function pack(frames: ClientFrame[], maxBytes: number, out: Packed): void {
  if (frames.length === 0) return;
  const bytes = encodeClientPacket(frames);
  if (bytes.length <= maxBytes) {
    out.packets.push({ bytes, frames });
    return;
  }
  if (frames.length === 1) {
    out.oversize.push(frames[0]!);
    return;
  }
  const mid = Math.ceil(frames.length / 2);
  pack(frames.slice(0, mid), maxBytes, out);
  pack(frames.slice(mid), maxBytes, out);
}
