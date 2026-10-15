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
export function topicError(name: string, maxBytes = MAX_TOPIC_BYTES): string | undefined {
  if (typeof name !== 'string' || name.length === 0) return 'topic name is empty';
  if (name.length > maxBytes) return `topic name is longer than ${maxBytes} bytes`;
  if (name.startsWith('$')) return 'topic names starting with $ are reserved';
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

export function assertTopic(name: string, maxBytes?: number): void {
  const err = topicError(name, maxBytes);
  if (err) throw new RealtimeError(Code.InvalidTopic, { message: err, topic: String(name), local: true });
}
