import type { Engine } from '../engine';
import { Code } from '../shared/codes';
import { Emitter } from '../shared/emitter';
import { RealtimeError } from '../shared/errors';
import type { Subscription } from './subscription';
import type { Topic } from './topic';
import type {
  EventMap,
  GapEvent,
  MessageHandler,
  MessageOf,
  PublishOptions,
  PublishReceipt,
  SetReady,
  SetSubscribeOptions,
  SubscriptionStatus,
} from './types';

/** What a set subscription needs from its set. */
interface SetHost {
  readonly names: readonly string[];
  get(name: string): Topic<EventMap>;
  detach(sub: object): void;
}

export type SetSubscriptionEvents<M> = {
  /** Every event of every topic, after the handler ran. */
  message: (message: M) => void;
  gap: (gap: GapEvent) => void;
  /** A topic failed, or the handler threw. */
  error: (err: RealtimeError | Error) => void;
  /** The node ended one topic's subscription. */
  ended: (err: RealtimeError) => void;
};

/**
 * One subscription over every topic of a set. Within a topic, events arrive
 * in order and the handler runs one at a time; there is no order across
 * topics. Topics added to or removed from the set join or leave it live.
 */
export class SetSubscription<M = unknown> extends Emitter<SetSubscriptionEvents<M>> {
  /** Settles once every topic present at subscribe time has answered. */
  readonly ready: Promise<SetReady>;
  private readonly subs = new Map<string, Subscription>();
  private closed = false;
  private onClosed?: () => void;

  /** @internal */
  constructor(
    private readonly set: SetHost,
    private readonly engine: Engine,
    private readonly handler: MessageHandler<M> | undefined,
    private readonly opts: SetSubscribeOptions,
  ) {
    super();
    this.onListenerError = (err) => engine.log.error('topic set listener threw', { err });
    const initial = set.names.map((n) => this.join(n));
    this.ready = this.settle(initial);
    this.ready.catch(() => {}); // reported through `error` too
  }

  /** Topics currently covered. */
  get topics(): readonly string[] {
    return [...this.subs.keys()];
  }

  /** Each topic's subscription status. */
  get statuses(): ReadonlyMap<string, SubscriptionStatus> {
    return new Map([...this.subs].map(([t, s]) => [t, s.status]));
  }

  /** Stops every topic of this subscription. */
  async unsubscribe(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.set.detach(this);
    await Promise.all([...this.subs.values()].map((s) => s.unsubscribe()));
    this.subs.clear();
    this.onClosed?.();
    this.removeAllListeners();
  }

  /** `for await (const msg of sub)` — ends on `unsubscribe()`. */
  async *[Symbol.asyncIterator](): AsyncIterator<M> {
    const queue: M[] = [];
    let wake: (() => void) | undefined;
    const off = this.on('message', (m) => {
      queue.push(m);
      wake?.();
    });
    this.onClosed = () => wake?.();
    try {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (this.closed) return;
        await new Promise<void>((r) => (wake = r));
        wake = undefined;
      }
    } finally {
      off();
    }
  }

  /** @internal A topic joined the set. */
  join(name: string): Promise<RealtimeError | undefined> {
    if (this.closed || this.subs.has(name)) return Promise.resolve(undefined);
    const max = this.engine.limits.maxSubscriptions;
    if (max > 0 && !this.engine.registry.get(name) && this.engine.registry.entries().length >= max) {
      const err = new RealtimeError(Code.QuotaExceeded, { message: `more than ${max} subscriptions (session.limits.maxSubscriptions)`, topic: name, local: true });
      this.report(err);
      return Promise.resolve(err);
    }
    const topic = this.set.get(name);
    const sub = topic.subscribe(this.handler as MessageHandler<unknown> as never, {
      from: this.opts.from,
      onGap: this.opts.onGap,
      types: this.opts.types,
      events: this.opts.events,
    });
    this.subs.set(name, sub as unknown as Subscription);
    sub.on('message', (m) => this.emit('message', m as M));
    sub.on('gap', (g) => this.emit('gap', g));
    sub.on('error', (e) => this.report(e));
    sub.on('ended', (e) => this.emit('ended', e));
    return sub.ready.then(
      () => undefined,
      (err: RealtimeError) => err,
    );
  }

  /** @internal A topic left the set. */
  leave(name: string): void {
    const sub = this.subs.get(name);
    if (!sub) return;
    this.subs.delete(name);
    void sub.unsubscribe();
  }

  private async settle(joins: Promise<RealtimeError | undefined>[]): Promise<SetReady> {
    const names = [...this.set.names];
    const results = await Promise.all(joins);
    const ok: string[] = [];
    const failed: { topic: string; error: RealtimeError }[] = [];
    results.forEach((err, i) => (err ? failed.push({ topic: names[i]!, error: err }) : ok.push(names[i]!)));
    if (this.opts.strict && failed.length > 0) throw failed[0]!.error;
    return Object.freeze({ ok: Object.freeze(ok), failed: Object.freeze(failed) });
  }

  private report(err: RealtimeError | Error): void {
    if (this.listenerCount('error') > 0) this.emit('error', err);
    else this.engine.log.warn('topic in a set failed', { err });
  }
}

