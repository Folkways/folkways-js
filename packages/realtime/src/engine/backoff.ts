export interface BackoffOptions {
  initialDelayMs: number;
  maxDelayMs: number;
}

/**
 * Exponential backoff with full jitter: attempt n waits a uniformly random
 * time in [0, cap], cap = min(max, initial * 2^n). With the server's
 * `retry_after_ms` as a floor it waits floor + [0, min(cap, floor)] instead,
 * so clients told the same wait (a rate-limited segment, FLK-21) do not all
 * come back at the same instant.
 */
export class Backoff {
  private attempt = 0;

  constructor(
    private readonly opts: BackoffOptions,
    private readonly random: () => number = Math.random,
  ) {}

  get attempts(): number {
    return this.attempt;
  }

  next(floorMs = 0): number {
    const cap = Math.min(this.opts.maxDelayMs, this.opts.initialDelayMs * 2 ** Math.min(this.attempt, 30));
    this.attempt++;
    if (floorMs > 0) return floorMs + Math.floor(this.random() * Math.min(cap, floorMs));
    return Math.floor(this.random() * cap);
  }

  reset(): void {
    this.attempt = 0;
  }
}

/** Resolves after `ms`, or early when `signal` aborts. Never rejects. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted || ms <= 0) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}
