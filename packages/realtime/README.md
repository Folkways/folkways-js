# @folkways/realtime

Client SDK for the Folkways Realtime Transport Engine (RTE v1). Works in browsers, Node 20+, Deno, Bun and React Native.

```bash
pnpm add @folkways/realtime
```

## Quick start

```ts
import { Folkways, isRealtimeError } from '@folkways/realtime';

const client = new Folkways.Realtime({
  url: 'https://rte.example.com',   // wss://…/v1/ws and https://…/v1/*
  authUrl: '/api/rte-token',        // your backend trades its API key for a short-lived token
});
client.connection.on('change', ({ current }) => setStatus(current));

try {
  const session = await client.connect();
  session.identity;                   // 'user:42'
  session.segment;                    // { id: 'seg_8f2c', environment: 'production' }
  session.can('publish', 'chat/45');  // true
} catch (err) {
  if (isRealtimeError(err)) showError(err.code, err.codeName, err.message); // 201, 'AuthInvalid', …
}

const room = client.topic('chat/45');
room.subscribe((e) => console.log(e.name, e.publisher, e.data), { from: { last: 50 } });
await room.publish('message', { text: 'hi' });

await client.close();
```

`await Folkways.connect(config)` does both steps in one call and resolves with the connected client (the session is on `client.session`).

## Topics, events and delivery types

A topic is a room. Every event published to it has a **name** you choose and a **delivery type**:

| delivery | What the node keeps | `publish()` resolves with | A new subscriber gets |
| --- | --- | --- | --- |
| `'stream'` (default) | Every event, in order, within the topic's window | A receipt `{ uid, cursor, id, … }` | A replay from `from`, then live events |
| `'kv'` | The latest value per key, per event name | A receipt | The current values, then changes |
| `'signal'` | Each sender's latest signal, for 5 s | Nothing; dropped while not connected | Current signals, then live ones |

```ts
const room = client.topic('chat/45');
await room.publish('message', { text: 'hi' });                        // stream
room.publish('typing', { on: true }, { delivery: 'signal' });         // signal
await room.publish('read', { upTo: msg.uid }, { delivery: 'kv' });    // kv, key = your identity
await room.publish('read', null, { delivery: 'kv', remove: true });   // delete your kv entry

room.subscribe((e) => {
  if (e.name === 'message') addMessage(e);
  if (e.name === 'typing') showTyping(e.publisher);
}, { types: ['stream', 'signal'] });
```

Type your events with an event map: `client.topic<{ message: { text: string }; typing: { on: boolean } }>('chat/45')` checks every payload and narrows `e.data` by `e.name`.

Point read receipts, edits and reactions at `msg.uid` (stable across node restarts), never at the cursor. Trust `msg.publisher`, which the node verifies, never a name in the payload.

### Live views for UIs

`topic.messages` (recent stream events, with your own sends shown at once) and `topic.values(event)` (kv values by key, signals by publisher) are live views: `getSnapshot()` and `subscribe()` work as is with React's `useSyncExternalStore`, Svelte stores or Vue refs. So do `client.connection` and `client.sessionView`.

```tsx
const messages = useSyncExternalStore(room.messages.subscribe, room.messages.getSnapshot);
const reads = useSyncExternalStore(room.values('read').subscribe, room.values('read').getSnapshot);
// m.status: 'pending' → 'sent', or 'failed' with m.retry()
```

### Many topics at once

```ts
const inbox = client.topic(['chat/a', 'chat/b', 'chat/c']);
const sub = inbox.subscribe(notify, { types: ['stream'] }); // messages only, no keystrokes
const { ok, failed } = await sub.ready;                      // settles once every topic answered
inbox.add('chat/d');                                         // joins the live subscription
inbox.remove('chat/a');
```

Subscribe frames are sent together, in packets of up to 64. Within a topic events arrive in order; there is no order across topics.

### One listener over everything

```ts
const off = client.on({ topic: 'chat/*', event: 'typing', self: false }, (e) => showTyping(e.topic, e.publisher));
client.on({ topic: '$user/*', event: 'invite' }, (e) => openDm(e.data.topic));
```

`client.on` observes events the client already receives (its subscriptions and its own `$user/{identity}` topic). It never subscribes and never holds back delivery.

### Presence and personal topics

The node keeps presence and personal topics, read with the same `topic()` method: `$presence/{topic}`, `$online/{identity}` and `$user/{identity}`. Your own `$user` topic is followed automatically once the node offers it.

```ts
client.topic('$presence/chat/45').subscribe();
const here = client.topic('$presence/chat/45').values(); // Map<'user:7#s1', …>
```

> Several event types per topic, presence, member lists and personal topics need the matching RTE release. On an older node, one topic carries one delivery type (a mismatch fails with `ClassMismatch`) and events have no names.

### Shared topic definitions

Define a product's events once and share the file between web, mobile, backend and CI:

