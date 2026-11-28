# Folkways Realtime for JavaScript

Live chat, locations, typing indicators and feeds for web, mobile and Node.js apps.
`@folkwaysio/realtime` connects your app to Folkways and keeps it in sync: it picks a transport, reconnects after
network drops, refreshes tokens and restores subscriptions from their saved positions when history is available.

**[Documentation](https://docs.folkways.io/docs/js-sdk)** ·
[Quick start](https://docs.folkways.io/docs/js-sdk/quick-start) ·
[API reference](https://docs.folkways.io/docs/js-sdk/reference/client-options) ·
[Example app](https://github.com/Folkways/folkways-js/tree/main/apps/react-example)

## Features

- **Three delivery types on one topic:** ordered, replayable `stream` events; shared `kv` state; short-lived `signal`s.
- **Reconnect and resume:** reconnects with backoff, replays retained stream events and refreshes current state. Reports gaps when history is unavailable.
- **Retry-aware publishing:** queues stream and KV publishes within configured limits and reuses idempotency keys on retries.
- **WebSocket with HTTP fallback:** switches to long-polling where WebSockets are blocked, and back.
- **UI-ready live views:** message lists and current values that plug into React, Svelte or Vue.
- **Typed:** written in TypeScript, with event maps that type every payload.
- **Runs everywhere:** browsers, React Native, Node.js 20+, Deno and Bun. One small dependency.

## Install

```bash
npm install @folkwaysio/realtime
```

## Quick start

You need a segment set up in the Folkways dashboard and a backend endpoint that issues tokens for your signed-in
users. [Set up the dashboard](https://docs.folkways.io/docs/js-sdk/prerequisites) and
[issue tokens from your backend](https://docs.folkways.io/docs/js-sdk/server-tokens) explain both, and the
[example token server](https://github.com/Folkways/folkways-js/tree/main/apps/token-server) is one you can run.

```ts
import { Folkways } from '@folkwaysio/realtime';

const client = new Folkways.Realtime({
  url: 'https://realtime.example.com',  // your node URL, from the segment's Connect tab
  authUrl: '/api/realtime-token',  // your backend's token endpoint
});
await client.connect();

const lobby = client.topic<{ message: { text: string } }>('chat/lobby');

// Receive the last 20 messages, then every new one.
lobby.subscribe((msg) => console.log(`${msg.publisher}: ${msg.data.text}`), { from: { last: 20 } });

// Send one. The receipt confirms the level of acknowledgement reached.
await lobby.publish('message', { text: 'Hello!' });
```

## Delivery types

| Type | What Folkways keeps | Use it for |
| --- | --- | --- |
| `stream` (default) | Ordered events within the configured retention limits | Chat, feeds, orders |
| `kv` | Latest value per event name and key | Locations, read receipts, status, scores |
| `signal` | Latest short-lived signal per event name and publisher | Typing indicators, live cursors |

One topic can carry all three types. Configure a rule matching `rooms/*` in the dashboard with `message` (Stream),
`read` (KV) and `typing` (Signal), and grant the user the corresponding operations and subscription access.

```ts
const room = client.topic('rooms/42');
const sub = room.subscribe({ from: { last: 20 } });
await sub.ready;

const receipt = await room.publish('message', { text: 'Hello!' });
if (receipt.uid) {
  await room.publish('read', { messageUid: receipt.uid }, { delivery: 'kv' });
}
void room.publish('typing', { on: true }, { delivery: 'signal', ttlMs: 3_000 });
```

`room.messages` exposes the stream message view; `room.values('read')` and `room.values('typing')` expose current state.
In mixed-type topics, only stream events receive stream sequence numbers. Single-type KV and signal topics can also carry sequence positions. Use the event's `uid` for lasting references such as read receipts, rather than its cursor or display `id`. Signal events have no UID; their unnumbered IDs are best-effort display keys, not durable identifiers.

Event names must contain 1–64 UTF-8 bytes. `defineTopic().rule()` exports a JSON-ready rule with event-local `delivery`, `key_is_publisher` and `ttl_ms` options and `strict_events: true`. Paste the result into the dashboard's topic-rule editor; there are no separate event-option maps.

Read more in [Topics and events](https://docs.folkways.io/docs/js-sdk/topics-and-events).

## Delivery guarantees

- **Acknowledgements:** stream and KV publishes return a receipt. `accepted` means the node accepted the event, not that it has committed it to durable storage. When disk-backed stream storage is enabled, a crash may still lose recently accepted events.
- **Replay and retention:** stream history is bounded by the topic's retention limit and a maximum of 24 hours. Disk-backed history can survive a restart when enabled and intact; in-memory history cannot. The SDK reports a gap when the requested history is no longer available. Store business-critical records in your own durable system.
- **Idempotency:** retries reuse the same key. The node remembers keys for up to 10 minutes, with at most 10,000 entries per topic, scoped to the publisher and topic. Retries outside that window, or after the scope is lost, may apply again. A publish timeout does not establish that the event failed to reach the node.
- **Current state:** KV and signals are held in memory on the node. Subscribers receive current values, not a history of every intermediate update. KV deletions and expiry are represented by tombstones; signals expire silently. Signal lifetime defaults to five seconds unless configured by a rule or overridden by a positive publish `ttlMs`. When expiry metadata is available, the SDK estimates the remaining lifetime from the service's packet clock and does not renew a signal on repeated snapshots. Queue, network and runtime scheduling delays may affect local display time. Older services without expiry metadata use the `signalTtlMs` fallback (five seconds by default).
- **Reconnect:** the SDK resubscribes rather than restoring a server session. Stream replay is limited to retained history; applications should handle gaps and make durable side effects idempotent. Offline signals are dropped rather than queued or retried.

See [Publishing](https://docs.folkways.io/docs/js-sdk/publishing), [Subscribing](https://docs.folkways.io/docs/js-sdk/subscribing) and [Current limitations](https://docs.folkways.io/docs/js-sdk/limitations).

## Personal topics

A backend using `@folkwaysio/realtime/server` can send a stream event to `$user/{identity}` with `Rest.publish()`. The identity must be a single valid topic level (for example `user:42`). Grant the service token `publish` on the intended personal topic or a deliberately scoped pattern such as `$user/>`. The service enforces authorization; allowing the topic syntax in the SDK does not grant rights. Online and presence topics remain unavailable for backend publishing through this API.

## Entry points

| Import | Use it in |
| --- | --- |
| `@folkwaysio/realtime` | Your app: browsers, React Native, Node.js, Deno, Bun |
| `@folkwaysio/realtime/server` | Your backend only: issues tokens and publishes over HTTP |
| `@folkwaysio/realtime/stores/indexeddb` | Browsers: keep state across reloads |
| `@folkwaysio/realtime/stores/async-storage` | React Native: keep state across restarts |
| `@folkwaysio/realtime/stores/file` | Node.js: keep state in a directory |
| `@folkwaysio/realtime/iife` | A `<script>` bundle that defines a global `Folkways` |

## Documentation

The full documentation is at **[docs.folkways.io](https://docs.folkways.io)**:

- [Key concepts](https://docs.folkways.io/docs/js-sdk/concepts): segments, topics, events, identities and tokens
- [How authentication works](https://docs.folkways.io/docs/js-sdk/authentication): signing keys, publishable keys and permissions
- [Publishing](https://docs.folkways.io/docs/js-sdk/publishing) and [subscribing](https://docs.folkways.io/docs/js-sdk/subscribing)
- [Using it with React](https://docs.folkways.io/docs/js-sdk/react)
- [Errors and troubleshooting](https://docs.folkways.io/docs/js-sdk/errors)
- [API reference](https://docs.folkways.io/docs/js-sdk/reference/client-options)

## Contributing and support

- [Getting help and reporting issues](https://github.com/Folkways/folkways-js/blob/main/docs/SUPPORT.md)
- [Security policy](https://github.com/Folkways/folkways-js/blob/main/docs/SECURITY.md): report vulnerabilities to [support@folkways.io](mailto:support@folkways.io), never in a public issue
- [Contributing guide](https://github.com/Folkways/folkways-js/blob/main/docs/CONTRIBUTING.md)
- [Development guide](https://github.com/Folkways/folkways-js/blob/main/docs/DEVELOPMENT.md): set up, build, test and bundle the SDK

## License

Licensed under the [Apache License, Version 2.0](https://github.com/Folkways/folkways-js/blob/main/LICENSE). See [NOTICE](https://github.com/Folkways/folkways-js/blob/main/NOTICE) for attributions.
The license does not grant permission to use the Folkways name or logo.
