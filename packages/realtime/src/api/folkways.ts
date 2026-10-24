import { Realtime } from './realtime';
import type { RealtimeOptions } from './options';
import type { ConnectOptions } from './types';
import { VERSION } from './version';

/**
 * Shorthand for `new Folkways.Realtime(options)` then `connect()`: resolves
 * with the connected client (the session is on `client.session`). On
 * failure the client is closed and the error rethrown.
 */
export async function connect(options: RealtimeOptions & ConnectOptions): Promise<Realtime> {
  const client = new Realtime(options);
  try {
    await client.connect({ segment: options.segment });
    return client;
  } catch (err) {
    await client.close();
    throw err;
  }
}

/** The SDK entry point: `new Folkways.Realtime(config)` or `await Folkways.connect(config)`. */
export const Folkways = Object.freeze({ Realtime, connect, version: VERSION });
