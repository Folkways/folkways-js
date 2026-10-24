import { Code } from './codes';
import { RealtimeError } from './errors';

/** Limits of the topic grammar (RTE protocol guide §9). */
export const MAX_TOPIC_BYTES = 255;
export const MAX_TOPIC_LEVELS = 16;

const LEVEL = /^[A-Za-z0-9._~:@=+-]+$/;

/**
 * Why a topic name is invalid, or `undefined` when it is valid. Topics are
 * ASCII, `/`-separated levels of `A-Z a-z 0-9 . _ ~ : @ = + -`, at most 16
 * levels and 255 bytes; names starting with `$` are reserved.
 */
/** System topics apps may read: kept by the node (ADR-001 D3, D8). */
export const SYSTEM_PREFIXES = ['$user/', '$online/', '$presence/'] as const;

export function isSystemTopic(name: string): boolean {
  return SYSTEM_PREFIXES.some((p) => name.startsWith(p));
}

export function topicError(name: string, maxBytes = MAX_TOPIC_BYTES, allowSystem = false): string | undefined {
  if (typeof name !== 'string' || name.length === 0) return 'topic name is empty';
  if (name.length > maxBytes) return `topic name is longer than ${maxBytes} bytes`;
  if (name.startsWith('$')) {
    if (!allowSystem || !isSystemTopic(name)) return 'topic names starting with $ are reserved ($user/, $online/ and $presence/ are readable)';
    name = name.slice(1);
  }
  const levels = name.split('/');
  if (levels.length > MAX_TOPIC_LEVELS) return `topic has more than ${MAX_TOPIC_LEVELS} levels`;
  for (const level of levels) {
    if (!LEVEL.test(level)) {
      return level.length === 0
        ? 'topic has an empty level'
        : `topic level "${level}" has characters outside A-Z a-z 0-9 . _ ~ : @ = + -`;
    }
  }
  return undefined;
}

export function assertTopic(name: string, maxBytes?: number, allowSystem = false): void {
  const err = topicError(name, maxBytes, allowSystem);
  if (err) throw new RealtimeError(Code.InvalidTopic, { message: err, topic: String(name), local: true });
}

/**
 * True when `topic` matches `pattern` with the node's rules: levels split
 * on `/`, `*` matches exactly one level, a trailing `>` one or more.
 */
export function topicMatches(pattern: string, topic: string): boolean {
  const want = pattern.split('/');
  const have = topic.split('/');
  for (let i = 0; i < want.length; i++) {
    const w = want[i]!;
    if (w === '>' && i === want.length - 1) return have.length > i;
    if (i >= have.length) return false;
    if (w !== '*' && w !== have[i]) return false;
  }
  return have.length === want.length;
}
