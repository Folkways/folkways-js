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
import type { MessageCache } from './cache';
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
  /** The event's type: its own, else the frame's, else the topic's. */
  readonly delivery: DeliveryClass;
  readonly replayed: boolean;
  readonly fromSnapshot: boolean;
  /** Read from the local store, not yet confirmed by the live connection. */
  readonly fromCache?: boolean;
}

export interface ActiveInfo {
  readonly topicId: bigint;
  readonly deliveryClass: DeliveryClass;
  /** Event types the topic's rule allows; empty from nodes before ADR-001. */
  readonly deliveries: readonly DeliveryClass[];
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
  /** Event types this listener receives; absent or empty means all. */
  readonly types?: readonly DeliveryClass[];
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
  /** Stream events and values an earlier page load cached, before the node answers. */
  onCached?(events: DeliveredEvent[]): void | Promise<void>;
}

export type WireState = 'idle' | 'subscribing' | 'active';

export interface StoredValue {
  readonly event: WireEvent;
  readonly delivery: DeliveryClass;
  readonly receivedAt: number;
  /** Loaded from the local store; replaced by the first live snapshot. */
  readonly cached?: boolean;
}

/** Current values by event name, then by key (kv) or publisher (signal). */
export type ValueMaps = Map<string, Map<string, StoredValue>>;

const accepts = (types: readonly DeliveryClass[] | undefined, d: DeliveryClass): boolean =>
  !types || types.length === 0 || types.includes(d);

/** Union of event-type filters; empty means all. */
function unionTypes(lists: (readonly DeliveryClass[] | undefined)[]): DeliveryClass[] {
  const out = new Set<DeliveryClass>();
  for (const l of lists) {
    if (!l || l.length === 0) return [];
    for (const t of l) out.add(t);
  }
  return [...out].sort();
}

/** True when a wire subscription for `have` carries every type in `want`. */
function covers(have: readonly DeliveryClass[], want: readonly DeliveryClass[]): boolean {
  if (have.length === 0) return true;
  if (want.length === 0) return false;
  return want.every((t) => have.includes(t));
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
  /** Event types the rule allows (`SubAck.deliveries`); empty when unknown. */
  allowed: readonly DeliveryClass[] = [];
  /** Types requested by the current wire subscription; empty means all. */
  wireTypes: readonly DeliveryClass[] = [];
  /** A listener needs types the wire subscription does not carry: subscribe again. */
  retype = false;
  /** kv values: event name → key → value. */
  readonly kv: ValueMaps = new Map();
  /** Latest signal per sender: event name → publisher → value. */
  readonly signals: ValueMaps = new Map();
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

  /** The topic may hold kv or signal values (and so answers with snapshots). */
  get isState(): boolean {
    const state = (d: DeliveryClass) => d === DeliveryClass.LastValue || d === DeliveryClass.Ephemeral;
    return state(this.deliveryClass) || this.allowed.some(state);
  }

  /** The union of every listener's event types; empty means all. */
  wantedTypes(): DeliveryClass[] {
    return unionTypes([...this.listeners].map((l) => l.types));
  }

  /** The type of an event: its own, else the frame's, else the topic's (nodes before ADR-001). */
  deliveryOf(e: WireEvent, frame: DeliveryClass = DeliveryClass.Unspecified): DeliveryClass {
    return e.delivery || frame || this.deliveryClass || DeliveryClass.Durable;
  }

  /** Records a kv or signal event in the value maps. */
  storeValue(event: WireEvent, delivery: DeliveryClass, now: number, cached = false): void {
    const maps = delivery === DeliveryClass.LastValue ? this.kv : delivery === DeliveryClass.Ephemeral ? this.signals : undefined;
    if (!maps) return;
    const name = event.name ?? '';
    const key = delivery === DeliveryClass.LastValue ? (event.key ?? event.publisher) : event.publisher;
    let m = maps.get(name);
    if (event.tombstone) {
      m?.delete(key);
      if (m?.size === 0) maps.delete(name);
      return;
    }
    if (!m) maps.set(name, (m = new Map()));
    m.set(key, { event, delivery, receivedAt: now, cached });
  }

  /** The kv values as a flat list, for the cache. */
  kvList(): { event: WireEvent; delivery: DeliveryClass }[] {
    const out: { event: WireEvent; delivery: DeliveryClass }[] = [];
    for (const byKey of this.kv.values()) for (const { event, delivery } of byKey.values()) out.push({ event, delivery });
    return out;
  }

  /** Where to resume: the last received event, else the stored cursor. */
  get resumeCursor(): Cursor | undefined {
    return this.received ?? this.stored;
  }

  /** The `Subscribe` body for (re)subscribing this topic now. */
  subscribeBody(): SubscribeBody {
    const topic = { name: this.name };
    const types = this.wantedTypes();
    this.wireTypes = types;
    this.retype = false;
    const at = this.resumeCursor;
    if (at) {
      return { topic, start: StartAt.After, cursor: at, onGap: this.spec.onGap, snapshot: this.spec.snapshot || this.isState, types };
    }
    return {
      topic,
      start: this.spec.start,
      cursor: this.spec.start === StartAt.After ? this.spec.cursor : undefined,
      lastN: this.spec.lastN,
      onGap: this.spec.onGap,
      snapshot: this.spec.snapshot,
      types,
    };
  }
}

