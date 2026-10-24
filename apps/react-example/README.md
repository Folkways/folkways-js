# React example

A small chat on `chat/lobby` with a typing indicator on `typing/lobby`, built on `@folkways/realtime`.

## Run it

1. Start an RTE node (in the `rte` repo): `make dev`.
2. Mint a dev token: `make -s token SUB=alice`.
3. Here: `pnpm --filter @folkways/realtime build && pnpm --filter @folkways/react-example dev`, open the page and paste the token.

Open a second tab with a token for another identity (`SUB=bob`) to chat between them.

Optional environment variables (`.env.local`): `VITE_RTE_WS`, `VITE_RTE_HTTP`, `VITE_RTE_TOKEN`.

The token is pasted by hand only because this is a local demo. In an application, your backend mints short-lived tokens (see `Folkways.Rest` in `@folkways/realtime/server`) and the client passes `authUrl: '/api/rte-token'`.

Messages and typing use two topics because a local node before the ADR-001 release carries one delivery type per topic. With it, both are events of one room: `room.publish('typing', { on: true }, { delivery: 'signal' })`.
