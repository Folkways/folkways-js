import type { Logger } from '../shared/logger';
import { format128, parse128 } from '../shared/random';
import { type DeliveryClass, type WireEvent } from '../transport';
import { KEYS, type ScopedStore, type StoreCipher } from './store';

export interface CacheLimits {
  /** Stream events kept per topic. */
  readonly messagesPerTopic: number;
  /** Bytes of cached stream events across all topics; oldest dropped first. */
  readonly maxBytes: number;
}

export interface CachedTopic {
  readonly messages: WireEvent[];
  readonly values: { readonly event: WireEvent; readonly delivery: DeliveryClass }[];
}

type Json = Record<string, unknown>;

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

export function encodeEvent(e: WireEvent): Json {
  return {
    ...e,
    topicId: e.topicId.toString(),
    epoch: e.epoch.toString(),
    seq: e.seq.toString(),
    payload: toBase64(e.payload),
    uid: e.uid ? format128(e.uid) : undefined,
  };
}

export function decodeEvent(o: Json): WireEvent {
  return {
    ...(o as object),
    topicId: BigInt(o.topicId as string),
    epoch: BigInt(o.epoch as string),
    seq: BigInt(o.seq as string),
    payload: fromBase64(o.payload as string),
    uid: o.uid ? parse128(o.uid as string) : undefined,
  } as WireEvent;
}

/**
 * A bounded cache of what the node already sent (ADR-001 D5): recent stream
 * events per topic and kv values, in a persistent store, so a reload can
 * render at once and then catch up. Signals are never stored. Writes are
 * coalesced per topic.
 */
export class MessageCache {
  private readonly messages = new Map<string, WireEvent[]>();
  private readonly sizes = new Map<string, number>();
  private total = 0;
  private readonly dirty = new Map<string, Set<'m' | 'v'>>();
  private readonly values = new Map<string, CachedTopic['values']>();
  private flushTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly store: ScopedStore,
    private readonly limits: CacheLimits,
    private readonly log: Logger,
    private readonly cipher?: StoreCipher,
  ) {}

  get enabled(): boolean {
    return this.store.store.persistent;
  }

  /** What an earlier page load cached for `topic`. */
  async load(topic: string): Promise<CachedTopic> {
    const empty: CachedTopic = { messages: [], values: [] };
    if (!this.enabled) return empty;
    try {
      const [m, v] = await Promise.all([this.read(KEYS.messages, topic), this.read(KEYS.values, topic)]);
      const messages = ((m as Json[] | undefined) ?? []).map(decodeEvent);
      const values = ((v as { e: Json; d: DeliveryClass }[] | undefined) ?? []).map((x) => ({ event: decodeEvent(x.e), delivery: x.d }));
      if (!this.messages.has(topic)) this.setMessages(topic, messages);
      if (!this.values.has(topic)) this.values.set(topic, values);
      return { messages, values };
    } catch (err) {
      this.log.warn('cache read failed', { topic, err });
      return empty;
    }
  }

  /** A stream event was delivered. */
  addMessage(topic: string, e: WireEvent): void {
    if (!this.enabled) return;
    const list = [...(this.messages.get(topic) ?? []), e].slice(-this.limits.messagesPerTopic);
    this.setMessages(topic, list);
    this.evict();
    this.markDirty(topic, 'm');
  }

  /** The kv values of a topic changed. */
  setValues(topic: string, values: CachedTopic['values']): void {
    if (!this.enabled) return;
    this.values.set(topic, values);
    this.markDirty(topic, 'v');
  }

  /** Writes everything pending now (tests; before close). */
  async flush(): Promise<void> {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    const work = [...this.dirty];
    this.dirty.clear();
    for (const [topic, kinds] of work) {
      try {
        if (kinds.has('m')) await this.write(KEYS.messages, topic, (this.messages.get(topic) ?? []).map(encodeEvent));
        if (kinds.has('v')) await this.write(KEYS.values, topic, (this.values.get(topic) ?? []).map((x) => ({ e: encodeEvent(x.event), d: x.delivery })));
      } catch (err) {
        // Quota or a broken store: the cache is an optimisation, delivery goes on.
        this.log.warn('cache write failed', { topic, err });
      }
    }
  }

  private setMessages(topic: string, list: WireEvent[]): void {
    const size = list.reduce((n, e) => n + e.payload.length + 64, 0);
    this.total += size - (this.sizes.get(topic) ?? 0);
    this.sizes.set(topic, size);
    this.messages.set(topic, list);
  }

  /** Drops the oldest events of the largest topics until the cache fits. */
  private evict(): void {
    while (this.total > this.limits.maxBytes) {
      let biggest: string | undefined;
      for (const [t, n] of this.sizes) if (!biggest || n > this.sizes.get(biggest)!) biggest = t;
      const list = biggest ? this.messages.get(biggest) : undefined;
      if (!biggest || !list || list.length === 0) return;
      this.setMessages(biggest, list.slice(1));
      this.markDirty(biggest, 'm');
    }
  }

  private markDirty(topic: string, kind: 'm' | 'v'): void {
    let kinds = this.dirty.get(topic);
    if (!kinds) this.dirty.set(topic, (kinds = new Set()));
    kinds.add(kind);
    this.flushTimer ??= setTimeout(() => void this.flush(), 50);
  }

  private async read(family: string, topic: string): Promise<unknown> {
    let v = await this.store.get(family + encodeURIComponent(topic));
    if (v === undefined) return undefined;
    if (this.cipher) v = await this.cipher.decrypt(v);
    return JSON.parse(v);
  }

  private async write(family: string, topic: string, data: unknown): Promise<void> {
    let v = JSON.stringify(data);
    if (this.cipher) v = await this.cipher.encrypt(v);
    await this.store.set(family + encodeURIComponent(topic), v);
  }
}
