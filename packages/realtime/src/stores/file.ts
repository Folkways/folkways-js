/// <reference types="node" />
/**
 * File store for Node: `@folkways/realtime/stores/file`.
 *
 *   const client = new Folkways.Realtime({ url, token, store: fileStore('.folkways') });
 *
 * One file per key, written atomically (temporary file, then rename).
 */
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Store } from '../engine';

const encode = (key: string) => encodeURIComponent(key).replace(/\./g, '%2E');
const decode = (file: string) => decodeURIComponent(file);

/** A persistent store in directory `dir` (created when missing). */
export function fileStore(dir: string): Store {
  let ready: Promise<unknown> | undefined;
  const ensure = () => (ready ??= mkdir(dir, { recursive: true }));
  let tmp = 0;
  const list = async () => {
    await ensure();
    return (await readdir(dir)).filter((f) => !f.endsWith('.tmp'));
  };
  return {
    persistent: true,
    async get(key) {
      try {
        return await readFile(join(dir, encode(key)), 'utf8');
      } catch (err) {
        if ((err as { code?: string }).code === 'ENOENT') return undefined;
        throw err;
      }
    },
    async set(key, value) {
      await ensure();
      const file = join(dir, encode(key));
      const part = `${file}.${process.pid}.${++tmp}.tmp`;
      await writeFile(part, value, 'utf8');
      await rename(part, file);
    },
    async delete(key) {
      await rm(join(dir, encode(key)), { force: true });
    },
    async keys(prefix) {
      return (await list()).map(decode).filter((k) => k.startsWith(prefix));
    },
    async clear(prefix) {
      for (const k of await this.keys(prefix)) await this.delete(k);
    },
  };
}
