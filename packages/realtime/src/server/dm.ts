import { Code } from '../shared/codes';
import { RealtimeError } from '../shared/errors';
import { topicError } from '../shared/topic';
import { validIdentity } from './identity';
import { jsonObject } from './json';

/** JSON data carried by each invitation. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface DmOpenOptions {
  /** Topic prefix; defaults to dm. The complete room must match a topic rule. */
  readonly prefix?: string;
  /** Application metadata included in each invitation. */
  readonly data?: JsonValue;
}
export interface DmInvite {
  readonly identity: string;
  readonly topic: string;
  /** The same invitation was already accepted within the retained deduplication window. */
  readonly duplicate: boolean;
}
export interface DmOpened {
  readonly topic: string;
  readonly members: readonly string[];
  readonly invites: readonly DmInvite[];
}
export interface DmApi {
  /** Open a room for 2–50 distinct members and invite them. Requires service publish permissions. */
  open(members: readonly string[], options?: DmOpenOptions): Promise<DmOpened>;
}

const invalid = (message: string) => new RealtimeError(Code.InvalidArgument, { message, local: true });
const malformed = () => new RealtimeError(Code.BadFrame, { message: 'invalid direct-message response' });

function parseOpened(value: unknown, members: readonly string[], prefix: string): DmOpened {
  if (!jsonObject(value) || typeof value.topic !== 'string' || topicError(value.topic) ||
      !value.topic.startsWith(prefix + '/') || value.topic.slice(prefix.length + 1).includes('/') ||
      !Array.isArray(value.members) || value.members.length !== members.length ||
      !members.every((m, i) => value.members instanceof Array && value.members[i] === m) ||
      !Array.isArray(value.invites) || value.invites.length !== members.length) throw malformed();
  const invites = value.invites.map((invite: unknown, i: number) => {
    const identity = members[i]!;
    const topic = '$user/' + identity;
    if (!jsonObject(invite) || invite.identity !== identity || invite.topic !== topic || typeof invite.duplicate !== 'boolean') throw malformed();
    return Object.freeze({ identity, topic, duplicate: invite.duplicate });
  });
  return Object.freeze({ topic: value.topic, members: Object.freeze([...members]), invites: Object.freeze(invites) });
}

export function createDmApi(call: (path: string, body: object) => Promise<unknown>): DmApi {
  return Object.freeze({
    async open(members: readonly string[], options: DmOpenOptions = {}) {
      if (!Array.isArray(members) || !Array.from(members).every(validIdentity)) throw invalid('members must be non-anonymous identities of one topic level');
      const distinct = [...new Set(members)].sort();
      if (distinct.length < 2 || distinct.length > 50) throw invalid('a room needs 2 to 50 distinct members');
      if (!jsonObject(options)) throw invalid('direct-message options must be an object');
      const prefix = options.prefix ?? 'dm';
      if (typeof prefix !== 'string' || topicError(prefix + '/' + '0'.repeat(24))) {
        throw new RealtimeError(Code.InvalidTopic, { message: 'prefix must fit a valid room topic', local: true });
      }
      // Snapshot data before any asynchronous signing or fetch, and reject values
      // JSON cannot represent instead of silently changing invitation content.
      let data: JsonValue | undefined;
      if (options.data !== undefined) {
        try {
          data = JSON.parse(JSON.stringify(options.data, (_key, v) => {
            if (v === undefined || typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint' || (typeof v === 'number' && !Number.isFinite(v))) throw new Error('not JSON');
            return v;
          })) as JsonValue;
        } catch { throw invalid('invitation data must be JSON-serializable'); }
      }
      const response = await call('/v1/dm/open', { members: distinct, ...(options.prefix !== undefined ? { prefix } : {}), ...(data !== undefined ? { data } : {}) });
      return parseOpened(response, distinct, prefix);
    },
  });
}
