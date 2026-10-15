import {
  type ActiveInfo,
  type DeliveredEvent,
  DeliveryClass,
  type Engine,
  type GapInfo,
  type TopicEntry,
  type TopicListener,
} from '../engine';
import type { Cursor } from '../shared/cursor';
import { Emitter } from '../shared/emitter';
import type { RealtimeError } from '../shared/errors';
import { type DeliveryClassName, type GapReasonName, type Message, deliveryClassName, gapReasonName, toMessage } from './message';

export type SubscriptionStatus = 'pending' | 'active' | 'resyncing' | 'failed' | 'ended' | 'closed';

export interface GapEvent {
  readonly reason: GapReasonName;
  /** The cursor you asked to resume after. */
  readonly requested?: Cursor;
  /** Oldest event still retained: fetch `(requested, oldest)` from your backend. */
  readonly oldest?: Cursor;
  readonly latest?: Cursor;
  /** False when `onGap: 'fail'` ended the subscription. */
  readonly resumed: boolean;
}

export type MessageHandler<T> = (message: Message<T>) => void | Promise<void>;

export type SubscriptionEvents<T> = {
  /** Every event, after the handler ran. */
  message: (message: Message<T>) => void;
  /** The full current state of a LastValue/Ephemeral topic (on subscribe and after reconnects). */
  snapshot: (messages: Message<T>[]) => void;
  gap: (gap: GapEvent) => void;
  /** The subscription failed, or the handler threw. */
  error: (err: RealtimeError | Error) => void;
  /** The node ended the subscription (rights narrowed) or the client closed. */
  ended: (err: RealtimeError) => void;
  status: (status: SubscriptionStatus) => void;
};

/**
 * A handle on one topic's events. Several handles on the same topic share
 * one wire subscription. Handlers run in order, one at a time; the cursor
 * advances after each handler settles.
 */
export class Subscription<T = unknown> extends Emitter<SubscriptionEvents<T>> implements TopicListener {
  /** Resolves when the node confirmed the subscription; rejects if it refused it. */
  readonly ready: Promise<void>;
  private statusValue: SubscriptionStatus = 'pending';
  private classValue?: DeliveryClassName;
  private cursorValue?: Cursor;
  private resolveReady!: () => void;
  private rejectReady!: (e: RealtimeError) => void;
  private readonly entry: TopicEntry;

  constructor(
    readonly topic: string,
    private readonly engine: Engine,
    spec: Parameters<Engine['subscribe']>[1],
    private readonly handler: MessageHandler<T> | undefined,
    private readonly signalTtlMs: number,
  ) {
    super();
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.ready.catch(() => {}); // reported through `error` too; never unhandled
    this.onListenerError = (err) => engine.log.error('subscription listener threw', { topic, err });
    this.entry = engine.subscribe(topic, spec, this);
  }

  get status(): SubscriptionStatus {
    return this.statusValue;
  }

  /** Known after the first confirmation. */
  get deliveryClass(): DeliveryClassName | undefined {
    return this.classValue;
  }

  /** The last event this handle finished handling. */
  get cursor(): Cursor | undefined {
    return this.cursorValue;
  }

  /**
   * Current values: LastValue topics by key, Ephemeral topics by publisher
   * (signals younger than `signalTtlMs`). Empty for Durable topics.
   */
  get values(): Map<string, Message<T>> {
    const out = new Map<string, Message<T>>();
    const isEphemeral = this.entry.deliveryClass === DeliveryClass.Ephemeral;
    const cutoff = Date.now() - this.signalTtlMs;
    for (const [k, v] of this.engine.values(this.entry)) {
      if (isEphemeral && v.receivedAt < cutoff) continue;
      out.set(k, toMessage<T>({ topic: this.topic, event: v.event, replayed: false, fromSnapshot: true }));
    }
    return out;
  }

  /** Stops this handle. The wire subscription ends when the last handle on the topic stops. */
  async unsubscribe(): Promise<void> {
    if (this.isTerminal()) return;
    this.engine.unsubscribe(this.entry, this);
    this.setStatus('closed');
    this.removeAllListeners();
  }

  /** `for await (const msg of sub)` — ends when the subscription does. */
  async *[Symbol.asyncIterator](): AsyncIterator<Message<T>> {
    const queue: Message<T>[] = [];
    let wake: (() => void) | undefined;
    let done = this.isTerminal();
    const offs = [
      this.on('message', (m) => {
        queue.push(m);
        wake?.();
      }),
      this.on('status', (s) => {
        if (s === 'failed' || s === 'ended' || s === 'closed') {
          done = true;
          wake?.();
        }
      }),
    ];
    try {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (done) return;
        await new Promise<void>((r) => (wake = r));
        wake = undefined;
      }
    } finally {
      for (const off of offs) off();
    }
  }

  // ------------------------------------------------- TopicListener (layer 2)

  /** @internal */
  onActive(info: ActiveInfo): void {
    if (this.isTerminal()) return;
    this.classValue = deliveryClassName(info.deliveryClass);
    this.setStatus('active');
    this.resolveReady();
  }

  /** @internal */
  async onEvent(d: DeliveredEvent): Promise<void> {
    if (this.isTerminal()) return;
    const m = toMessage<T>(d);
    await this.deliver(m);
    this.cursorValue = m.cursor;
    this.emit('message', m);
  }

  /** @internal */
  async onSnapshot(events: DeliveredEvent[]): Promise<void> {
    if (this.isTerminal()) return;
    const messages = events.map((d) => toMessage<T>(d));
    for (const m of messages) await this.deliver(m);
    this.emit('snapshot', messages);
  }

  /** @internal */
  onGap(g: GapInfo): void {
    if (this.isTerminal()) return;
    this.emit('gap', {
      reason: gapReasonName(g.reason),
      requested: g.requested,
      oldest: g.oldest,
      latest: g.latest,
      resumed: g.resumed,
    });
  }

  /** @internal */
  onResync(): void {
    if (this.statusValue === 'active') this.setStatus('resyncing');
  }

  /** @internal */
  onFailed(err: RealtimeError): void {
    if (this.isTerminal()) return;
    this.setStatus('failed');
    this.rejectReady(err);
    if (this.listenerCount('error') > 0) this.emit('error', err);
    else this.engine.log.warn('subscription failed', { topic: this.topic, code: err.codeName, reason: err.message });
  }

  /** @internal */
  onEnded(err: RealtimeError): void {
    if (this.isTerminal()) return;
    this.setStatus('ended');
    this.rejectReady(err);
    this.emit('ended', err);
  }

  private async deliver(m: Message<T>): Promise<void> {
    if (!this.handler) return;
    try {
      await this.handler(m);
    } catch (err) {
      if (this.listenerCount('error') > 0) this.emit('error', err as Error);
      else this.engine.log.error('message handler threw', { topic: this.topic, err });
    }
  }

  private isTerminal(): boolean {
    return this.statusValue === 'failed' || this.statusValue === 'ended' || this.statusValue === 'closed';
  }

  private setStatus(s: SubscriptionStatus): void {
    if (this.statusValue === s) return;
    this.statusValue = s;
    this.emit('status', s);
  }
}
