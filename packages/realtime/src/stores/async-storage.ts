/**
 * React Native store: `@folkways/realtime/stores/async-storage`.
 *
 *   import AsyncStorage from '@react-native-async-storage/async-storage';
 *   const client = new Folkways.Realtime({ url, authUrl, store: asyncStorageStore(AsyncStorage) });
 *
 * Takes the AsyncStorage object, so the SDK has no React Native dependency.
 */
import type { Store } from '../engine';

/** The part of `@react-native-async-storage/async-storage` the store uses. */
export interface AsyncStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  getAllKeys(): Promise<readonly string[]>;
  multiRemove?(keys: readonly string[]): Promise<void>;
}

/** A persistent store over AsyncStorage; every key is namespaced under `prefix`. */
export function asyncStorageStore(storage: AsyncStorageLike, prefix = '@folkways/'): Store {
  const k = (key: string) => prefix + key;
  const keys = async (p: string) =>
    (await storage.getAllKeys()).filter((key) => key.startsWith(prefix + p)).map((key) => key.slice(prefix.length));
  return {
    persistent: true,
    async get(key) {
      return (await storage.getItem(k(key))) ?? undefined;
    },
    set: (key, value) => storage.setItem(k(key), value),
    delete: (key) => storage.removeItem(k(key)),
    keys,
    async clear(p) {
      const all = (await keys(p)).map(k);
      if (storage.multiRemove) await storage.multiRemove(all);
      else for (const key of all) await storage.removeItem(key);
    },
  };
}
