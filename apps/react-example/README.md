# React example

A small chat on `chat/lobby` with a typing indicator on `typing/lobby`, built with `@folkways/realtime` and React's
`useSyncExternalStore`.

## Before you start

In the [Folkways dashboard](https://docs.folkways.io/docs/js-sdk/prerequisites), set up a segment with:

- a signing key, used by your backend to issue tokens;
- two topic rules: `chat/>` with class **Durable** and operations `subscribe`, `publish`; and `typing/>` with class
  **Ephemeral** and operations `subscribe`, `signal`.

Your backend issues each user a token for these topics. See
[Issue tokens from your backend](https://docs.folkways.io/docs/js-sdk/server-tokens).

## Run it

Create `apps/react-example/.env.local`:

```bash
# The node URL from your segment's Connect tab
VITE_RTE_URL=https://rte.example.com

# Optional: your backend's token endpoint. Without it, the app asks you to paste a token.
VITE_RTE_AUTH_URL=https://api.example.com/api/realtime-token
```

Then, from the repository root:

```bash
pnpm install
pnpm --filter @folkways/realtime build
pnpm --filter @folkways/react-example dev
```

Open the page and connect. Open a second browser window signed in as another user to chat between them.

If your token endpoint is on another origin than the dev server, it must allow CORS requests from it.

## What to look at

- `src/App.tsx`: one client, `topic.messages` for the message list (with sending status and retry),
  `topic.values('typing')` for who is typing, and `client.connection` for the connection state.
- The guide [Using it with React](https://docs.folkways.io/docs/js-sdk/react) explains each part.
