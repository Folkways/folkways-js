# Folkways Realtime JS SDK

TypeScript client SDK for the Folkways Realtime Transport Engine (RTE v1), and example apps.

## Packages

| Package | |
| --- | --- |
| [`@folkways/realtime`](./packages/realtime) | The SDK: `new Folkways.Realtime()`, topics with stream / kv / signal events, live views, local store, WebSocket and HTTP long-poll transports; `@folkways/realtime/server` for backends |
| [`react-example`](./apps/react-example) | A chat with a typing indicator built on the SDK |

Usage guide and API: [packages/realtime](./packages/realtime#readme).

## Getting started

```bash
pnpm install
pnpm build
pnpm test
```

Then follow [apps/react-example](./apps/react-example) to run the example against a local RTE node.

## License

This project is licensed under the MIT License.
