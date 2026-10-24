import { format128, parse128 } from '../shared/random';
import type { Logger } from '../shared/logger';
import type { PublishBody } from '../transport';
import { KEYS, type ScopedStore, type StoreCipher } from './store';

/** One unsent publish as kept in the store. */
export interface OutboxItem {
  readonly key: string;
  readonly topic: string;
  readonly body: PublishBody;
  readonly createdAt: number;
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function encodeBody(body: PublishBody): Record<string, unknown> {
  const { payload, idempotencyKey, topic, ...rest } = body;
  return { ...rest, topic: 'name' in topic ? topic.name : undefined, payload: toBase64(payload), idempotencyKey: idempotencyKey ? format128(idempotencyKey) : undefined };
}

function decodeBody(o: Record<string, unknown>): PublishBody {
  const { payload, idempotencyKey, topic, ...rest } = o as Record<string, never>;
  return {
    ...(rest as object),
    topic: { name: topic as string },
    payload: fromBase64(payload as string),
    idempotencyKey: idempotencyKey ? parse128(idempotencyKey) : undefined,
  } as PublishBody;
}

/**
 * Stream and kv publishes written to a persistent store before their first
 * send, so they survive a reload or a short outage. Entries older than the
 * node's idempotency window (10 min) are never resent: they could create a
 * duplicate.
 */
export class Outbox {
  constructor(
    private readonly store: ScopedStore,
    readonly maxAgeMs: number,
    private readonly log: Logger,
    private readonly cipher?: StoreCipher,
  ) {}

  /** Only a persistent store keeps an outbox. */
  get enabled(): boolean {
    return this.store.store.persistent;
  }

  keyFor(body: PublishBody, createdAt: number): string {
    const id = body.idempotencyKey ? format128(body.idempotencyKey) : Math.random().toString(36).slice(2);
    return `${KEYS.outbox}${createdAt.toString(36).padStart(9, '0')}-${id}`;
  }

  async put(item: OutboxItem): Promise<void> {
    let value = JSON.stringify({ topic: item.topic, createdAt: item.createdAt, body: encodeBody(item.body) });
    if (this.cipher) value = await this.cipher.encrypt(value);
    try {
      await this.store.set(item.key, value);
    } catch (err) {
      // Quota or a broken store: the publish still goes out, just not across reloads.
      this.log.warn('outbox write failed', { err });
    }
  }

  async remove(key: string): Promise<void> {
    try {
      await this.store.delete(key);
    } catch (err) {
      this.log.warn('outbox delete failed', { err });
    }
  }

  /** Every stored entry, oldest first; unreadable ones are deleted. */
  async load(): Promise<OutboxItem[]> {
    const out: OutboxItem[] = [];
    for (const key of (await this.store.keys(KEYS.outbox)).sort()) {
      try {
        let value = await this.store.get(key);
        if (value === undefined) continue;
        if (this.cipher) value = await this.cipher.decrypt(value);
        const o = JSON.parse(value) as { topic: string; createdAt: number; body: Record<string, unknown> };
        out.push({ key, topic: o.topic, createdAt: o.createdAt, body: decodeBody(o.body) });
      } catch (err) {
        this.log.warn('dropping an unreadable outbox entry', { err });
        await this.remove(key);
      }
    }
    return out;
  }
}
