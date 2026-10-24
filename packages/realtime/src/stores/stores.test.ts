import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterAll, describe, expect, it } from 'vitest';

import { type Store, memoryStore } from '../engine';
import { asyncStorageStore } from './async-storage';
import { fileStore } from './file';
import { indexedDbStore } from './indexeddb';

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

function fakeAsyncStorage() {
  const m = new Map<string, string>();
  return {
    getItem: async (k: string) => m.get(k) ?? null,
    setItem: async (k: string, v: string) => void m.set(k, v),
    removeItem: async (k: string) => void m.delete(k),
    getAllKeys: async () => [...m.keys()],
    raw: m,
  };
}

const cases: [string, () => Promise<Store>][] = [
  ['memoryStore', async () => memoryStore()],
  [
    'fileStore',
    async () => {
      const d = await mkdtemp(join(tmpdir(), 'fw-store-'));
      dirs.push(d);
      return fileStore(join(d, 'nested'));
    },
  ],
  ['asyncStorageStore', async () => asyncStorageStore(fakeAsyncStorage())],
  ['indexedDbStore', async () => indexedDbStore(`t${Math.random()}`, { indexedDB: new IDBFactory(), IDBKeyRange })],
];

describe.each(cases)('%s follows the store contract', (_name, make) => {
  it('gets, sets, lists by prefix, deletes and clears by prefix', async () => {
    const s = await make();
    expect(await s.get('fw/a/b/c/x')).toBeUndefined();
    await s.set('fw/a/b/c/chat%2F1', '1:2');
    await s.set('fw/a/b/c/chat%2F2', '1:3');
    await s.set('fw/a/b/o/0001-key', '{"x":1}');
    await s.set('fw/a/other/c/y', 'z');
    expect(await s.get('fw/a/b/c/chat%2F1')).toBe('1:2');
    expect((await s.keys('fw/a/b/c/')).sort()).toEqual(['fw/a/b/c/chat%2F1', 'fw/a/b/c/chat%2F2']);
    await s.set('fw/a/b/c/chat%2F1', '1:9');
    expect(await s.get('fw/a/b/c/chat%2F1')).toBe('1:9');
    await s.delete('fw/a/b/c/chat%2F2');
    expect(await s.keys('fw/a/b/c/')).toEqual(['fw/a/b/c/chat%2F1']);
    await s.clear('fw/a/b/');
    expect(await s.keys('fw/a/b/')).toEqual([]);
    expect(await s.get('fw/a/other/c/y')).toBe('z');
  });
});

describe('adapters', () => {
  it('are persistent, except the memory store', async () => {
    expect(memoryStore().persistent).toBe(false);
    for (const [name, make] of cases.slice(1)) expect([name, (await make()).persistent]).toEqual([name, true]);
  });

  it('namespaces AsyncStorage keys so other app data is untouched', async () => {
    const as = fakeAsyncStorage();
    as.raw.set('app:settings', '{}');
    const s = asyncStorageStore(as);
    await s.set('fw/x', '1');
    await s.clear('');
    expect([...as.raw.keys()]).toEqual(['app:settings']);
  });

  it('reads back what another file store instance wrote (a restart)', async () => {
    const d = await mkdtemp(join(tmpdir(), 'fw-store-'));
    dirs.push(d);
    await fileStore(d).set('fw/s/u/o/1-k', 'kept');
    expect(await fileStore(d).get('fw/s/u/o/1-k')).toBe('kept');
  });

  it('explains when IndexedDB is missing', () => {
    expect(() => indexedDbStore()).toThrow(/IndexedDB/);
  });
});
