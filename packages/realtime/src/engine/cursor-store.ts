import { type Cursor, formatCursor, parseCursor } from '../shared/cursor';

/**
 * Where the last processed cursor of each topic is kept, so a subscription
 * can resume after a reconnect or a reload. Methods may be async.
 */
export interface CursorStore {
  get(topic: string): Cursor | undefined | Promise<Cursor | undefined>;
  set(topic: string, cursor: Cursor): void | Promise<void>;
  delete?(topic: string): void | Promise<void>;
}

/** Keeps cursors for the lifetime of the client (the default). */
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

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Persists cursors in `localStorage` (or any Storage-like object) as
 * `"epoch:seq"` under `<prefix>:<topic>`, so subscriptions resume across reloads.
 */
export function localStorageCursorStore(prefix = 'folkways:cursor', storage?: StorageLike): CursorStore {
  const s = storage ?? (globalThis as { localStorage?: StorageLike }).localStorage;
  if (!s) return memoryCursorStore();
  const k = (topic: string) => `${prefix}:${topic}`;
  return {
    get: (topic) => {
      try {
        return parseCursor(s.getItem(k(topic)));
      } catch {
        return undefined;
      }
    },
    set: (topic, c) => {
      try {
        s.setItem(k(topic), formatCursor(c));
      } catch {
        // Quota or privacy mode: resuming falls back to the in-memory cursor.
      }
    },
    delete: (topic) => {
      try {
        s.removeItem(k(topic));
      } catch {
        /* ignore */
      }
    },
  };
}
