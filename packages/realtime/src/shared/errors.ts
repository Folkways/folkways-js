import { type CodeInfo, type RetryClass, codeInfo } from './codes';

export interface RealtimeErrorOptions {
  message?: string;
  retryAfterMs?: number;
  topic?: string;
  topicId?: bigint;
  /** Raised by the SDK without a server round-trip. */
  local?: boolean;
  cause?: unknown;
}

/**
 * Every failure the SDK reports: server `OpError`/`Close` codes and local
 * failures alike. `code` is the RTE code (`Code.*`), `retry` says what may be
 * done next.
 */
export class RealtimeError extends Error {
  override readonly name = 'RealtimeError';
  readonly code: number;
  readonly codeName: string;
  readonly retry: RetryClass;
  readonly retryAfterMs?: number;
  readonly topic?: string;
  readonly topicId?: bigint;
  readonly local: boolean;
  readonly cause?: unknown;

  constructor(code: number, opts: RealtimeErrorOptions = {}) {
    const info: CodeInfo = codeInfo(code);
    const detail = opts.message ? `: ${opts.message}` : '';
    const where = opts.topic ? ` (topic ${opts.topic})` : '';
    super(`${info.name}${detail}${where}`);
    this.code = code;
    this.codeName = info.name;
    this.retry = info.retry;
    this.retryAfterMs = opts.retryAfterMs || undefined;
    this.topic = opts.topic;
    this.topicId = opts.topicId;
    this.local = opts.local ?? false;
    this.cause = opts.cause;
  }

  /** The same error attributed to a topic. */
  withTopic(topic: string, topicId?: bigint): RealtimeError {
    if (this.topic === topic) return this;
    return new RealtimeError(this.code, {
      message: this.message.replace(/^[A-Za-z0-9]+: ?/, '') || undefined,
      retryAfterMs: this.retryAfterMs,
      topic,
      topicId: topicId ?? this.topicId,
      local: this.local,
      cause: this.cause,
    });
  }
}

export function localError(code: number, message?: string, cause?: unknown): RealtimeError {
  return new RealtimeError(code, { message, local: true, cause });
}

// Every copy of the class carries this brand on its prototype: each entry
// point (`@folkwaysio/realtime`, `/server`) bundles its own `RealtimeError`, and
// a project may load both the ESM and the CJS build.
const BRAND = Symbol.for('folkways.RealtimeError');
Object.defineProperty(RealtimeError.prototype, BRAND, { value: true });

/** True for a `RealtimeError` from any entry point or build, unlike `instanceof`. */
export function isRealtimeError(e: unknown): e is RealtimeError {
  return typeof e === 'object' && e !== null && (e as Record<symbol, unknown>)[BRAND] === true;
}
