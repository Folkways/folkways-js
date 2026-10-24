/**
 * RTE outcome codes and the contract every client must follow for each.
 *
 * Mirrors `rte/src/proto/codes.rs`: for every code, its HTTP status, what a
 * client may do next and whether the node closes the connection after it.
 * `codes.test.ts` keeps this table complete against the generated schema enum.
 */

/** RTE wire codes (`enum Code` in `rte.fbs`), plus SDK-local codes from 1000 up. */
export const Code = {
  Ok: 0,

  BadFrame: 100,
  InvalidArgument: 101,
  UnsupportedVersion: 102,
  UnsupportedFrame: 103,
  UnsupportedFeature: 104,
  FrameTooLarge: 105,
  HelloRequired: 106,

  AuthRequired: 200,
  AuthInvalid: 201,
  AuthExpired: 202,
  Forbidden: 203,
  Suspended: 204,
  ResumeRejected: 205,
  Replaced: 206,

  RateLimited: 300,
  QuotaExceeded: 301,
  PayloadTooLarge: 302,
  Backpressure: 303,

  InvalidTopic: 400,
  ClassMismatch: 401,
  InvalidCursor: 402,
  IdempotencyConflict: 403,
  IdempotencyKeyRequired: 404,

  Internal: 500,
  Unavailable: 501,
  Draining: 502,
  Overloaded: 503,
  Timeout: 504,

  // Raised by the SDK itself, never sent by a node.
  ClientClosed: 1000,
  QueueFull: 1001,
  TransportUnavailable: 1002,
  Aborted: 1003,
  NotConnected: 1004,
  /** A token for another segment than the one asserted or connected to. */
  SegmentMismatch: 1005,
  /** `updateToken()` switched to another identity: subscriptions ended. */
  IdentityChanged: 1006,
} as const;

export type CodeName = keyof typeof Code;
export type CodeValue = (typeof Code)[CodeName];

/** What a client is allowed to do after receiving a code. */
export type RetryClass = 'never' | 'backoff' | 'after-reauth' | 'reconnect';

export interface CodeInfo {
  readonly name: string;
  readonly httpStatus: number;
  readonly retry: RetryClass;
  /** The node closes the connection after sending this code. */
  readonly closesConnection: boolean;
}

const info = (name: string, httpStatus: number, retry: RetryClass, closesConnection: boolean): CodeInfo => ({
  name,
  httpStatus,
  retry,
  closesConnection,
});

const TABLE: ReadonlyMap<number, CodeInfo> = new Map<number, CodeInfo>([
  [Code.Ok, info('Ok', 200, 'never', false)],

  [Code.BadFrame, info('BadFrame', 400, 'never', true)],
  [Code.InvalidArgument, info('InvalidArgument', 400, 'never', false)],
  [Code.UnsupportedVersion, info('UnsupportedVersion', 400, 'never', true)],
  [Code.UnsupportedFrame, info('UnsupportedFrame', 400, 'never', false)],
  [Code.UnsupportedFeature, info('UnsupportedFeature', 400, 'never', false)],
  [Code.FrameTooLarge, info('FrameTooLarge', 413, 'never', true)],
  [Code.HelloRequired, info('HelloRequired', 400, 'never', true)],

  [Code.AuthRequired, info('AuthRequired', 401, 'after-reauth', true)],
  [Code.AuthInvalid, info('AuthInvalid', 401, 'never', true)],
  [Code.AuthExpired, info('AuthExpired', 401, 'after-reauth', true)],
  [Code.Forbidden, info('Forbidden', 403, 'never', false)],
  [Code.Suspended, info('Suspended', 403, 'never', true)],
  [Code.ResumeRejected, info('ResumeRejected', 409, 'never', false)],
  // A newer connection for the same identity took this one's place.
  [Code.Replaced, info('Replaced', 409, 'never', true)],

  [Code.RateLimited, info('RateLimited', 429, 'backoff', false)],
  [Code.QuotaExceeded, info('QuotaExceeded', 429, 'backoff', false)],
  [Code.PayloadTooLarge, info('PayloadTooLarge', 413, 'never', false)],
  [Code.Backpressure, info('Backpressure', 503, 'backoff', true)],

  [Code.InvalidTopic, info('InvalidTopic', 400, 'never', false)],
  [Code.ClassMismatch, info('ClassMismatch', 409, 'never', false)],
  [Code.InvalidCursor, info('InvalidCursor', 400, 'never', false)],
  [Code.IdempotencyConflict, info('IdempotencyConflict', 409, 'never', false)],
  [Code.IdempotencyKeyRequired, info('IdempotencyKeyRequired', 400, 'never', false)],

  [Code.Internal, info('Internal', 500, 'backoff', false)],
  [Code.Unavailable, info('Unavailable', 503, 'backoff', true)],
  [Code.Draining, info('Draining', 503, 'reconnect', true)],
  [Code.Overloaded, info('Overloaded', 503, 'backoff', false)],
  [Code.Timeout, info('Timeout', 504, 'backoff', true)],

  [Code.ClientClosed, info('ClientClosed', 0, 'never', true)],
  [Code.QueueFull, info('QueueFull', 0, 'backoff', false)],
  [Code.TransportUnavailable, info('TransportUnavailable', 0, 'never', true)],
  [Code.Aborted, info('Aborted', 0, 'never', false)],
  [Code.NotConnected, info('NotConnected', 0, 'backoff', false)],
  [Code.SegmentMismatch, info('SegmentMismatch', 0, 'never', false)],
  [Code.IdentityChanged, info('IdentityChanged', 0, 'never', false)],
]);

/** Every RTE wire code (excludes SDK-local codes). */
export const WIRE_CODES: readonly number[] = [...TABLE.keys()].filter((c) => c < 1000);

/** The contract for a code. Unknown codes are treated as non-retryable. */
export function codeInfo(code: number): CodeInfo {
  return TABLE.get(code) ?? info(`Code${code}`, 0, 'never', false);
}

export function codeName(code: number): string {
  return codeInfo(code).name;
}

/**
 * A close with one of these codes ends the client instead of reconnecting:
 * retrying cannot succeed without a change on the caller's side.
 */
export function isFatalCloseCode(code: number): boolean {
  switch (code) {
    case Code.AuthInvalid:
    case Code.Suspended:
    case Code.Replaced:
    case Code.BadFrame:
    case Code.UnsupportedVersion:
    case Code.HelloRequired:
    case Code.FrameTooLarge:
    case Code.ClientClosed:
    case Code.TransportUnavailable:
      return true;
    default:
      return false;
  }
}
