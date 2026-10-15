import { Code } from '../shared/codes';
import { type Cursor, isAfter, sameCursor } from '../shared/cursor';
import { RealtimeError } from '../shared/errors';
import type { Logger } from '../shared/logger';
import {
  type Deliver,
  type Gap,
  type Snapshot,
  type SubAck,
  type SubscribeBody,
  type TopicCursor,
  type WireEvent,
  DeliveryClass,
  GapReason,
  OnGap,
  StartAt,
} from '../transport';
import type { CursorStore } from './cursor-store';

/** How a subscription starts when there is no cursor to resume from. */
export interface SubscribeSpec {
  readonly start: StartAt;
  readonly cursor?: Cursor;
  readonly lastN: number;
  readonly onGap: OnGap;
  readonly snapshot: boolean;
  /** Resume from the cursor store when it holds a cursor for the topic. */
  readonly resume: boolean;
}

export interface DeliveredEvent {
  readonly topic: string;
  readonly event: WireEvent;
  readonly replayed: boolean;
  readonly fromSnapshot: boolean;
}

export interface ActiveInfo {
  readonly topicId: bigint;
  readonly deliveryClass: DeliveryClass;
  readonly catchingUp: boolean;
  readonly oldest?: Cursor;
  readonly latest?: Cursor;
}

export interface GapInfo {
  readonly reason: GapReason;
  readonly requested?: Cursor;
  readonly oldest?: Cursor;
  readonly latest?: Cursor;
  readonly resumed: boolean;
}

/** A consumer of one topic (layer 1's `Subscription`). Calls arrive in order, one at a time. */
export interface TopicListener {
  onActive(info: ActiveInfo): void | Promise<void>;
  onEvent(e: DeliveredEvent): void | Promise<void>;
  onSnapshot(events: DeliveredEvent[]): void | Promise<void>;
  onGap(gap: GapInfo): void | Promise<void>;
  /** The connection dropped; the subscription will be re-established. */
  onResync(): void | Promise<void>;
  /** Terminal: the node refused the subscription, or a Gap with `onGap: Fail`. */
  onFailed(err: RealtimeError): void | Promise<void>;
  /** Terminal: the node ended the subscription (`SubEnded`) or the client closed. */
  onEnded(err: RealtimeError): void | Promise<void>;
}

export type WireState = 'idle' | 'subscribing' | 'active';

export interface StoredValue {
  readonly event: WireEvent;
  readonly receivedAt: number;
}

/** One topic this client follows, shared by every listener on it. */
export class TopicEntry {
  topicId?: bigint;
  deliveryClass: DeliveryClass = DeliveryClass.Unspecified;
  readonly listeners = new Set<TopicListener>();
  wire: WireState = 'idle';
  removed = false;
  /** Last event accepted from the wire (dedup and resume position). */
  received?: Cursor;
  /** Last event every listener finished handling. */
  processed?: Cursor;
  /** Last cursor sent in a `CursorAck` hint. */
  hinted?: Cursor;
  /** Cursor loaded from the store when the entry was created. */
  stored?: Cursor;
  /** `SubAck.latest` of the last subscribe or poll. */
  latest?: Cursor;
  loaded = false;
  readonly loading: Promise<void>;
  everActive = false;
  /** Current values of a LastValue (by key) or Ephemeral (by publisher) topic. */
  readonly values = new Map<string, StoredValue>();
  snapshotBuf?: { id: bigint; events: WireEvent[] };
  chain: Promise<void> = Promise.resolve();
  cursorRecovered = false;
  /** Scratch state owned by the poll session. */
  poll = { emptyState: false, snapshotNext: false };

  constructor(
    readonly name: string,
    readonly spec: SubscribeSpec,
    store: CursorStore,
    log: Logger,
  ) {
    this.loading = spec.resume
      ? Promise.resolve()
          .then(() => store.get(name))
          .then((c) => {
            this.stored = c ?? undefined;
          })
          .catch((err) => log.warn('cursor store get failed', { topic: name, err }))
          .finally(() => {
            this.loaded = true;
          })
      : Promise.resolve().then(() => {
          this.loaded = true;
        });
  }

