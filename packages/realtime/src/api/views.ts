import { type Engine, type StoredValue, type TopicEntry, DeliveryClass } from '../engine';
import type { RealtimeError } from '../shared/errors';
import { Live } from './live';
import { toMessage } from './message';
import type { LiveView, Message, TopicMessage } from './types';

/** Stream events kept in `topic.messages`, oldest dropped first. */
export const MESSAGE_WINDOW = 100;

type Entry = TopicMessage & { readonly localId?: string; readonly ackedId?: string };

/**
 * `topic.values(event)`: a ReadonlyMap of the current values that is also a
 * live view. kv values are keyed by key, signals by publisher (only those
 * younger than the signal TTL).
 */
export class ValuesView implements ReadonlyMap<string, Message>, LiveView<ReadonlyMap<string, Message>> {
  private readonly live: Live<ReadonlyMap<string, Message>>;
  private timer?: ReturnType<typeof setTimeout>;

  /** @internal */
  constructor(
    private readonly read: () => ReadonlyMap<string, Message>,
    private readonly nextExpiry: () => number | undefined,
    onError: (err: unknown) => void,
  ) {
    this.live = new Live<ReadonlyMap<string, Message>>(read(), onError);
  }

  readonly getSnapshot = (): ReadonlyMap<string, Message> => this.live.getSnapshot();
  readonly subscribe = (listener: () => void): (() => void) => this.live.subscribe(listener);

  /** @internal Recomputes the snapshot; schedules the next signal expiry. */
  refresh(): void {
    clearTimeout(this.timer);
    this.live.set(this.read());
    const at = this.nextExpiry();
    if (at !== undefined) this.timer = setTimeout(() => this.refresh(), Math.max(0, at - Date.now()) + 1);
  }

  get size(): number {
    return this.getSnapshot().size;
  }
  get(key: string): Message | undefined {
    return this.getSnapshot().get(key);
  }
  has(key: string): boolean {
    return this.getSnapshot().has(key);
  }
  keys(): MapIterator<string> {
    return this.getSnapshot().keys();
  }
  values(): MapIterator<Message> {
    return this.getSnapshot().values();
  }
  entries(): MapIterator<[string, Message]> {
    return this.getSnapshot().entries();
  }
  forEach(fn: (value: Message, key: string, map: ReadonlyMap<string, Message>) => void): void {
    this.getSnapshot().forEach(fn);
  }
  [Symbol.iterator](): MapIterator<[string, Message]> {
    return this.entries();
  }
}

/**
 * The live state of one topic handle: recent stream events (with this
 * client's sends, optimistically) and the current values per event name.
 * Fed by the handle's subscriptions; empty until one is active.
 */
export class TopicViews {
  readonly messages: Live<readonly TopicMessage[]>;
  private list: Entry[] = [];
  /** Entries of this handle's active subscriptions, with how many use each. */
  private readonly entries = new Map<TopicEntry, number>();
  private readonly valueViews = new Map<string, ValuesView>();

  constructor(
    private readonly topic: string,
    private readonly engine: Engine,
    private readonly signalTtlMs: number,
  ) {
    this.messages = new Live<readonly TopicMessage[]>([], this.onError);
  }

  private readonly onError = (err: unknown) => this.engine.log.error('view listener threw', { topic: this.topic, err });

  /** `topic.values(event)`; without an event name, every value of the topic, keyed `name/key`. */
  values(event?: string): ValuesView {
    const k = event ?? '\0all';
    let v = this.valueViews.get(k);
    if (!v) {
      v = new ValuesView(
        () => this.readValues(event),
        () => this.nextSignalExpiry(event),
        this.onError,
      );
      this.valueViews.set(k, v);
    }
    return v;
  }

  /** A subscription of this handle became active on `entry`. */
  attach(entry: TopicEntry): void {
    this.entries.set(entry, (this.entries.get(entry) ?? 0) + 1);
    this.refreshValues();
  }

  detach(entry: TopicEntry): void {
    const n = this.entries.get(entry);
    if (n === undefined) return;
    if (n > 1) this.entries.set(entry, n - 1);
    else this.entries.delete(entry);
    this.refreshValues();
  }

