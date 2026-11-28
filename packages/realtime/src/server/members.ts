import type { Op } from '../api/types';
import { Code } from '../shared/codes';
import { RealtimeError } from '../shared/errors';
import { topicError } from '../shared/topic';
import { jsonObject } from './json';

export interface TopicMember {
  readonly identity: string;
  readonly ops: readonly Op[];
}
export interface MemberList {
  readonly topic: string;
  readonly members: readonly TopicMember[];
}
export interface MembersApi {
  /** Set exactly these operations for 1–1,000 identities, adding them if absent. */
  add(topic: string, identities: readonly string[], ops: readonly Op[]): Promise<void>;
  /** Replace one identity's operations. */
  set(topic: string, identity: string, ops: readonly Op[]): Promise<void>;
  /** Remove every operation for the named identities. */
  remove(topic: string, identities: readonly string[]): Promise<void>;
  /** Remove all members. */
  clear(topic: string): Promise<void>;
  /** Read the current member list. */
  list(topic: string): Promise<MemberList>;
}

const OPS: readonly Op[] = ['subscribe', 'publish', 'set', 'signal', 'history', 'presence'];
const invalid = (message: string) => new RealtimeError(Code.InvalidArgument, { message, local: true });

function validIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 245 && /^[A-Za-z0-9._~:@=+-]+$/.test(value) && !value.startsWith('anon:');
}
function validOps(value: unknown): value is Op[] {
  return Array.isArray(value) && value.length > 0 && value.every((op) => OPS.includes(op as Op));
}
function check(topic: string, identities?: readonly string[], ops?: readonly Op[]): void {
  const error = topicError(topic);
  if (error) throw invalid(error);
  if (identities !== undefined && (!Array.isArray(identities) || identities.length < 1 || identities.length > 1000 || !Array.from(identities).every(validIdentity))) {
    throw invalid('name 1 to 1,000 identities; each must be a non-anonymous topic level of at most 245 bytes');
  }
  if (ops !== undefined && !validOps(Array.from(ops))) throw invalid('ops must grant at least one supported operation');
}
function parseList(value: unknown, topic: string): MemberList {
  if (!jsonObject(value) || value.topic !== topic || !Array.isArray(value.members) || value.members.length > 10_000) {
    throw new RealtimeError(Code.BadFrame, { message: 'invalid member list response', topic });
  }
  const members = value.members.map((m: unknown) => {
    if (!jsonObject(m) || !validIdentity(m.identity) || !validOps(m.ops)) {
      throw new RealtimeError(Code.BadFrame, { message: 'invalid member list entry', topic });
    }
    return Object.freeze({ identity: m.identity, ops: Object.freeze([...m.ops]) });
  });
  return Object.freeze({ topic, members: Object.freeze(members) });
}

export function createMembersApi(call: (path: string, body: object, status: 200 | 204, topic: string) => Promise<unknown>): MembersApi {
  return Object.freeze({
    async add(topic: string, identities: readonly string[], ops: readonly Op[]) {
      if (!Array.isArray(identities) || !Array.isArray(ops)) throw invalid('identities and ops must be arrays');
      check(topic, identities, ops);
      await call('/v1/members/add', { topic, identities: [...identities], ops: [...ops] }, 204, topic);
    },
    async set(topic: string, identity: string, ops: readonly Op[]) {
      if (!Array.isArray(ops)) throw invalid('ops must be an array');
      check(topic, [identity], ops);
      await call('/v1/members/set', { topic, identity, ops: [...ops] }, 204, topic);
    },
    async remove(topic: string, identities: readonly string[]) {
      if (!Array.isArray(identities)) throw invalid('identities must be an array');
      check(topic, identities);
      await call('/v1/members/remove', { topic, identities: [...identities] }, 204, topic);
    },
    async clear(topic: string) {
      check(topic);
      await call('/v1/members/clear', { topic }, 204, topic);
    },
    async list(topic: string) {
      check(topic);
      return parseList(await call('/v1/members/list', { topic }, 200, topic), topic);
    },
  });
}
