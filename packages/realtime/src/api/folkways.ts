import { RealtimeClient } from './client';
import type { ClientOptions } from './options';
import { VERSION } from './version';

/**
 * Creates a client and resolves once it is connected. Rejects on a fatal
 * error (bad token, suspended segment, no usable transport) or after
 * `connectTimeoutMs`; the rejected client is closed.
 */
export async function connect(options: ClientOptions): Promise<RealtimeClient> {
  const client = new RealtimeClient(options);
  try {
    return await client.connect();
  } catch (err) {
    await client.close();
    throw err;
  }
}

/**
 * Creates a client without waiting for it to connect. It connects in the
 * background unless `autoConnect: false`; publishes made meanwhile are queued.
 */
export function createClient(options: ClientOptions): RealtimeClient {
  const client = new RealtimeClient(options);
  if (client.autoConnect) client.connect().catch(() => {});
  return client;
}

/** The SDK entry point: `Folkways.connect({ url, token })`. */
export const Folkways = Object.freeze({ connect, createClient, version: VERSION });
