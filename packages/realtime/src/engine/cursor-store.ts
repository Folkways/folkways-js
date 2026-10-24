import type { Cursor } from '../shared/cursor';

/**
 * Where the last processed cursor of each topic is kept, so a subscription
 * can resume after a reconnect or a reload. Methods may be async. Backed by
 * the store port (`ScopedStore.cursors()`).
 */
export interface CursorStore {
  get(topic: string): Cursor | undefined | Promise<Cursor | undefined>;
  set(topic: string, cursor: Cursor): void | Promise<void>;
  delete?(topic: string): void | Promise<void>;
}

/** Keeps cursors in memory (tests). */
export function memoryCursorStore(): CursorStore {
  const map = new Map<string, Cursor>();
  return {
    get: (topic) => map.get(topic),
    set: (topic, c) => {
      map.set(topic, c);
    },
    delete: (topic) => {
      map.delete(topic);
    },
  };
}