export interface RegistryOptions {
  cursorStore: CursorStore;
  logger: Logger;
  /** Called when entries were added or removed, so the session can sync. */
  onChange: () => void;
  /** Sees every delivered event, in the topic's order, without holding it back. */
  observe?: (e: DeliveredEvent) => void;
  /** Recent stream events and kv values kept across reloads. */
  cache?: MessageCache;
  now?: () => number;
}

/** Subscribe errors worth retrying on the same session. */
const TRANSIENT = new Set<number>([Code.RateLimited, Code.Internal, Code.Overloaded, Code.Unavailable]);


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
      if (entry.wire !== 'idle' && !covers(entry.wireTypes, entry.wantedTypes())) {
        // The newcomer needs types the wire subscription filters out.
        entry.retype = true;
        this.opts.onChange();
      }
      if (entry.everActive && entry.wire === 'active' && entry.topicId !== undefined) {
        // A late joiner: confirm at once and hand it the current state.
        const info: ActiveInfo = {
          topicId: entry.topicId,
          deliveryClass: entry.deliveryClass,
          deliveries: entry.allowed,
          catchingUp: false,
          latest: entry.latest,
        };
        // The values as of now: later events reach the newcomer through the chain.
        const values = entry.isState ? this.currentValues(entry).filter((d) => accepts(listener.types, d.delivery)) : undefined;
        this.run(entry, async () => {
          await listener.onActive(info);
          if (values) await listener.onSnapshot(values);
        });
      }
      return entry;
    }
    entry = new TopicEntry(name, spec, this.opts.cursorStore, this.opts.logger);
    entry.listeners.add(listener);
    this.byName.set(name, entry);
    this.opts.onChange();
    this.loadCached(entry);
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
    entry.allowed = ack.deliveries;
    entry.latest = ack.latest;
    if (quiet && entry.wire === 'active') return;
    entry.wire = 'active';
    entry.everActive = true;
    const info: ActiveInfo = {
      topicId: ack.topicId,
      deliveryClass: ack.delivery,
      deliveries: ack.deliveries,
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
    if (d.delivery !== DeliveryClass.Unspecified && entry.allowed.length === 0) entry.deliveryClass = d.delivery;
    const now = this.now();
    for (const event of d.events) {
      const delivery = entry.deliveryOf(event, d.delivery);
      // Only numbered events take part in order, dedup and resume; nodes
      // with ADR-001 number stream events only, so kv and signal events
      // (seq 0) never look like a gap or a duplicate.
      const numbered = event.seq > 0n;
      const c: Cursor = { epoch: event.epoch, seq: event.seq };
      if (numbered) {
        if (!isAfter(c, entry.received)) continue; // already seen
        entry.received = c;
      }
      entry.storeValue(event, delivery, now);
      if (delivery === DeliveryClass.Durable && numbered) this.opts.cache?.addMessage(entry.name, event);
      else if (delivery === DeliveryClass.LastValue) this.opts.cache?.setValues(entry.name, entry.kvList());
      const delivered: DeliveredEvent = { topic: entry.name, event, delivery, replayed, fromSnapshot: false };
      this.run(entry, async () => {
        this.opts.observe?.(delivered);
        await Promise.all([...entry.listeners].filter((l) => accepts(l.types, delivery)).map((l) => l.onEvent(delivered)));
        if (numbered && delivery === DeliveryClass.Durable) await this.processed(entry, c);
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
    entry.kv.clear();
    entry.signals.clear();
    let top: Cursor | undefined = s.fence;
    const delivered: DeliveredEvent[] = [];
    for (const event of events) {
      const delivery = entry.deliveryOf(event);
      entry.storeValue(event, delivery, now);
      if (!event.tombstone) delivered.push({ topic: entry.name, event, delivery, replayed: false, fromSnapshot: true });
      if (event.seq === 0n) continue;
      const c = { epoch: event.epoch, seq: event.seq };
      if (!top || (c.epoch === top.epoch && c.seq > top.seq)) top = c;
    }
    if (top) entry.received = top;
    this.opts.cache?.setValues(entry.name, entry.kvList());
    this.run(entry, async () => {
      await Promise.all([...entry.listeners].map((l) => l.onSnapshot(delivered.filter((d) => accepts(l.types, d.delivery)))));
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
      entry.retype = false;
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
      if ((e.isState && e.allowed.length === 0) || sameCursor(e.processed, e.hinted)) continue;
      e.hinted = e.processed;
      out.push({ topicId: e.topicId, cursor: e.processed });
    }
    return out;
  }

  /** The current kv and signal values of a topic, as snapshot events. */
  currentValues(entry: TopicEntry): DeliveredEvent[] {
    const out: DeliveredEvent[] = [];
    for (const maps of [entry.kv, entry.signals]) {
      for (const byKey of maps.values()) {
        for (const { event, delivery } of byKey.values()) {
          out.push({ topic: entry.name, event, delivery, replayed: false, fromSnapshot: true });
        }
      }
    }
    return out;
  }

  // ------------------------------------------------------------ internals

  /** Hands listeners what an earlier page load cached, until the node answers. */
  private loadCached(entry: TopicEntry): void {
    const cache = this.opts.cache;
    if (!cache?.enabled) return;
    void cache.load(entry.name).then(({ messages, values }) => {
      if (entry.removed || (messages.length === 0 && values.length === 0)) return;
      const now = this.now();
      const fresh = !entry.everActive;
      if (fresh) for (const v of values) entry.storeValue(v.event, v.delivery, now, true);
      const delivered: DeliveredEvent[] = [
        ...messages.map((event): DeliveredEvent => ({ topic: entry.name, event, delivery: entry.deliveryOf(event, DeliveryClass.Durable), replayed: true, fromSnapshot: false, fromCache: true })),
        ...(fresh ? values.map((v): DeliveredEvent => ({ topic: entry.name, event: v.event, delivery: v.delivery, replayed: false, fromSnapshot: true, fromCache: true })) : []),
      ];
      this.run(entry, async () => {
        await Promise.all([...entry.listeners].map((l) => l.onCached?.(delivered.filter((d) => accepts(l.types, d.delivery)))));
      });
    });
  }

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
    if (entry.isState && entry.allowed.length === 0) return; // a state topic on a node before ADR-001: snapshots resume it
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