  get isState(): boolean {
    return this.deliveryClass === DeliveryClass.LastValue || this.deliveryClass === DeliveryClass.Ephemeral;
  }

  /** Where to resume: the last received event, else the stored cursor. */
  get resumeCursor(): Cursor | undefined {
    return this.received ?? this.stored;
  }

  /** The `Subscribe` body for (re)subscribing this topic now. */
  subscribeBody(): SubscribeBody {
    const topic = { name: this.name };
    const at = this.resumeCursor;
    if (at) {
      return { topic, start: StartAt.After, cursor: at, onGap: this.spec.onGap, snapshot: this.spec.snapshot || this.isState };
    }
    return {
      topic,
      start: this.spec.start,
      cursor: this.spec.start === StartAt.After ? this.spec.cursor : undefined,
      lastN: this.spec.lastN,
      onGap: this.spec.onGap,
      snapshot: this.spec.snapshot,
    };
  }
}

export interface RegistryOptions {
  cursorStore: CursorStore;
  logger: Logger;
  /** Called when entries were added or removed, so the session can sync. */
  onChange: () => void;
  now?: () => number;
}

/** Subscribe errors worth retrying on the same session. */
const TRANSIENT = new Set<number>([Code.RateLimited, Code.Internal, Code.Overloaded, Code.Unavailable]);

const valueKey = (e: WireEvent): string => e.key ?? e.publisher;

/**
 * Every topic the client follows, independent of the transport. Sessions
 * feed it replies; it binds names to topic ids, drops duplicates, assembles
 * snapshots, keeps state-topic values and runs listener callbacks in order.
 */
export class SubscriptionRegistry {
  private readonly byName = new Map<string, TopicEntry>();
  private readonly byId = new Map<bigint, TopicEntry>();
  private unsubscribes: TopicEntry[] = [];
  private readonly now: () => number;

  constructor(private readonly opts: RegistryOptions) {
    this.now = opts.now ?? Date.now;
  }

  entries(): TopicEntry[] {
    return [...this.byName.values()];
  }

  get(name: string): TopicEntry | undefined {
    return this.byName.get(name);
  }

  byTopicId(id: bigint): TopicEntry | undefined {
    return this.byId.get(id);
  }

  /** Adds a listener; creates the entry (and so the wire subscription) if needed. */
  add(name: string, spec: SubscribeSpec, listener: TopicListener): TopicEntry {
    let entry = this.byName.get(name);
    if (entry) {
      entry.listeners.add(listener);
      if (entry.everActive && entry.wire === 'active' && entry.topicId !== undefined) {
        // A late joiner: confirm at once and hand it the current state.
        const info: ActiveInfo = {
          topicId: entry.topicId,
          deliveryClass: entry.deliveryClass,
          catchingUp: false,
          latest: entry.latest,
        };
        const e = entry;
        this.run(entry, async () => {
          await listener.onActive(info);
          if (e.isState) await listener.onSnapshot(this.currentValues(e));
        });
      }
      return entry;
    }
    entry = new TopicEntry(name, spec, this.opts.cursorStore, this.opts.logger);
    entry.listeners.add(listener);
    this.byName.set(name, entry);
    this.opts.onChange();
    return entry;
  }

  /** Removes a listener; the wire subscription ends a tick after the last one leaves. */
  remove(entry: TopicEntry, listener: TopicListener): void {
    if (!entry.listeners.delete(listener) || entry.listeners.size > 0 || entry.removed) return;
    // Linger one tick so an immediate re-subscribe (React StrictMode) reuses the entry.
    setTimeout(() => {
      if (entry.listeners.size > 0 || entry.removed) return;
      this.drop(entry);
      if (entry.wire !== 'idle') this.unsubscribes.push(entry);
      this.opts.onChange();
    }, 0);
  }

  /** Entries removed while subscribed; the socket session sends `Unsubscribe` for them. */
  drainUnsubscribes(): TopicEntry[] {
    const out = this.unsubscribes;
    this.unsubscribes = [];
    return out;
  }

  bind(entry: TopicEntry, topicId: bigint): void {
    if (entry.removed || topicId === 0n) return;
    if (entry.topicId !== undefined && entry.topicId !== topicId && this.byId.get(entry.topicId) === entry) {
      this.byId.delete(entry.topicId);
    }
    entry.topicId = topicId;
    this.byId.set(topicId, entry);
  }

