import type { LiveView } from './types';

/** A value with listeners: the backing of every `LiveView` the SDK hands out. */
export class Live<T> implements LiveView<T> {
  private readonly listeners = new Set<() => void>();

  constructor(
    private value: T,
    private readonly onListenerError: (err: unknown) => void = () => {},
  ) {}

  /** Bound, so it can be passed as is to useSyncExternalStore. */
  readonly getSnapshot = (): T => this.value;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Replaces the value and notifies, unless it is the same object. */
  set(value: T): void {
    if (Object.is(value, this.value)) return;
    this.value = value;
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch (err) {
        this.onListenerError(err);
      }
    }
  }
}
