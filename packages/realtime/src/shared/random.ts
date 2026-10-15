/** 128 random bits as two u64 halves, from the platform CSPRNG. */
export function random128(): { hi: bigint; lo: bigint } {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (!c?.getRandomValues) {
    throw new Error('crypto.getRandomValues is required (browsers, Node 20+, Deno, Bun)');
  }
  const b = c.getRandomValues(new Uint8Array(16));
  const v = new DataView(b.buffer);
  return { hi: v.getBigUint64(0), lo: v.getBigUint64(8) };
}

/** A random non-zero u64. */
export function randomU64(): bigint {
  const { hi } = random128();
  return hi === 0n ? 1n : hi;
}

/** Parses 32 hex digits or a UUID string into two u64 halves. */
export function parse128(s: string): { hi: bigint; lo: bigint } | undefined {
  const hex = s.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return undefined;
  return { hi: BigInt(`0x${hex.slice(0, 16)}`), lo: BigInt(`0x${hex.slice(16)}`) };
}

export function format128(v: { hi: bigint; lo: bigint }): string {
  return v.hi.toString(16).padStart(16, '0') + v.lo.toString(16).padStart(16, '0');
}
