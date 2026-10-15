export interface BackoffOptions {
  initialDelayMs: number;
  maxDelayMs: number;
}

/**
 * Exponential backoff with full jitter: attempt n waits a uniformly random
 * time in [0, min(max, initial * 2^n)], but never less than the server's
 * `retry_after_ms`.
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
    return Math.max(floorMs, Math.floor(this.random() * cap));
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