  /** A delivered event: stream events go to `messages`, others refresh the values. */
  ingest(m: Message): void {
    if (m.delivery !== 'stream') {
      this.refreshValues();
      return;
    }
    if (this.list.some((e) => e.id === m.id && !e.localId)) return;
    const mine = this.list.findIndex((e) => e.ackedId === m.id || (m.uid !== undefined && e.uid === m.uid));
    const entry: Entry = { ...m, status: 'sent' };
    const next = [...this.list];
    if (mine >= 0) next[mine] = entry;
    else next.push(entry);
    this.commit(next);
  }

  /** Values changed without a stream event (snapshot, resync). */
  refreshValues(): void {
    for (const v of this.valueViews.values()) v.refresh();
  }

  /** Shows a stream publish at once, as `pending`. */
  addPending(localId: string, m: Message, retry: () => Promise<void>): void {
    this.commit([...this.list, { ...m, localId, status: 'pending', retry }]);
  }

  /** PubAck: the send is `sent`; the delivered copy will replace it in place. */
  acked(localId: string, receipt: { id: string; uid?: string; cursor?: Message['cursor']; serverTime: number }): void {
    this.update(localId, (e) => ({
      ...e,
      status: 'sent',
      pending: false,
      id: receipt.id || e.id,
      ackedId: receipt.id,
      uid: receipt.uid,
      cursor: receipt.cursor,
      serverTime: receipt.serverTime,
      error: undefined,
    }));
  }

  failed(localId: string, error: RealtimeError): void {
    this.update(localId, (e) => ({ ...e, status: 'failed', pending: false, error }));
  }

  retrying(localId: string): void {
    this.update(localId, (e) => ({ ...e, status: 'pending', pending: true, error: undefined }));
  }

  private update(localId: string, fn: (e: Entry) => Entry): void {
    const i = this.list.findIndex((e) => e.localId === localId);
    if (i < 0) return;
    const next = [...this.list];
    next[i] = fn(next[i]!);
    this.commit(next);
  }

  private commit(next: Entry[]): void {
    // Keep the window; never drop a send that has not settled.
    while (next.length > MESSAGE_WINDOW) {
      const i = next.findIndex((e) => e.status !== 'pending');
      if (i < 0) break;
      next.splice(i, 1);
    }
    this.list = next;
    this.messages.set(Object.freeze([...next]));
  }

  private readValues(event: string | undefined): ReadonlyMap<string, Message> {
    const out = new Map<string, Message>();
    const cutoff = Date.now() - this.signalTtlMs;
    const add = (byName: ReadonlyMap<string, ReadonlyMap<string, StoredValue>>, signals: boolean) => {
      for (const [name, byKey] of byName) {
        if (event !== undefined && name !== event) continue;
        for (const [key, v] of byKey) {
          if (signals && v.receivedAt < cutoff) continue;
          // Across event names, keys are scoped by name: read/user:7, location/user:7.
          out.set(event === undefined && name !== '' ? `${name}/${key}` : key, toMessage({ topic: this.topic, event: v.event, delivery: v.delivery, replayed: false, fromSnapshot: true }));
        }
      }
    };
    for (const entry of this.entries.keys()) {
      if (entry.removed) continue;
      const { kv, signals } = this.engine.values(entry);
      add(kv, false);
      add(signals, true);
    }
    return out;
  }

  private nextSignalExpiry(event: string | undefined): number | undefined {
    let next: number | undefined;
    const cutoff = Date.now() - this.signalTtlMs;
    for (const entry of this.entries.keys()) {
      for (const [name, byKey] of this.engine.values(entry).signals) {
        if (event !== undefined && name !== event) continue;
        for (const v of byKey.values()) {
          if (v.receivedAt < cutoff || v.delivery !== DeliveryClass.Ephemeral) continue;
          const at = v.receivedAt + this.signalTtlMs;
          if (next === undefined || at < next) next = at;
        }
      }
    }
    return next;
  }
}
