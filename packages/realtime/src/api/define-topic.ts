import { Code } from '../shared/codes';
import { RealtimeError } from '../shared/errors';
import { topicError } from '../shared/topic';
import { eventNameError } from '../shared/event-name';
import type { Realtime } from './realtime';
import type { Topic } from './topic';
import { validTtlMs } from './ttl';
import type { Delivery, EventMap, Op } from './types';

/** How one event is delivered, with optional KV key constraints or KV/signal lifetime. */
export type EventDefinition = Delivery | { readonly delivery: Delivery; readonly keyIsPublisher?: boolean; readonly ttlMs?: number };

/** Event names to their definitions. */
export type EventDefinitions<E extends EventMap> = { readonly [K in keyof E & string]: EventDefinition };

/** The names of the signal events in a definition (their publish resolves with nothing). */
export type SignalEvents<D> = {
  [K in keyof D & string]: D[K] extends 'signal' | { readonly delivery: 'signal' } ? K : never;
}[keyof D & string];

export interface TopicDefinitionSpec<E extends EventMap, D extends EventDefinitions<E> = EventDefinitions<E>> {
  /** Every event the topic carries; unknown names are refused locally. */
  readonly events: D;
  /** `members`: private topics guarded by member lists on the node. Default `token`. */
  readonly access?: 'token' | 'members';
  /** Subscribing makes the connection present in the topic. Default false. */
  readonly presence?: boolean;
}

/** The topic rule for the portal or CI, generated from the definition. */
export interface TopicRule {
  readonly pattern: string;
  readonly types: readonly Delivery[];
  readonly events: Readonly<Record<string, {
    readonly delivery: Delivery;
    /** KV key must equal the publisher. */
    readonly key_is_publisher?: boolean;
    /** KV or signal lifetime in milliseconds; zero means until replaced. */
    readonly ttl_ms?: number;
  }>>;
  readonly strict_events: true;
  readonly access: 'token' | 'members';
  readonly presence: boolean;
}

/** The `{name}` placeholders of a pattern, as a union of names. */
export type TopicParams<P extends string> = P extends `${string}{${infer K}}${infer R}` ? K | TopicParams<R> : never;

export interface TopicDefinition<E extends EventMap, P extends string, S extends keyof E & string = never> {
  /** The pattern as written, e.g. `chat/{room}`. */
  readonly pattern: P;
  readonly events: Readonly<Record<keyof E & string, { readonly delivery: Delivery; readonly keyIsPublisher: boolean; readonly ttlMs?: number }>>;
  /** The concrete topic name for these parameters. Throws `InvalidTopic` for a value that is not one topic level. */
  topic(params: Record<TopicParams<P>, string>): string;
  /** The typed handle for these parameters: publish fills in each event's delivery (and KV or signal TTL). */
  open(client: Realtime, params: Record<TopicParams<P>, string>): Topic<E, S>;
  /** The topic rule (`chat/{room}` → pattern `chat/*`). */
  rule(): TopicRule;
  /** The operations a member needs, for member permissions and token ceilings. */
  memberOps(): Op[];
}

const OP_FOR: Record<Delivery, Op> = { stream: 'publish', kv: 'set', signal: 'signal' };

function invalid(message: string): RealtimeError {
  return new RealtimeError(Code.InvalidArgument, { message, local: true });
}

/**
 * One shared definition of a product's topic, for web, mobile, backend and
 * CI alike. SDK handles, token ceilings and the portal rule all come from
 * it, so event names and types cannot drift between apps.
 *
 *   export const chatRoom = defineTopic<ChatEvents>()('chat/{room}', {
 *     events: { message: 'stream', typing: 'signal', read: { delivery: 'kv', keyIsPublisher: true } },
 *     access: 'members',
 *     presence: true,
 *   });
 *   const room = chatRoom.open(client, { room: '45' });
 *
 * Called with only the event map type, it returns the definer, so the
 * pattern's parameters are inferred.
 */
export function defineTopic<E extends EventMap>(): <P extends string, const D extends EventDefinitions<E>>(
  pattern: P,
  spec: TopicDefinitionSpec<E, D>,
) => TopicDefinition<E, P, SignalEvents<D>>;
export function defineTopic<E extends EventMap, P extends string = string>(pattern: P, spec: TopicDefinitionSpec<E>): TopicDefinition<E, P>;
export function defineTopic<E extends EventMap, P extends string>(
  pattern?: P,
  spec?: TopicDefinitionSpec<E>,
): unknown {
  if (pattern === undefined) return (p: string, s: TopicDefinitionSpec<E>) => build<E, string>(p, s);
  return build<E, P>(pattern, spec!);
}

