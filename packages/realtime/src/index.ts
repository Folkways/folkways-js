/**
 * @folkways/realtime: the client SDK for the Folkways Realtime Transport Engine.
 *
 *   import { Folkways } from '@folkways/realtime';
 *   const client = await Folkways.connect({ url, token });
 *
 * Layers (see docs/ARCHITECTURE.md): api (this surface) → engine → transport.
 */
export * from './api';
export {
  type ConnectionState,
  type CursorStore,
  type Limits,
  type ReconnectInfo,
  type TokenProvider,
  type TokenReason,
  type TokenSource,
  type TransportKind,
  type WebSocketConstructor,
  type FetchLike,
  type StreamTransport,
  type RequestTransport,
  localStorageCursorStore,
  memoryCursorStore,
} from './engine';
export { Code, codeInfo, codeName, type CodeInfo, type RetryClass } from './shared/codes';
export { RealtimeError, isRealtimeError } from './shared/errors';
export { type Cursor, cursor, formatCursor, parseCursor, isAfter } from './shared/cursor';
export { type Logger, type LogLevel, consoleLogger, silentLogger } from './shared/logger';
export { topicError } from './shared/topic';
