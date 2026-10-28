/**
 * @folkwaysio/realtime: the client SDK for the Folkways Realtime Transport Engine.
 *
 *   import { Folkways } from '@folkwaysio/realtime';
 *   const client = new Folkways.Realtime({ url, authUrl: '/api/rte-token' });
 *   const session = await client.connect();
 *
 * Layers: api (this surface) → engine → transport.
 */
export * from './api';
export {
  type Limits,
  type TransportKind,
  type WebSocketConstructor,
  type FetchLike,
  type StreamTransport,
  type RequestTransport,
  type Store,
  type StoreCipher,
  memoryStore,
} from './engine';
export { Code, codeInfo, codeName, type CodeInfo, type RetryClass } from './shared/codes';
export { RealtimeError, isRealtimeError } from './shared/errors';
export { type Cursor, cursor, formatCursor, parseCursor, isAfter } from './shared/cursor';
export { type Logger, type LogLevel, consoleLogger, silentLogger } from './shared/logger';
export { topicError } from './shared/topic';
