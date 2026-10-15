/** A minimal typed event emitter. Listener errors never break the emitter. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type EventMap = Record<string, (...args: any[]) => void>;

export class Emitter<E extends EventMap> {
  private listeners = new Map<keyof E, Set<E[keyof E]>>();
  /** Called when a listener throws; defaults to rethrowing asynchronously. */
  protected onListenerError: (err: unknown) => void = (err) => {
    setTimeout(() => {
      throw err;
    }, 0);
  };

  /** Adds a listener. Returns a function that removes it. */
  on<K extends keyof E>(event: K, fn: E[K]): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn);
    return () => this.off(event, fn);
  }

  once<K extends keyof E>(event: K, fn: E[K]): () => void {
    const wrapped = ((...args: Parameters<E[K]>) => {
      off();
      fn(...args);
    }) as E[K];
    const off = this.on(event, wrapped);
    return off;
  }

  off<K extends keyof E>(event: K, fn: E[K]): void {
    this.listeners.get(event)?.delete(fn);
  }

  protected emit<K extends keyof E>(event: K, ...args: Parameters<E[K]>): void {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;
    for (const fn of [...set]) {
      try {
        fn(...args);
      } catch (err) {
        this.onListenerError(err);
      }
    }
  }

  protected listenerCount<K extends keyof E>(event: K): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  protected removeAllListeners(): void {
    this.listeners.clear();
  }
}
