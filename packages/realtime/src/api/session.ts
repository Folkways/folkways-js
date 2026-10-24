import type { Limits, SessionInfo, TransportKind } from '../engine';
import { format128 } from '../shared/random';
import { topicMatches } from '../shared/topic';
import type { Op, Permission, Session } from './types';

const OPS: ReadonlySet<string> = new Set<Op>(['subscribe', 'publish', 'set', 'signal', 'presence', 'history']);

/** Builds the immutable `Session` handed to the app from what the engine learned. */
export function toSession(info: SessionInfo, limits: Limits, transport: TransportKind, expiresAt: number | undefined): Session {
  const permissions: Permission[] = info.capabilities.map((c) => ({
    topics: c.topic,
    ops: c.ops.filter((o): o is Op => OPS.has(o)),
  }));
  return Object.freeze({
    identity: info.anonymous || !info.identity ? null : info.identity,
    anonymous: info.anonymous,
    id: info.sessionId ? format128(info.sessionId) : '',
    segment: info.segmentId ? Object.freeze({ id: info.segmentId, environment: info.environment || null }) : null,
    permissions: Object.freeze(permissions),
    can: (op: Op, topic: string) => permissions.some((p) => p.ops.includes(op) && topicMatches(p.topics, topic)),
    expiresAt: expiresAt ?? info.expiresAtMs ?? null,
    limits,
    transport,
    features: Object.freeze([...info.features]),
  });
}
