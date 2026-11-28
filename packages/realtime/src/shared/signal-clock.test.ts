import { describe, expect, it } from 'vitest';
import { signalDeadlineFromPacket, signalTimerDelay } from './signal-clock';

describe('signal lifetime', () => {
  it('uses remaining service time, not the local wall clock', () => {
    const service = (1n << 63n) + 1_000n;
    expect(signalDeadlineFromPacket(service + 50n, service, 100)).toBe(150);
    expect(signalDeadlineFromPacket(service - 50n, service, 100)).toBe(100);
    expect(signalDeadlineFromPacket(service, service, 100)).toBe(100);
  });
  it('distinguishes legacy metadata, indefinite lifetime and the longest valid lifetime', () => {
    expect(signalDeadlineFromPacket(0n, 100n, 50)).toBeUndefined();
    expect(signalDeadlineFromPacket(200n, 0n, 50)).toBeUndefined();
    expect(signalDeadlineFromPacket((1n << 64n) - 1n, 100n, 50)).toBe(Infinity);
    expect(signalDeadlineFromPacket(100n + 0xffffffffn, 100n, 50)).toBe(50 + 0xffffffff);
    expect(signalTimerDelay(50 + 0xffffffff, 50)).toBe(0x7fffffff);
    expect(signalTimerDelay(51.3, 50)).toBe(2);
    expect(signalTimerDelay(49, 50)).toBe(1);
  });
});