  // ------------------------------------------------------------ intake

  /**
   * A `SubAck`. With `quiet`, an already active entry only refreshes its
   * bookkeeping (long-poll answers every poll with a SubAck).
   */
  onSubAck(entry: TopicEntry, ack: SubAck, quiet = false): void {
    if (entry.removed) return;
    this.bind(entry, ack.topicId);
    entry.deliveryClass = ack.delivery;
    entry.latest = ack.latest;
    if (quiet && entry.wire === 'active') return;
    entry.wire = 'active';
    entry.everActive = true;
    const info: ActiveInfo = {
      topicId: ack.topicId,
      deliveryClass: ack.delivery,
      catchingUp: ack.catchingUp,
      oldest: ack.oldest,
      latest: ack.latest,
    };
    this.each(entry, (l) => l.onActive(info));
  }

  /** Returns false when the subscription ended (`onGap: Fail`). */
  onGap(entry: TopicEntry, gap: Gap): boolean {
    if (entry.removed) return false;
    this.bind(entry, gap.topicId);
    const info: GapInfo = {
      reason: gap.reason,
      requested: gap.requested,
      oldest: gap.oldest,
      latest: gap.latest,
      resumed: gap.resumed,
    };
    this.opts.logger.info('gap', { topic: entry.name, reason: GapReason[gap.reason], resumed: gap.resumed });
    this.each(entry, (l) => l.onGap(info));
    if (!gap.resumed) {
      this.fail(
        entry,
        new RealtimeError(Code.InvalidCursor, {
          message: `events after the cursor are gone (${GapReason[gap.reason] ?? gap.reason}) and onGap is "fail"`,
          topic: entry.name,
          topicId: gap.topicId,
        }),
      );
      return false;
    }
    return true;
  }

  /** Events from the wire. `replayed` overrides the frame's flag (long-poll reads are always "replays"). */
  onDeliver(entry: TopicEntry, d: Deliver, replayed = d.replayed): void {
    if (entry.removed) return;
    if (d.delivery !== DeliveryClass.Unspecified) entry.deliveryClass = d.delivery;
    const now = this.now();
    for (const event of d.events) {
      const c: Cursor = { epoch: event.epoch, seq: event.seq };
      if (!isAfter(c, entry.received)) continue; // already seen
      entry.received = c;
      if (entry.isState) {
        if (event.tombstone) entry.values.delete(valueKey(event));
        else entry.values.set(valueKey(event), { event, receivedAt: now });
      }
      const delivered: DeliveredEvent = { topic: entry.name, event, replayed, fromSnapshot: false };
      this.run(entry, async () => {
        await Promise.all([...entry.listeners].map((l) => l.onEvent(delivered)));
        await this.processed(entry, c);
      });
    }
  }

  onSnapshot(entry: TopicEntry, s: Snapshot): void {
    if (entry.removed) return;
    if (!entry.snapshotBuf || entry.snapshotBuf.id !== s.snapshotId || s.chunk === 0) {
      entry.snapshotBuf = { id: s.snapshotId, events: [] };
    }
    entry.snapshotBuf.events.push(...s.events);
    if (!s.lastChunk) return;
    const events = entry.snapshotBuf.events;
    entry.snapshotBuf = undefined;
    const now = this.now();
    entry.values.clear();
    let top: Cursor | undefined = s.fence;
    for (const event of events) {
      if (!event.tombstone) entry.values.set(valueKey(event), { event, receivedAt: now });
      const c = { epoch: event.epoch, seq: event.seq };
      if (!top || (c.epoch === top.epoch && c.seq > top.seq)) top = c;
    }
    if (top) entry.received = top;
    const delivered = events
      .filter((e) => !e.tombstone)
      .map((event): DeliveredEvent => ({ topic: entry.name, event, replayed: false, fromSnapshot: true }));
    this.run(entry, async () => {
      await Promise.all([...entry.listeners].map((l) => l.onSnapshot(delivered)));
      if (top) await this.processed(entry, top);
    });
  }

