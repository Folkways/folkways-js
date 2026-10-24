/**
 * A position in a topic: the event with this `seq` in this `epoch`.
 *
 * Both are u64 on the wire and are carried as `bigint`: epochs are large
 * (they derive from a clock) and exceed `Number.MAX_SAFE_INTEGER`.
 */
export interface Cursor {
  readonly epoch: bigint;
  readonly seq: bigint;
}

export function cursor(epoch: bigint | number | string, seq: bigint | number | string): Cursor {
  return { epoch: BigInt(epoch), seq: BigInt(seq) };
}

/** `"epoch:seq"`, the form used for storage and `Message.id`. */
export function formatCursor(c: Cursor): string {
  return `${c.epoch}:${c.seq}`;
}

/** Parses `"epoch:seq"`. Returns `undefined` for anything else. */
export function parseCursor(s: string | null | undefined): Cursor | undefined {
  if (!s) return undefined;
  const m = /^(\d{1,20}):(\d{1,20})$/.exec(s.trim());
  if (!m) return undefined;
  const epoch = BigInt(m[1]!);
  const seq = BigInt(m[2]!);
  const max = (1n << 64n) - 1n;
  if (epoch > max || seq > max) return undefined;
  return { epoch, seq };
}

export function sameCursor(a: Cursor | undefined, b: Cursor | undefined): boolean {
  return !!a && !!b && a.epoch === b.epoch && a.seq === b.seq;
}

/**
 * True when `c` comes strictly after `ref` in the same epoch. Events from a
 * different epoch are never "after" (the node reports the change with a Gap).
 */
export function isAfter(c: Cursor, ref: Cursor | undefined): boolean {
  if (!ref) return true;
  if (c.epoch !== ref.epoch) return true;
  return c.seq > ref.seq;
}
