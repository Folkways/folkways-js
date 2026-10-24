import { AckMode, type Engine, type Header, OnGap, type PubAck, type PublishBody, StartAt, type SubscribeSpec } from '../engine';
import { Code } from '../shared/codes';
import { type Cursor, parseCursor } from '../shared/cursor';
import { RealtimeError } from '../shared/errors';
import { format128, parse128, random128 } from '../shared/random';
import { deliveryCode, encodePayload, eventId } from './message';
import { Subscription } from './subscription';
import type {
  Delivery,
  EventMap,
  LiveView,
  Message,
  MessageHandler,
  MessageOf,
  PublishOptions,
  PublishReceipt,
  StartFrom,
  SubscribeOptions,
  TopicMessage,
} from './types';
import { TopicViews, type ValuesView } from './views';

function invalid(message: string, topic: string): RealtimeError {
  return new RealtimeError(Code.InvalidArgument, { message, topic, local: true });
}

function toHeaders(h: Record<string, string> | undefined, topic: string): Header[] | undefined {
  if (!h) return undefined;
  const out: Header[] = [];
  for (const [k, v] of Object.entries(h)) {
    if (typeof v !== 'string') throw invalid(`header "${k}" must be a string`, topic);
    out.push([k, v]);
  }
  return out.length ? out : undefined;
}

export function toSpec(opts: { from?: StartFrom; onGap?: SubscribeOptions['onGap'] } | undefined, topic: string): SubscribeSpec {
  const from = opts?.from ?? 'latest';
  let start = StartAt.Latest;
  let cursor: Cursor | undefined;
  let lastN = 0;
  if (from === 'oldest') start = StartAt.Oldest;
  else if (from === 'latest') start = StartAt.Latest;
  else if (typeof from === 'object' && 'after' in from) {
    start = StartAt.After;
    cursor = typeof from.after === 'string' ? parseCursor(from.after) : from.after;
    if (!cursor) throw invalid(`from.after must be a cursor or "epoch:seq"`, topic);
  } else if (typeof from === 'object' && 'last' in from) {
    if (!Number.isInteger(from.last) || from.last < 1) throw invalid('from.last must be a positive integer', topic);
    start = StartAt.LastN;
    lastN = from.last;
  } else {
    throw invalid(`unknown from: ${JSON.stringify(from)}`, topic);
  }
  const onGap = { 'from-oldest': OnGap.FromOldest, 'from-latest': OnGap.FromLatest, fail: OnGap.Fail }[opts?.onGap ?? 'from-oldest'];
  if (onGap === undefined) throw invalid(`unknown onGap "${String(opts?.onGap)}"`, topic);
  return { start, cursor, lastN, onGap, snapshot: true, resume: true };
}

export function toReceipt(topic: string, delivery: Delivery, ack: PubAck): PublishReceipt {
  const cursor = ack.cursor.seq > 0n ? ack.cursor : undefined;
  const uid = ack.uid ? format128(ack.uid) : undefined;
  return {
    topic,
    delivery,
    uid,
    cursor,
    id: eventId(cursor, uid, ''),
    level: ack.level === AckMode.Committed ? 'committed' : 'accepted',
    duplicate: ack.duplicate,
    serverTime: ack.serverTsMs,
  };
}

/**
 * A room: one topic, many named events. Each event is a `stream`, `kv` or
 * `signal` event, chosen per publish (or fixed by the topic's definition).
 * Get it with `client.topic(name)`; handles are cached by name.
 */
export class Topic<E extends EventMap = EventMap, S extends keyof E & string = never> {
  private readonly views: TopicViews;
  private defined?: Readonly<Record<string, { readonly delivery: Delivery; readonly ttlMs?: number }>>;

  /** @internal */
  constructor(
    readonly name: string,
    protected readonly engine: Engine,
    protected readonly signalTtlMs: number,
  ) {
    this.views = new TopicViews(name, engine, signalTtlMs);
  }