  onSubEnded(entry: TopicEntry, code: number, message: string): void {
    if (entry.removed) return;
    this.drop(entry);
    const err = new RealtimeError(code, { message: message || 'subscription ended by the node', topic: entry.name, topicId: entry.topicId });
    this.each(entry, (l) => l.onEnded(err));
  }

  /**
   * The node refused a subscribe. Returns true when the entry should simply
   * be subscribed again (a stale cursor was dropped).
   */
  onSubscribeError(entry: TopicEntry, err: RealtimeError): boolean {
    if (entry.removed) return false;
    if (err.code === Code.InvalidCursor && entry.resumeCursor && !entry.cursorRecovered) {
      // A cursor ahead of the topic: forget it and start over from the spec.
      this.opts.logger.warn('cursor rejected; subscribing without it', { topic: entry.name });
      entry.cursorRecovered = true;
      entry.received = undefined;
      entry.stored = undefined;
      void Promise.resolve(this.opts.cursorStore.delete?.(entry.name)).catch(() => {});
      entry.wire = 'idle';
      return true;
    }
    if (TRANSIENT.has(err.code)) {
      entry.wire = 'idle';
      return true;
    }
    this.fail(entry, err.withTopic(entry.name, entry.topicId));
    return false;
  }

  /** The session ended: everything must be subscribed again on the next one. */
  sessionLost(): void {
    this.byId.clear();
    this.unsubscribes = [];
    for (const entry of this.byName.values()) {
      const wasActive = entry.wire === 'active';
      entry.wire = 'idle';
      entry.snapshotBuf = undefined;
      entry.topicId = undefined;
      if (wasActive) this.each(entry, (l) => l.onResync());
    }
  }

  /** Ends every entry (client closed). */
  close(err: RealtimeError): void {
    for (const entry of [...this.byName.values()]) {
      this.drop(entry);
      this.each(entry, (l) => l.onEnded(err));
    }
    this.unsubscribes = [];
  }

  /** Processed cursors not yet hinted to the node (`CursorAck`). */
  takeCursorHints(): TopicCursor[] {
    const out: TopicCursor[] = [];
    for (const e of this.byName.values()) {
      if (e.wire !== 'active' || e.topicId === undefined || !e.processed) continue;
      if (e.deliveryClass !== DeliveryClass.Durable || sameCursor(e.processed, e.hinted)) continue;
      e.hinted = e.processed;
      out.push({ topicId: e.topicId, cursor: e.processed });
    }
    return out;
  }

  /** The current values of a state topic, as snapshot events. */
  currentValues(entry: TopicEntry): DeliveredEvent[] {
    return [...entry.values.values()].map(({ event }) => ({ topic: entry.name, event, replayed: false, fromSnapshot: true }));
  }

  // ------------------------------------------------------------ internals

  private fail(entry: TopicEntry, err: RealtimeError): void {
    this.drop(entry);
    this.each(entry, (l) => l.onFailed(err));
  }

  private drop(entry: TopicEntry): void {
    entry.removed = true;
    if (this.byName.get(entry.name) === entry) this.byName.delete(entry.name);
    if (entry.topicId !== undefined && this.byId.get(entry.topicId) === entry) this.byId.delete(entry.topicId);
  }

  private async processed(entry: TopicEntry, c: Cursor): Promise<void> {
    entry.processed = c;
    if (entry.deliveryClass !== DeliveryClass.Durable) return;
    try {
      await this.opts.cursorStore.set(entry.name, c);
    } catch (err) {
      this.opts.logger.warn('cursor store set failed', { topic: entry.name, err });
    }
  }

  /** Runs `fn` for every listener, in the entry's order. */
  private each(entry: TopicEntry, fn: (l: TopicListener) => void | Promise<void>): void {
    const listeners = [...entry.listeners];
    this.run(entry, async () => {
      await Promise.all(listeners.map((l) => fn(l)));
    });
  }

  /** Appends to the entry's callback chain; a failing callback never stops the chain. */
  private run(entry: TopicEntry, fn: () => Promise<void>): void {
    entry.chain = entry.chain.then(fn).catch((err) => {
      this.opts.logger.error('subscription callback failed', { topic: entry.name, err });
    });
  }
}
