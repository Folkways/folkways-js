import type { Logger } from '../shared/logger';
import type { TransportKind } from '../transport';

/**
 * Chooses the transport for the next connection attempt: the first one in
 * the preference list this runtime and configuration can use. After
 * `fallbackAfter` consecutive transport-level failures (no session opened)
 * it moves to the next one and stays there.
 */
export class TransportSelector {
  private index = 0;
  private failures = 0;

  constructor(
    private readonly prefs: readonly TransportKind[],
    private readonly usable: (k: TransportKind) => boolean,
    private readonly fallbackAfter: number,
    private readonly log: Logger,
  ) {}

  current(): TransportKind | undefined {
    for (let i = this.index; i < this.prefs.length; i++) {
      const k = this.prefs[i]!;
      if (this.usable(k)) {
        this.index = i;
        return k;
      }
    }
    return undefined;
  }

  /** Records a failure below the protocol. Returns true if it switched transports. */
  transportFailed(): boolean {
    this.failures++;
    if (this.failures < this.fallbackAfter) return false;
    const from = this.current();
    for (let i = this.index + 1; i < this.prefs.length; i++) {
      if (this.usable(this.prefs[i]!)) {
        this.log.info('falling back to the next transport', { from, to: this.prefs[i], failures: this.failures });
        this.index = i;
        this.failures = 0;
        return true;
      }
    }
    return false;
  }

  opened(): void {
    this.failures = 0;
  }

  /** True when `kind` is preferred over the current transport and usable here. */
  canMoveBack(kind: TransportKind): boolean {
    const i = this.prefs.indexOf(kind);
    return i >= 0 && i < this.index && this.usable(kind);
  }

  /** Returns to a preferred transport (a probe showed it works again). */
  moveBack(kind: TransportKind): void {
    if (!this.canMoveBack(kind)) return;
    this.log.info('moving back to a preferred transport', { to: kind });
    this.index = this.prefs.indexOf(kind);
    this.failures = 0;
  }
}
