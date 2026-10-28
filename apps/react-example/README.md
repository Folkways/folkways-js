# React example

A small chat on `chat/lobby` with a typing indicator on `typing/lobby`, built with `@folkwaysio/realtime` and React's
`useSyncExternalStore`. You sign in with a name through the [example token server](../token-server), which gives
the app a token for you.

## Before you start

In the [Folkways dashboard](https://docs.folkways.io/docs/js-sdk/prerequisites), set up a segment with:

- a signing key, which the token server uses to sign your tokens;
- two topic rules: `chat/>` with class **Durable** and operations `subscribe`, `publish`; and `typing/>` with class
  **Ephemeral** and operations `subscribe`, `signal`.

Then set up and start the token server as its [README](../token-server/README.md) explains.

## Run it

Create `apps/react-example/.env.local`:

```bash
# The node URL from your segment's Connect tab
VITE_RTE_URL=https://rte.example.com
```

Then, from the repository root:

```bash
pnpm install
pnpm --filter @folkwaysio/realtime build
pnpm --filter @folkwaysio/react-example dev
```

Open the page, sign in with a name and connect. Open a second browser window, sign in with another name and chat
between them.

The dev server forwards `/api` to the token server at `http://127.0.0.1:8787`, so the app and the token endpoint
share one origin. Set `TOKEN_SERVER_URL` in `.env.local` if it runs elsewhere.

### Use your own backend

To get tokens from your own backend instead, set its token endpoint in `.env.local`:

```bash
VITE_RTE_AUTH_URL=https://api.example.com/api/realtime-token
```

The app then skips the example sign-in and connects with that `authUrl`. Your endpoint must accept the request with
your user's session; if it is on another origin than the dev server, it must also allow CORS requests from it. See
[Issue tokens from your backend](https://docs.folkways.io/docs/js-sdk/server-tokens).

## What to look at

- `src/App.tsx`: one client, connected with `authUrl`; `topic.messages` for the message list (with sending status
  and retry), `topic.values('typing')` for who is typing, and `client.connection` for the connection state.
- `vite.config.ts`: the `/api` proxy to the token server.
- The guide [Using it with React](https://docs.folkways.io/docs/js-sdk/react) explains each part.
