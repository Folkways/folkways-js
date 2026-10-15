import { AckMode, type Engine, type Header, OnGap, type PubAck, type PublishBody, StartAt, type SubscribeSpec } from '../engine';
import { Code } from '../shared/codes';
import { type Cursor, formatCursor, parseCursor } from '../shared/cursor';
import { RealtimeError } from '../shared/errors';
import { parse128, random128 } from '../shared/random';
import {
  type ContentTypeName,
  type DeliveryClassName,
  type PublishReceipt,
  deliveryClassCode,
  encodePayload,
} from './message';
import { type MessageHandler, Subscription } from './subscription';

export interface PublishOptions {
  /** Payload type; inferred from `data` when omitted. */
  contentType?: ContentTypeName | number;
  /** Up to `limits.maxHeaders` string headers, passed through to subscribers. */
  headers?: Record<string, string>;
  /** 32 hex digits or a UUID. Reuse it to retry the same logical publish; generated otherwise. */
  idempotencyKey?: string;
  /** Assert the topic's class; the node rejects a mismatch with `ClassMismatch`. */
  expect?: DeliveryClassName;
  /** LastValue item key. */
  key?: string;
  /** LastValue: how long the value lives (ms). */
  ttlMs?: number;
  /** Your clock for this event (Unix ms). Defaults to `Date.now()`. */
  clientTime?: number;
  /** Abort waiting for the receipt (the node may still apply the publish). */
  signal?: AbortSignal;
}

export type SignalOptions = Pick<PublishOptions, 'contentType' | 'headers' | 'expect'>;

export type StartFrom = 'latest' | 'oldest' | { after: Cursor | string } | { last: number };

export interface SubscribeOptions {
  /** Where to start when there is no stored cursor. Default `'latest'`. */
  from?: StartFrom;
  /** What to do when the cursor cannot be honoured. Default `'from-oldest'`. */
  onGap?: 'from-oldest' | 'from-latest' | 'fail';
  /** State topics: deliver the current values first. Default true. */
  snapshot?: boolean;
  /** Resume after the cursor in the cursor store, when there is one. Default true. */
  resume?: boolean;
}

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

export function toSpec(opts: SubscribeOptions | undefined, topic: string): SubscribeSpec {
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
  const onGap = { 'from-oldest': OnGap.FromOldest, 'from-latest': OnGap.FromLatest, fail: OnGap.Fail }[
    opts?.onGap ?? 'from-oldest'
  ];
  if (onGap === undefined) throw invalid(`unknown onGap "${String(opts?.onGap)}"`, topic);
  return { start, cursor, lastN, onGap, snapshot: opts?.snapshot ?? true, resume: opts?.resume ?? true };
}

function receipt(topic: string, ack: PubAck): PublishReceipt {
  return {
    topic,
    topicId: ack.topicId,
    cursor: ack.cursor,
    id: formatCursor(ack.cursor),
    level: ack.level === AckMode.Committed ? 'committed' : 'accepted',
    duplicate: ack.duplicate,
    serverTime: ack.serverTsMs,
  };
}

/** A handle on one topic: publish to it and subscribe to it. */
export class Topic {
  /** @internal */
  constructor(
    readonly name: string,
    private readonly engine: Engine,
    private readonly signalTtlMs: number,
  ) {}

  /**
   * Publishes an event and resolves with the node's receipt. Retries reuse
   * the idempotency key, so a publish is applied at most once.
   */
  async publish(data: unknown, opts: PublishOptions = {}): Promise<PublishReceipt> {
    const body = this.body(data, opts, AckMode.Accepted, true);
    const ack = await this.engine.publish(this.name, body, true, opts.signal);
    if (!ack) throw new RealtimeError(Code.Internal, { message: 'publish settled without a receipt', topic: this.name, local: true });
    return receipt(this.name, ack);
  }

  /** LastValue: sets the value of `key` (optionally expiring after `ttlMs`). */
  set(key: string, data: unknown, opts: Omit<PublishOptions, 'key'> = {}): Promise<PublishReceipt> {
    if (typeof key !== 'string' || key.length === 0) return Promise.reject(invalid('key must be a non-empty string', this.name));
    return this.publish(data, { ...opts, key });
  }

  /** LastValue: deletes `key` (publishes a tombstone). */
  async delete(key: string, opts: Pick<PublishOptions, 'headers' | 'idempotencyKey' | 'signal'> = {}): Promise<PublishReceipt> {
    if (typeof key !== 'string' || key.length === 0) throw invalid('key must be a non-empty string', this.name);
    const body: PublishBody = { ...this.body(new Uint8Array(0), opts, AckMode.Accepted, true), key, tombstone: true };
    const ack = await this.engine.publish(this.name, body, true, opts.signal);
    if (!ack) throw new RealtimeError(Code.Internal, { message: 'publish settled without a receipt', topic: this.name, local: true });
    return receipt(this.name, ack);
  }

  /**
   * Fire-and-forget (`NoAck`), for Ephemeral signals such as typing or
   * cursors. Dropped while offline; failures are only logged.
   */
  signal(data: unknown, opts: SignalOptions = {}): void {
    let body: PublishBody;
    try {
      body = this.body(data, opts, AckMode.NoAck, false);
    } catch (err) {
      this.engine.log.warn('signal not sent', { topic: this.name, err });
      return;
    }
    this.engine.publish(this.name, body, false).catch((err) => this.engine.log.debug('signal not sent', { topic: this.name, err }));
  }

  /**
   * Subscribes to the topic. The handler (optional; you can also listen to
   * `message`) runs for each event, in order; return a promise to hold the
   * next event until it settles.
   */
  subscribe<T = unknown>(handler?: MessageHandler<T>, opts?: SubscribeOptions): Subscription<T>;
  subscribe<T = unknown>(opts: SubscribeOptions): Subscription<T>;
  subscribe<T = unknown>(a?: MessageHandler<T> | SubscribeOptions, b?: SubscribeOptions): Subscription<T> {
    const handler = typeof a === 'function' ? a : undefined;
    const opts = typeof a === 'function' ? b : (a ?? b);
    return new Subscription<T>(this.name, this.engine, toSpec(opts, this.name), handler, this.signalTtlMs);
  }

  private body(data: unknown, opts: PublishOptions, ack: AckMode, withKey: boolean): PublishBody {
    const { payload, contentType } = encodePayload(data, opts.contentType);
    let idempotencyKey: { hi: bigint; lo: bigint } | undefined;
    if (withKey) {
      idempotencyKey = opts.idempotencyKey !== undefined ? parse128(opts.idempotencyKey) : random128();
      if (!idempotencyKey) throw invalid('idempotencyKey must be 32 hex digits or a UUID', this.name);
    }
    if (opts.ttlMs !== undefined && !(Number.isInteger(opts.ttlMs) && opts.ttlMs >= 0 && opts.ttlMs <= 0xffffffff)) {
      throw invalid('ttlMs must be a non-negative integer', this.name);
    }
    return {
      topic: { name: this.name },
      payload,
      contentType,
      delivery: opts.expect ? deliveryClassCode(opts.expect) : undefined,
      ack,
      idempotencyKey,
      key: opts.key,
      ttlMs: opts.ttlMs,
      clientTsMs: opts.clientTime ?? Date.now(),
      headers: toHeaders(opts.headers, this.name),
    };
  }
}
