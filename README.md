# Folkways Realtime for JavaScript

Live chat, locations, typing indicators and feeds for web, mobile and Node.js apps.
`@folkwaysio/realtime` connects your app to Folkways and keeps it in sync: it picks a transport, reconnects after
network drops, refreshes tokens and resumes every subscription where it left off.

**[Documentation](https://docs.folkways.io/docs/js-sdk)** ·
[Quick start](https://docs.folkways.io/docs/js-sdk/quick-start) ·
[API reference](https://docs.folkways.io/docs/js-sdk/reference/client-options) ·
[Example app](https://github.com/Folkways/folkways-js/tree/main/apps/react-example)

## Features

- **Topics with three delivery types:** ordered, replayable `stream` events; shared `kv` state; short-lived `signal`s.
- **Resilient by default:** reconnects with backoff, resumes from the last event handled, never delivers twice.
- **Safe publishing:** every publish is applied at most once, retried when it can be, and queued while offline.
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
  url: 'https://rte.example.com',  // your node URL, from the segment's Connect tab
  authUrl: '/api/realtime-token',  // your backend's token endpoint
});
await client.connect();

const lobby = client.topic<{ message: { text: string } }>('chat/lobby');

// Receive the last 20 messages, then every new one.
lobby.subscribe((msg) => console.log(`${msg.publisher}: ${msg.data.text}`), { from: { last: 20 } });

// Send one. It resolves once Folkways has stored it.
await lobby.publish('message', { text: 'Hello!' });
```

## Delivery types

| Type | What Folkways keeps | Use it for |
| --- | --- | --- |
| `stream` (default) | Every event, in order, replayable | Chat, feeds, orders |
| `kv` | The latest value per key | Locations, read receipts, status, scores |
| `signal` | Each sender's latest signal, for 5 seconds | Typing indicators, live cursors |

```ts
await client.topic('rides/42/location').publish('location', { lat: 59.43, lng: 24.75 }, { delivery: 'kv' });
client.topic('typing/lobby').publish('typing', { on: true }, { delivery: 'signal' });
```

Read more in [Topics and events](https://docs.folkways.io/docs/js-sdk/topics-and-events).

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
