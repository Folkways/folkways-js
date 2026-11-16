# React example

A chat on `chat/lobby` built with `@folkwaysio/realtime` and React's `useSyncExternalStore`, styled with the Folkways
"Unbroken" design tokens. You sign in with a name through the [example token server](../token-server), which signs a
token for you.

- **Messages** on `chat/lobby` (Durable): the last 50 on join, sending status and retry.
- **Typing** on `typing/lobby` (Ephemeral signals).
- **Who's here** from the node's `$presence/chat/lobby`: one person per name, with how many connections they have.
- **Your connections** from `$online/user:<name>`: sign in with the same name in another tab or browser and you are
  one person connected in two places.

Every tab is its own sign-in (kept in `sessionStorage`), so one browser can hold several people, or the same person
several times.

## Before you start

In the [Folkways dashboard](https://docs.folkways.io/docs/js-sdk/prerequisites), set up a segment with:

- a signing key, which the token server uses to sign your tokens;
- two topic rules: `chat/>` with class **Durable** and presence turned on; and `typing/>` with class **Ephemeral**.

Then set up the token server as its [README](../token-server/README.md) explains.

## Run it

The app has no settings of its own. Your segment's details (node URL, segment ID, signing key) go only in the token
server's `apps/token-server/.env`; the app asks the token server which node to connect to.

From the repository root, start the SDK, the token server and the app together:

```bash
pnpm install
pnpm dev
```

Open the page and sign in with a name. Open a second tab and sign in with another name, or the same one, and chat.

The dev server forwards `/api` to the token server at `http://127.0.0.1:8787`, so the app and the token endpoint
share one origin. Set `TOKEN_SERVER_URL` in `apps/react-example/.env.local` only if the token server runs elsewhere.

## What to look at

| File | What it shows |
| --- | --- |
| `src/App.tsx` | Sign-in, and one client connected with a `token` function that asks the token server |
| `src/Chat.tsx` | `topic.messages`, `topic.values()` for typing, presence and your connections, and `client.connection` |
| `src/api.ts` | The calls to the token server: where to connect, sign-in and tokens |
| `src/styles/tokens.css` | The design tokens, copied from folkways.io |
| `vite.config.ts` | The `/api` proxy to the token server |

The guide [Using it with React](https://docs.folkways.io/docs/js-sdk/react) explains each part.
