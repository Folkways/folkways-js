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
import { deliveryName, gapReasonName, toMessage } from './message';
import type { Delivery, GapEvent, Message, MessageHandler, SubscriptionStatus } from './types';
import type { TopicViews } from './views';

export type SubscriptionEvents<M> = {
  /** Every event, after the handler ran. */
  message: (message: M) => void;
  /** The current kv values and signals (on subscribe and after reconnects). */
  snapshot: (messages: M[]) => void;
  gap: (gap: GapEvent) => void;
  /** The subscription failed, or the handler threw. */
  error: (err: RealtimeError | Error) => void;
  /** The node ended the subscription (rights narrowed), the identity changed or the client closed. */
  ended: (err: RealtimeError) => void;
  status: (status: SubscriptionStatus) => void;
};

/** Local filters of one subscription. */
export interface SubscriptionFilter {
  readonly types?: readonly DeliveryClass[];
  readonly events?: readonly string[];
}

/**
 * A handle on one topic's events. Several handles on the same topic share
 * one wire subscription. Handlers run in order, one at a time; the cursor
 * advances after each handler settles.
 */
export class Subscription<M extends Message = Message> extends Emitter<SubscriptionEvents<M>> implements TopicListener {
  /** @internal Delivery types this handle receives (empty: all). */
  readonly types?: readonly DeliveryClass[];
  /** Resolves when the node confirmed the subscription; rejects if it refused it. */
  readonly ready: Promise<void>;
  private statusValue: SubscriptionStatus = 'pending';
  private allowed: readonly DeliveryClass[] = [];
  private topicClass = DeliveryClass.Unspecified;
  private readonly events?: ReadonlySet<string>;
  private attached = false;
  private cursorValue?: Cursor;
  private resolveReady!: () => void;
  private rejectReady!: (e: RealtimeError) => void;
  private readonly entry: TopicEntry;

  constructor(
    readonly topic: string,
    private readonly engine: Engine,
    spec: Parameters<Engine['subscribe']>[1],
    private readonly handler: MessageHandler<M> | undefined,
    filter: SubscriptionFilter = {},
    private readonly views?: TopicViews,
  ) {
    super();
    this.types = filter.types?.length ? filter.types : undefined;
    this.events = filter.events?.length ? new Set(filter.events) : undefined;
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

  /** Delivery types the topic allows, known after the first confirmation. */
  get deliveries(): readonly Delivery[] {
    if (this.allowed.length > 0) return this.allowed.map(deliveryName);
    return this.topicClass === DeliveryClass.Unspecified ? [] : [deliveryName(this.topicClass)];
  }

  /** The last event this handle finished handling. */
  get cursor(): Cursor | undefined {
    return this.cursorValue;
  }

  /** Stops this handle. The wire subscription ends when the last handle on the topic stops. */
  async unsubscribe(): Promise<void> {
    if (this.isTerminal()) return;
    this.engine.unsubscribe(this.entry, this);
    this.setStatus('closed');
    this.removeAllListeners();
  }

  /** `for await (const msg of sub)` — ends when the subscription does. */
  async *[Symbol.asyncIterator](): AsyncIterator<M> {
    const queue: M[] = [];
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
    this.allowed = info.deliveries;
    this.topicClass = info.deliveryClass;
    if (!this.attached) {
      this.attached = true;
      this.views?.attach(this.entry);
    }
    this.setStatus('active');
    this.resolveReady();
  }

  /** @internal */
  async onEvent(d: DeliveredEvent): Promise<void> {
    if (this.isTerminal() || !this.wants(d)) return;
    const m = toMessage(d) as M;
    this.views?.ingest(m);
    await this.deliver(m);
    if (m.cursor) this.cursorValue = m.cursor;
    this.emit('message', m);
  }

  /** @internal */
  async onSnapshot(events: DeliveredEvent[]): Promise<void> {
    if (this.isTerminal()) return;
    const messages = events.filter((d) => this.wants(d)).map((d) => toMessage(d) as M);
    this.views?.refreshValues();
    for (const m of messages) await this.deliver(m);
    this.emit('snapshot', messages);
  }

  /** @internal */
  onGap(g: GapInfo): void {
    if (this.isTerminal()) return;
    this.emit('gap', {
      topic: this.topic,
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

  private wants(d: DeliveredEvent): boolean {
    return !this.events || this.events.has(d.event.name ?? '');
  }

  private async deliver(m: M): Promise<void> {
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
    if (this.attached && this.isTerminal()) {
      this.attached = false;
      this.views?.detach(this.entry);
    }
    this.emit('status', s);
  }
}
