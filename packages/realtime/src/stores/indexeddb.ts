/**
 * IndexedDB store for browsers: `@folkwaysio/realtime/stores/indexeddb`.
 *
 *   const client = new Folkways.Realtime({ url, authUrl, store: indexedDbStore() });
 *
 * Several tabs share one database: cursors only move forward and outbox
 * entries carry idempotency keys, so sharing is safe.
 */
import type { Store } from '../engine';

const STORE = 'kv';

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** An IndexedDB implementation other than the global one (tests, workers). */
export interface IndexedDbImpl {
  readonly indexedDB: IDBFactory;
  readonly IDBKeyRange: typeof IDBKeyRange;
}

/** A persistent store in IndexedDB database `name` (default `folkways`). */
export function indexedDbStore(name = 'folkways', impl?: IndexedDbImpl): Store {
  const g = globalThis as Partial<IndexedDbImpl>;
  const idb = impl?.indexedDB ?? g.indexedDB;
  const Range = impl?.IDBKeyRange ?? g.IDBKeyRange;
  if (!idb || !Range) throw new Error('indexedDbStore needs IndexedDB (browsers); use memoryStore() or fileStore() elsewhere');
  let db: Promise<IDBDatabase> | undefined;
  const open = (): Promise<IDBDatabase> =>
    (db ??= new Promise((resolve, reject) => {
      const req = idb.open(name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  const tx = async (mode: IDBTransactionMode) => (await open()).transaction(STORE, mode).objectStore(STORE);
  const range = (prefix: string) => Range.bound(prefix, `${prefix}\uffff`);
  return {
    persistent: true,
    async get(key) {
      const v = await promisify((await tx('readonly')).get(key));
      return typeof v === 'string' ? v : undefined;
    },
    async set(key, value) {
      await promisify((await tx('readwrite')).put(value, key));
    },
    async delete(key) {
      await promisify((await tx('readwrite')).delete(key));
    },
    async keys(prefix) {
      return (await promisify((await tx('readonly')).getAllKeys(range(prefix)))).map(String);
    },
    async clear(prefix) {
      await promisify((await tx('readwrite')).delete(range(prefix)));
    },
  };
}