/**
 * Several topics handled as one: `client.topic(['chat/a', 'chat/b'])`.
 * Subscribing sends every Subscribe frame together, so they leave in packets
 * of up to 64 frames; topics share wire subscriptions with single handles.
 */
export class TopicSet<E extends EventMap = EventMap> {
  private readonly list: string[] = [];
  private readonly live = new Set<SetSubscription<unknown>>();

  /** @internal */
  constructor(
    names: readonly string[],
    private readonly topicFor: (name: string) => Topic<E>,
    private readonly engine: Engine,
  ) {
    this.add(names);
  }

  get names(): readonly string[] {
    return [...this.list];
  }

  /** Adds topics; live subscriptions of the set pick them up. Throws `InvalidTopic` for a malformed name. */
  add(names: string | readonly string[]): this {
    for (const n of typeof names === 'string' ? [names] : names) {
      if (this.list.includes(n)) continue;
      this.topicFor(n); // validates
      this.list.push(n);
      for (const s of this.live) void s.join(n);
    }
    return this;
  }

  /** Removes topics; live subscriptions of the set stop them. */
  remove(names: string | readonly string[]): this {
    for (const n of typeof names === 'string' ? [names] : names) {
      const i = this.list.indexOf(n);
      if (i < 0) continue;
      this.list.splice(i, 1);
      for (const s of this.live) s.leave(n);
    }
    return this;
  }

  /** The single-topic handle, with its own messages and values. */
  get(name: string): Topic<E> {
    return this.topicFor(name);
  }

  /** Subscribes to every topic of the set; `ready` lists which topics failed. */
  subscribe(handler?: MessageHandler<MessageOf<E>>, opts?: SetSubscribeOptions<keyof E & string>): SetSubscription<MessageOf<E>>;
  subscribe(opts: SetSubscribeOptions<keyof E & string>): SetSubscription<MessageOf<E>>;
  subscribe(
    a?: MessageHandler<MessageOf<E>> | SetSubscribeOptions<keyof E & string>,
    b?: SetSubscribeOptions<keyof E & string>,
  ): SetSubscription<MessageOf<E>> {
    const handler = typeof a === 'function' ? a : undefined;
    const opts = (typeof a === 'function' ? b : (a ?? b)) ?? {};
    const sub = new SetSubscription<MessageOf<E>>(this as unknown as SetHost, this.engine, handler, opts);
    this.live.add(sub as unknown as SetSubscription<unknown>);
    return sub;
  }

  /** Publishes the event to every topic; resolves with one receipt per topic, in order. */
  publish<K extends keyof E & string>(event: K, data: E[K], opts: PublishOptions & { delivery: 'signal' }): Promise<void[]>;
  publish<K extends keyof E & string>(event: K, data: E[K], opts?: PublishOptions): Promise<PublishReceipt[]>;
  publish<K extends keyof E & string>(event: K, data: E[K], opts?: PublishOptions): Promise<(PublishReceipt | void)[]> {
    return Promise.all(this.list.map((n) => this.topicFor(n).publish(event, data, opts as PublishOptions)));
  }

  /** @internal */
  detach(sub: object): void {
    this.live.delete(sub as SetSubscription<unknown>);
  }
}
