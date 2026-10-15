# React example

A small chat on `chat/lobby` with a typing indicator on `typing/lobby`, built on `@folkways/realtime`.

## Run it

1. Start an RTE node (in the `rte` repo): `make dev`.
2. Mint a dev token: `make -s token SUB=alice`.
3. Here: `pnpm --filter @folkways/realtime build && pnpm --filter @folkways/react-example dev`, open the page and paste the token.

Open a second tab with a token for another identity (`SUB=bob`) to chat between them.

Optional environment variables (`.env.local`): `VITE_RTE_WS`, `VITE_RTE_HTTP`, `VITE_RTE_TOKEN`.

The token is pasted by hand only because this is a local demo. In an application, your backend mints short-lived tokens and the client passes a provider: `token: () => fetch('/api/rte-token').then((r) => r.text())`.
