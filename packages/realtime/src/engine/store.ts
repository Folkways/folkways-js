import { type Cursor, formatCursor, parseCursor } from '../shared/cursor';
import type { Logger } from '../shared/logger';
import { topicMatches } from '../shared/topic';
import type { WireCapability } from '../transport';
import type { CursorStore } from './cursor-store';

/**
 * The local store port (ADR-001 D5): a small string key-value interface.
 * Methods may be async. Only the engine writes to it.
 */
export interface Store {
  get(key: string): string | undefined | Promise<string | undefined>;
  set(key: string, value: string): void | Promise<void>;
  delete(key: string): void | Promise<void>;
  /** Every key starting with `prefix`. */
  keys(prefix: string): string[] | Promise<string[]>;
  /** Deletes every key starting with `prefix`. */
  clear(prefix: string): void | Promise<void>;
  /** True when data survives a reload (turns on the persistent outbox). */
  readonly persistent: boolean;
}

/** Optional encryption at rest for payloads written to a persistent store. */
export interface StoreCipher {
  encrypt(plain: string): string | Promise<string>;
  decrypt(cipher: string): string | Promise<string>;
}

/** Keeps everything in memory for the client's lifetime (the default). */
export function memoryStore(): Store {
  const map = new Map<string, string>();
  return {
    persistent: false,
    get: (k) => map.get(k),
    set: (k, v) => {
      map.set(k, v);
    },
    delete: (k) => {
      map.delete(k);
    },
    keys: (prefix) => [...map.keys()].filter((k) => k.startsWith(prefix)),
    clear: (prefix) => {
      for (const k of [...map.keys()]) if (k.startsWith(prefix)) map.delete(k);
    },
  };
}

/** Where one segment/identity's data lives: `fw/{segment}/{identity}/`. Anonymous sessions share `~anon`. */
export function scopePrefix(segment: string | undefined, identity: string | undefined, anonymous: boolean): string {
  const who = anonymous || !identity ? '~anon' : encodeURIComponent(identity);
  return `fw/${encodeURIComponent(segment ?? '~')}/${who}/`;
}

/** Key families under a scope. */
export const KEYS = { cursor: 'c/', outbox: 'o/', messages: 'm/', values: 'v/' } as const;

/**
 * The store as the engine uses it: every key under the current
 * segment/identity scope, which is known from the token's claims or, at
 * the latest, from Welcome. Reads and writes wait until it is known.
 */
export class ScopedStore {
  private prefixValue?: string;
  private waiters: ((p: string) => void)[] = [];

  constructor(
    readonly store: Store,
    private readonly log: Logger,
  ) {}

  get prefix(): string | undefined {
    return this.prefixValue;
  }

  /** Sets the scope; returns the previous one when it changed. */
  setScope(prefix: string): string | undefined {
    const prev = this.prefixValue;
    if (prev === prefix) return undefined;
    this.prefixValue = prefix;
    const w = this.waiters;
    this.waiters = [];
    for (const r of w) r(prefix);
    return prev;
  }

  /** Forgets the scope (identity changing); reads wait for the next one. */
  unsetScope(): void {
    this.prefixValue = undefined;
  }

  scope(): Promise<string> {
    if (this.prefixValue !== undefined) return Promise.resolve(this.prefixValue);
    return new Promise((r) => this.waiters.push(r));
  }

  async get(key: string): Promise<string | undefined> {
    return this.store.get((await this.scope()) + key);
  }

  async set(key: string, value: string): Promise<void> {
    await this.store.set((await this.scope()) + key, value);
  }

  async delete(key: string): Promise<void> {
    await this.store.delete((await this.scope()) + key);
  }

  /** Keys under the scope starting with `family`, without the scope prefix. */
  async keys(family: string): Promise<string[]> {
    const p = await this.scope();
    return (await this.store.keys(p + family)).map((k) => k.slice(p.length));
  }

  /** Wipes everything of a scope (default: the current one). */
  async wipe(prefix = this.prefixValue): Promise<void> {
    if (prefix === undefined) return;
    try {
      await this.store.clear(prefix);
    } catch (err) {
      this.log.warn('store clear failed', { err });
    }
  }

  /** Drops data of topics the current rights no longer allow reading. */
  async prune(capabilities: readonly WireCapability[]): Promise<void> {
    if (capabilities.length === 0 || this.prefixValue === undefined) return;
    const allowed = (topic: string) => capabilities.some((c) => c.ops.includes('subscribe') && topicMatches(c.topic, topic));
    for (const family of [KEYS.cursor, KEYS.messages, KEYS.values]) {
      for (const key of await this.keys(family)) {
        const topic = decodeURIComponent(key.slice(family.length).split('/')[0]!);
        if (!allowed(topic)) await this.delete(key);
      }
    }
  }

  /** Cursors per topic, as the subscription registry reads and writes them. */
  cursors(): CursorStore {
    const key = (topic: string) => KEYS.cursor + encodeURIComponent(topic);
    return {
      get: async (topic) => parseCursor(await this.get(key(topic))),
      set: async (topic, c: Cursor) => {
        // Cursors only move forward: another tab sharing the store may be ahead.
        const prev = parseCursor(await this.get(key(topic)));
        if (prev && prev.epoch === c.epoch && prev.seq >= c.seq) return;
        await this.set(key(topic), formatCursor(c));
      },
      delete: (topic) => this.delete(key(topic)),
    };
  }
}