  /**
   * Recent stream events (up to 100) as a live view, including this
   * client's sends: `pending` at once, `sent` on the node's receipt,
   * `failed` with a `retry()`. Filled while a subscription of this handle is
   * active (sends show either way).
   */
  get messages(): LiveView<readonly TopicMessage<E[keyof E & string], keyof E & string>[]> {
    return this.views.messages as unknown as LiveView<readonly TopicMessage<E[keyof E & string], keyof E & string>[]>;
  }

  /**
   * Current values of an event, as a live ReadonlyMap: kv values by key,
   * signals by publisher (sent in the last 5 s). Without an event name,
   * every value of the topic keyed `name/key` (e.g. a `$presence/…` topic,
   * whose entries have no name, keeps plain keys). Filled while a
   * subscription of this handle is active.
   */
  values<K extends keyof E & string>(event?: K): ValuesView {
    return this.views.values(event);
  }

  /**
   * Publishes one event. Stream and kv events resolve with the node's
   * receipt; retries reuse the idempotency key, so an event is applied at
   * most once. Signals are fire-and-forget: dropped while not connected,
   * and the promise resolves once written (or dropped).
   */
  publish<K extends S>(event: K, data: E[K], opts?: PublishOptions): Promise<void>;
  publish<K extends keyof E & string>(event: K, data: E[K], opts: PublishOptions & { delivery: 'signal' }): Promise<void>;
  publish<K extends Exclude<keyof E & string, S>>(event: K, data: E[K], opts?: PublishOptions): Promise<PublishReceipt>;
  publish<K extends keyof E & string>(event: K, data: E[K], opts: PublishOptions = {}): Promise<PublishReceipt | void> {
    let delivery: Delivery;
    let body: PublishBody;
    try {
      delivery = this.deliveryFor(event, opts);
      body = this.body(event, data, delivery, this.withDefaults(event, opts));
    } catch (err) {
      return Promise.reject(err);
    }
    if (delivery === 'signal') {
      return this.engine.publish(this.name, body, false).then(
        () => undefined,
        (err) => this.engine.log.debug('signal not sent', { topic: this.name, err }),
      );
    }
    if (delivery === 'kv') return this.send(body, delivery, opts.signal);
    // Stream: show the send at once, then settle it in place.
    const localId = `local:${format128(body.idempotencyKey!)}`;
    const attempt = (): Promise<PublishReceipt> =>
      this.send(body, delivery, opts.signal).then(
        (r) => {
          this.views.acked(localId, r);
          return r;
        },
        (err: RealtimeError) => {
          this.views.failed(localId, err);
          throw err;
        },
      );
    this.views.addPending(localId, this.pendingMessage(event, data, body, localId), async () => {
      this.views.retrying(localId);
      await attempt();
    });
    return attempt();
  }

  /**
   * Subscribes. The handler (optional; you can also listen to `message`)
   * runs for each event, in order, one at a time; return a promise to hold
   * the next event until it settles. The cursor is saved after it settles.
   */
  subscribe(handler?: MessageHandler<MessageOf<E>>, opts?: SubscribeOptions<keyof E & string>): Subscription<MessageOf<E>>;
  subscribe(opts: SubscribeOptions<keyof E & string>): Subscription<MessageOf<E>>;
  subscribe(
    a?: MessageHandler<MessageOf<E>> | SubscribeOptions<keyof E & string>,
    b?: SubscribeOptions<keyof E & string>,
  ): Subscription<MessageOf<E>> {
    const handler = typeof a === 'function' ? a : undefined;
    const opts = typeof a === 'function' ? b : (a ?? b);
    return new Subscription<MessageOf<E>>(
      this.name,
      this.engine,
      toSpec(opts, this.name),
      handler,
      { types: opts?.types?.map(deliveryCode), events: opts?.events },
      this.views,
    );
  }

  private send(body: PublishBody, delivery: Delivery, signal?: AbortSignal): Promise<PublishReceipt> {
    return this.engine.publish(this.name, body, true, signal).then((ack) => {
      if (!ack) throw new RealtimeError(Code.Internal, { message: 'publish settled without a receipt', topic: this.name, local: true });
      return toReceipt(this.name, delivery, ack);
    });
  }

