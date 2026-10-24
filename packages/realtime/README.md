# @folkways/realtime

Client SDK for the Folkways Realtime Transport Engine (RTE v1). Works in browsers, Node 20+, Deno, Bun and React Native.

```bash
pnpm add @folkways/realtime
```

## Quick start

```ts
import { Folkways } from '@folkways/realtime';

const client = await Folkways.connect({
  url: 'https://rte.example.com',                          // wss://…/v1/ws and https://…/v1/*
  token: () => fetch('/api/rte-token').then((r) => r.text()), // called again to refresh
});

// Durable topic: ordered, replayable
const lobby = client.topic('chat/lobby');
const sub = lobby.subscribe<{ text: string }>((msg) => {
  console.log(msg.publisher, msg.data.text, msg.id);
}, { from: { last: 50 } });
await sub.ready;
const receipt = await lobby.publish({ text: 'hello' }); // { id, cursor, duplicate, … }

// LastValue topic: latest value per key
const ride = client.topic('rides/42/location');
await ride.set('driver-7', { lat: 59.43, lng: 24.75 }, { ttlMs: 30_000 });
const view = ride.subscribe();
view.on('snapshot', () => render(view.values));          // Map<key, Message>
view.on('message', () => render(view.values));
await ride.delete('driver-7');

// Ephemeral topic: fire-and-forget signals
client.topic('typing/lobby').signal({ typing: true });

await client.close();
```

## What it does for you

- Picks a transport (WebSocket, falling back to HTTP long-poll) and keeps it alive: heartbeats, reconnects with backoff and jitter, `retry_after_ms`, `Draining`, `Backpressure`.
- Refreshes tokens on `TokenExpiring` with `Reauth` (WebSocket) or before expiry (HTTP).
- Resubscribes after every reconnect from the last cursor, reports `Gap`s, drops duplicates by `(epoch, seq)`.
- Gives every publish an idempotency key and resends in-flight publishes after a reconnect, so each is applied at most once; retries `RateLimited`; queues publishes made while offline.
- Runs handlers in order, one at a time; persists the processed cursor (`cursorStore`, e.g. `localStorageCursorStore()`).

## API

| | |
| --- | --- |
| `Folkways.connect(options)` | Resolves with a connected `RealtimeClient` |
| `Folkways.createClient(options)` | A client that connects in the background |
| `client.topic(name)` | `Topic`: `publish`, `set`, `delete`, `signal`, `subscribe` |
| `client.on(event, fn)` | `state`, `connected`, `disconnected`, `reconnecting`, `error`, `tokenExpiring`, `tokenRefreshed` |
| `subscription` | `ready`, `status`, `cursor`, `values`, `deliveryClass`, events `message` `snapshot` `gap` `error` `ended`, `unsubscribe()`, `for await` |
| errors | `RealtimeError { code, codeName, retry, retryAfterMs, topic, local }`; codes in `Code` |

Every option is documented on `ClientOptions` ([src/api/options.ts](./src/api/options.ts)) and ships in the type definitions.

### Endpoints for a local dev node

```ts
Folkways.connect({
  endpoints: { websocket: 'ws://127.0.0.1:8080/v1/ws', http: 'http://127.0.0.1:3000' },
  token: devToken, // `make -s token SUB=alice` in the rte repo
});
```

### Node 20

Node 22+ has a global `WebSocket`. On Node 20 pass one: `webSocket: (await import('ws')).WebSocket`.

### Script tag

```html
<script src="https://unpkg.com/@folkways/realtime/dist/index.global.js"></script>
<script>
  Folkways.connect({ url: 'https://rte.example.com', token }).then((client) => { /* … */ });
</script>
```

## Development

```bash
pnpm build                 # ESM, CJS, d.ts and IIFE into dist/
pnpm test                  # unit + engine tests (integration tests skip without a node)
pnpm lint                  # tsc on sources and tests
RTE_BIN=../../../rte/target/debug/realtime-transport-engine pnpm test   # also run against a real node
RTE_PROTO=../../../rte/proto/rte.fbs FLATC=flatc pnpm proto             # regenerate wire bindings (flatc 24.3.25)
```

Layout: `src/api` (layer 1, public surface) → `src/engine` (layer 2, sessions and state) → `src/transport` (layer 3, WebSocket/HTTP and the FlatBuffers codec) → `src/shared`. A test enforces the direction of imports.
