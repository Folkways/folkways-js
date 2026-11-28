/** Lifetimes use an unsigned 32-bit millisecond field on the wire. */
export function validTtlMs(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}