```ts
import { defineTopic } from '@folkways/realtime';

export const chatRoom = defineTopic<ChatEvents>()('chat/{room}', {
  events: { message: 'stream', typing: 'signal', read: { delivery: 'kv', keyIsPublisher: true } },
  access: 'members',
  presence: true,
});

const room = chatRoom.open(client, { room: '45' });
room.publish('typing', { on: true });  // delivery comes from the definition
chatRoom.rule();                       // the topic rule for the portal or CI
chatRoom.memberOps();                  // ['subscribe', 'publish', 'signal', 'set', 'presence']
```

## Connection, tokens and errors

- `client.connection.state`: `idle`, `connecting`, `connected`, `reconnecting`, `offline` (down for `offlineAfterMs`, default 2 min), `failed` (a fatal error; call `connect()` again, usually after `updateToken()`) and `closed`.
- Reconnects with backoff and jitter (0.5 s to 30 s); the browser coming online or the tab becoming visible skips the wait. Falls back from WebSocket to HTTP long-poll after two failed opens, and moves back when WebSocket works again.
- `token` takes a string or a provider `({ reason }) => token`, with `reason` `'initial'`, `'expiring'` or `'rejected'`; `authUrl` is the shorthand. Tokens are refreshed before they expire and never logged.
- `client.updateToken(token)`: the same identity keeps its subscriptions; another identity reconnects, ends every subscription with `IdentityChanged` and wipes the old identity's local data.
- `connect({ segment })` fails locally with `SegmentMismatch` when the token is for another segment.
- Every failure is a `RealtimeError { code, codeName, retry, retryAfterMs, topic, local }`; codes are in `Code`.

## Guarantees

- Each stream or kv publish carries one idempotency key, reused on every retry: it is applied at most once.
- While reconnecting, publishes queue (up to 1000) and go out after the reconnect. While `offline` they fail with `NotConnected`, unless a persistent store keeps them in the outbox.
- Subscriptions resume after the last processed cursor; history beyond the node's window arrives as a `gap` event.

## Local store

```ts
import { indexedDbStore } from '@folkways/realtime/stores/indexeddb';
const client = new Folkways.Realtime({ url, authUrl, store: indexedDbStore() });
```

The store keeps cursors, and with a persistent adapter also an outbox (sends survive a reload or an outage of up to 10 minutes, without duplicates) and a cache of recent messages and values, so a reload renders at once (`fromCache: true` until the node confirms). Data is kept per segment and identity. `client.close({ clear: true })` wipes it; `cipher` encrypts it at rest.

| Adapter | Import |
| --- | --- |
| `memoryStore()` (default) | `@folkways/realtime` |
| `indexedDbStore(name?)` (browsers) | `@folkways/realtime/stores/indexeddb` |
| `asyncStorageStore(AsyncStorage)` (React Native) | `@folkways/realtime/stores/async-storage` |
| `fileStore(dir)` (Node) | `@folkways/realtime/stores/file` |

The `Store` interface is five methods (`get`, `set`, `delete`, `keys(prefix)`, `clear(prefix)`), so you can bring your own.

## Server side

```ts
import { Folkways } from '@folkways/realtime/server';

const rte = new Folkways.Rest({ apiKey: process.env.RTE_SECRET_KEY!, url: 'https://rte.example.com' });
const { token } = await rte.createToken({ identity: 'user:42', capabilities: [{ topics: 'chat/*', ops: ['subscribe', 'publish', 'signal'] }] });
await rte.publish('chat/45', 'notice', { text: 'Payment received' });
```

`Rest` refuses to run with a secret key in a browser.

## Endpoints for a local dev node

```ts
new Folkways.Realtime({
  endpoints: { websocket: 'ws://127.0.0.1:8080/v1/ws', http: 'http://127.0.0.1:3000' },
  token: devToken, // `make -s token SUB=alice` in the rte repo
});
```

Node 22+ has a global `WebSocket`. On Node 20 pass one: `webSocket: (await import('ws')).WebSocket`.

### Script tag

```html
<script src="https://unpkg.com/@folkways/realtime/dist/index.global.js"></script>
<script>
  const client = new Folkways.Realtime({ url: 'https://rte.example.com', authUrl: '/api/rte-token' });
  client.connect().then((session) => { /* … */ });
</script>
```

Every option is documented on `RealtimeOptions` and ships in the type definitions.

## Development

```bash
pnpm build                 # ESM, CJS, d.ts and IIFE into dist/
pnpm test                  # unit + engine tests (integration tests skip without a node)
pnpm lint                  # tsc on sources and tests
RTE_BIN=../../../rte/target/debug/realtime-transport-engine pnpm test   # also run against a real node
RTE_PROTO=../../../rte/proto/rte.fbs FLATC=flatc pnpm proto             # regenerate wire bindings (flatc 24.3.25)
```

Layout: `src/api` (public surface) → `src/engine` (sessions, state, store) → `src/transport` (WebSocket/HTTP and the FlatBuffers codec) → `src/shared`; `src/stores` and `src/server` are separate entry points. A test enforces the direction of imports.
