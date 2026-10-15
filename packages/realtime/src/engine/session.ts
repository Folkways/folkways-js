import type { Logger } from '../shared/logger';
import type { Limits, TransportKind, Uuid128 } from '../transport';
import type { PublishQueue, OutboundPublish } from './publish-queue';
import type { SubscriptionRegistry } from './subscriptions';
import type { TokenManager } from './token';

/** What a session learned when it opened. */
export interface SessionInfo {
  readonly kind: TransportKind;
  readonly identity?: string;
  readonly sessionId?: Uuid128;
  readonly limits: Limits;
  readonly expiresAtMs?: number;
  readonly server?: string;
}

/** Why a session ended. */
export interface CloseInfo {
  /** RTE code from the node's `Close`, or the SDK's view of the failure. */
  readonly code: number;
  readonly reason: string;
  readonly retryAfterMs?: number;
  /** The transport failed below the protocol (no RTE `Close` was received). */
  readonly transportFailure: boolean;
  /** The failure was detected by the SDK, not reported by the node. */
  readonly local: boolean;
}

/**
 * A protocol driver over one transport. `open` resolves once the session can
 * carry traffic; afterwards `closed` resolves exactly once when it ends.
 */
export interface Session {
  readonly kind: TransportKind;
  open(signal: AbortSignal): Promise<SessionInfo>;
  readonly closed: Promise<CloseInfo>;
  readonly limits: Limits;
  sendPublishes(items: OutboundPublish[]): void;
  /** The registry changed: subscribe new entries, unsubscribe removed ones. */
  syncSubscriptions(): void;
  /** Ends the session (sends `Close` where the transport has one). */
  close(code: number, reason: string): void;
}

/** What sessions need from the engine. */
export interface SessionHost {
  readonly registry: SubscriptionRegistry;
  readonly publishes: PublishQueue;
  readonly tokens: TokenManager;
  readonly log: Logger;
  readonly requestTimeoutMs: number;
  /** A clock sample: server time `serverMs` observed at local time `localMs` (± rtt/2). */
  clockSample(serverMs: number, localMs: number, rttMs: number): void;
  /** The node accepted a refreshed token. */
  tokenRefreshed(expiresAtMs?: number): void;
  /** The node warned that the token expires soon. */
  tokenExpiring(expiresAtMs: number): void;
}
