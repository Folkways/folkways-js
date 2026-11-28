const NO_EXPIRY = (1n << 64n) - 1n;
const MAX_TTL = 0xffffffffn;
const MAX_TIMER = 0x7fffffff;

/** Monotonic time when the runtime provides it; wall-clock fallback otherwise. */
export function signalNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

/** Convert the service deadline to a local deadline without comparing wall clocks. */
export function signalDeadlineFromPacket(expiry: bigint, serverTime: bigint, receivedAt: number): number | undefined {
  if (expiry === 0n) return undefined;
  if (expiry === NO_EXPIRY) return Infinity;
  if (serverTime === 0n) return undefined;
  const remaining = expiry - serverTime;
  return receivedAt + Number(remaining <= 0n ? 0n : remaining > MAX_TTL ? MAX_TTL : remaining);
}

/** Long signal lifetimes must not overflow the runtime's signed 32-bit timer. */
export function signalTimerDelay(deadline: number, now: number): number {
  return Math.min(MAX_TIMER, Math.max(1, Math.ceil(deadline - now)));
}