  private pendingMessage(event: string, data: unknown, body: PublishBody, localId: string): Message {
    const info = this.engine.info;
    const headers: Record<string, string> = {};
    for (const [k, v] of body.headers ?? []) headers[k] = v;
    return {
      topic: this.name,
      name: event,
      delivery: 'stream',
      publisher: info?.identity ?? '',
      data,
      id: localId,
      deleted: false,
      headers,
      contentType: body.contentType ?? 0,
      payload: body.payload,
      serverTime: body.clientTsMs ?? Date.now(),
      clientTime: body.clientTsMs,
      replayed: false,
      pending: true,
      fromCache: false,
    };
  }

  /** @internal Applies a `defineTopic()` event map to this handle. */
  define(events: Readonly<Record<string, { readonly delivery: Delivery; readonly ttlMs?: number }>>): void {
    this.defined = events;
  }

  /** The delivery of an event: the option, else the topic's definition, else `stream`. */
  private deliveryFor(event: string, opts: PublishOptions): Delivery {
    if (!this.defined) return opts.delivery ?? 'stream';
    const def = this.defined[event];
    if (!def) throw invalid(`event "${event}" is not in this topic's definition`, this.name);
    if (opts.delivery && opts.delivery !== def.delivery) {
      throw new RealtimeError(Code.ClassMismatch, {
        message: `event "${event}" is a ${def.delivery} event in this topic's definition`,
        topic: this.name,
        local: true,
      });
    }
    return def.delivery;
  }

  /** Options the topic's definition fills in. */
  private withDefaults(event: string, opts: PublishOptions): PublishOptions {
    const ttlMs = this.defined?.[event]?.ttlMs;
    return ttlMs !== undefined && opts.ttlMs === undefined && !opts.remove ? { ...opts, ttlMs } : opts;
  }

  private body(event: string, data: unknown, delivery: Delivery, opts: PublishOptions): PublishBody {
    if (typeof event !== 'string' || event.length === 0) throw invalid('event name must be a non-empty string', this.name);
    if (opts.remove && delivery !== 'kv') throw invalid('remove applies to kv events only', this.name);
    if ((opts.key !== undefined || opts.ttlMs !== undefined) && delivery !== 'kv') {
      throw invalid('key and ttlMs apply to kv events only', this.name);
    }
    if (opts.key !== undefined && (typeof opts.key !== 'string' || opts.key.length === 0)) {
      throw invalid('key must be a non-empty string', this.name);
    }
    if (opts.ttlMs !== undefined && !(Number.isInteger(opts.ttlMs) && opts.ttlMs >= 0 && opts.ttlMs <= 0xffffffff)) {
      throw invalid('ttlMs must be a non-negative integer', this.name);
    }
    const { payload, contentType } = opts.remove ? { payload: new Uint8Array(0), contentType: 0 } : encodePayload(data, opts.contentType);
    let idempotencyKey: { hi: bigint; lo: bigint } | undefined;
    if (delivery !== 'signal') {
      idempotencyKey = opts.idempotencyKey !== undefined ? parse128(opts.idempotencyKey) : random128();
      if (!idempotencyKey) throw invalid('idempotencyKey must be 32 hex digits or a UUID', this.name);
    }
    // kv: the key defaults to your identity (read receipts, locations).
    const info = this.engine.info;
    const key = delivery === 'kv' ? (opts.key ?? (info && !info.anonymous ? info.identity : undefined)) : undefined;
    return {
      topic: { name: this.name },
      name: event,
      payload,
      contentType: contentType || undefined,
      delivery: deliveryCode(delivery),
      ack: delivery === 'signal' ? AckMode.NoAck : AckMode.Accepted,
      idempotencyKey,
      key,
      tombstone: opts.remove || undefined,
      ttlMs: opts.ttlMs,
      clientTsMs: opts.clientTime ?? Date.now(),
      headers: toHeaders(opts.headers, this.name),
    };
  }
}