function build<E extends EventMap, P extends string>(pattern: P, spec: TopicDefinitionSpec<E>): TopicDefinition<E, P> {
  if (typeof pattern !== 'string' || pattern.length === 0) throw invalid('defineTopic needs a pattern such as "chat/{room}"');
  if (!spec || !spec.events || typeof spec.events !== 'object' || Array.isArray(spec.events) || Object.keys(spec.events).length === 0) throw invalid('defineTopic needs at least one event');
  const params = [...pattern.matchAll(/\{([^}/]+)\}/g)].map((m) => m[1]!);
  const rulePattern = pattern.replace(/\{[^}/]+\}/g, '*');
  const probe = topicError(rulePattern.replace(/\*/g, 'x'));
  if (probe) throw invalid(`pattern "${pattern}": ${probe}`);

  const events: Record<string, { delivery: Delivery; keyIsPublisher: boolean; ttlMs?: number }> = Object.create(null);
  for (const [name, def] of Object.entries(spec.events as Record<string, EventDefinition>)) {
    const nameError = eventNameError(name);
    if (nameError) throw invalid(`event "${name}": ${nameError}`);
    const d = typeof def === 'string' ? { delivery: def } : def;
    if (!d || typeof d !== 'object' || Array.isArray(d)) throw invalid(`event "${name}": expected a delivery type or options`);
    if (d.keyIsPublisher !== undefined && typeof d.keyIsPublisher !== 'boolean') throw invalid(`event "${name}": keyIsPublisher must be a boolean`);
    if (!['stream', 'kv', 'signal'].includes(d.delivery)) throw invalid(`event "${name}": unknown delivery "${String(d.delivery)}"`);
    if (d.keyIsPublisher && d.delivery !== 'kv') throw invalid(`event "${name}": keyIsPublisher applies to kv events only`);
    if (d.ttlMs !== undefined) {
      if (d.delivery === 'stream') throw invalid(`event "${name}": ttlMs applies to kv and signal events only`);
      if (!validTtlMs(d.ttlMs)) throw invalid(`event "${name}": ttlMs must be an integer between 0 and 4294967295`);
    }
    events[name] = Object.freeze({ delivery: d.delivery, keyIsPublisher: d.keyIsPublisher ?? false, ttlMs: d.ttlMs });
  }
  Object.freeze(events);

  const topic = (values: Record<string, string>): string => {
    let name: string = pattern;
    for (const p of params) {
      const v = values?.[p];
      if (typeof v !== 'string' || v.length === 0 || v.includes('/')) {
        throw new RealtimeError(Code.InvalidTopic, { message: `parameter "${p}" must be one non-empty topic level`, local: true });
      }
      name = name.replace(`{${p}}`, v);
    }
    const err = topicError(name);
    if (err) throw new RealtimeError(Code.InvalidTopic, { message: err, topic: name, local: true });
    return name;
  };

  return Object.freeze({
    pattern,
    events: events as TopicDefinition<E, P>['events'],
    topic: topic as TopicDefinition<E, P>['topic'],
    open(client: Realtime, values: Record<TopicParams<P>, string>): Topic<E> {
      const t = client.topic<E>(topic(values as Record<string, string>));
      t.define(events);
      return t as Topic<E>;
    },
    rule(): TopicRule {
      const map = Object.fromEntries(Object.entries(events).map(([name, d]) => [name, Object.freeze({
        delivery: d.delivery,
        ...(d.keyIsPublisher ? { key_is_publisher: true } : {}),
        ...(d.ttlMs !== undefined ? { ttl_ms: d.ttlMs } : {}),
      })]));
      return Object.freeze({
        pattern: rulePattern,
        types: Object.freeze([...new Set(Object.values(events).map(d => d.delivery))].sort()),
        events: Object.freeze(map),
        strict_events: true,
        access: spec.access ?? 'token',
        presence: spec.presence ?? false,
      });
    },
    memberOps(): Op[] {
      const ops = new Set<Op>(['subscribe']);
      for (const d of Object.values(events)) ops.add(OP_FOR[d.delivery]);
      if (spec.presence) ops.add('presence');
      return [...ops];
    },
  });
}
