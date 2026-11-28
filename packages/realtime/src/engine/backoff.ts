export interface BackoffOptions {
  initialDelayMs: number;
  maxDelayMs: number;
}

/**
 * Exponential backoff with full jitter: attempt n waits a uniformly random
 * time in [0, cap], cap = min(max, initial * 2^n). With the server's
 * `retry_after_ms` as a floor it waits floor + [0, min(cap, floor)] instead,
 * so clients told the same wait (a rate-limited segment) do not all
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

/** How long a long poll must have been held for the node to count as having waited. */
export const POLL_HELD_MS = 250;

/**
 * Paces long polls that come back at once with nothing new: a
 * poll the node answered immediately, without new events and without
 * holding it, waits before the next one. The wait starts around
 * `initialDelayMs`, doubles to around `maxDelayMs`, with ±20% jitter so a
 * herd spreads out, and resets once a poll brings data or is really held.
 * Whatever the long-poll settings, a poll group then sends at most a few
 * requests per second.
 */
export class PollPacer {
  private readonly backoff: Backoff;

  constructor(
    private readonly opts: BackoffOptions = { initialDelayMs: 250, maxDelayMs: 2_000 },
    private readonly random: () => number = Math.random,
  ) {
    this.backoff = new Backoff(opts, random);
  }

  /**
   * The wait before the next poll. `progress`: the reply carried new events
   * or a new position; `elapsedMs`: how long the poll took; `waitMs`: what
   * it asked the node to wait.
   */
  next(progress: boolean, elapsedMs: number, waitMs: number): number {
    const held = waitMs > 0 && elapsedMs >= Math.max(POLL_HELD_MS, waitMs / 2);
    if (progress || held) {
      this.backoff.reset();
      return 0;
    }
    const cap = Math.min(this.opts.maxDelayMs, this.opts.initialDelayMs * 2 ** Math.min(this.backoff.attempts, 30));
    this.backoff.next();
    return Math.round(cap * (0.8 + 0.4 * this.random()));
  }

  get attempts(): number {
    return this.backoff.attempts;
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
