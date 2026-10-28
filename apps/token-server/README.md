# Token server example

A small [Express](https://expressjs.com) backend that gives your signed-in users short-lived Folkways tokens. Your
app asks it for a token, it checks who is signed in and signs a token with your segment's **signing key**. The
private key stays on this server: your app and Folkways only ever see tokens.

The [React example](../react-example) uses it to sign in and connect. Copy the parts you need into your own backend.

- [How it works](#how-it-works)
- [Before you start](#before-you-start)
- [1. Create a signing key](#1-create-a-signing-key)
- [2. Store the key](#2-store-the-key)
- [3. Run the server](#3-run-the-server)
- [4. Connect the example app](#4-connect-the-example-app)
- [HTTP API](#http-api)
- [Settings](#settings)
- [Make it yours](#make-it-yours)
- [Before you deploy](#before-you-deploy)
- [Rotate or revoke a key](#rotate-or-revoke-a-key)
- [Troubleshooting](#troubleshooting)

## How it works

```text
 Folkways dashboard                    This server                          Folkways node
 ──────────────────                    ───────────                          ─────────────
 Signing keys tab ── private key ───▶  secrets/ (never leaves)
 (keeps the public half)

 Your app ── POST /api/realtime-token ─▶ who is signed in?
            (session cookie)             sign { segment, user, permissions, expiry }
          ◀──────── { token } ─────────

 Your app ── connect with the token ──────────────────────────────────────▶ checks the signature
                                                                            with the public half
```

1. You create a signing key in the Folkways dashboard and save its private half on this server.
2. Your app's client is set up with `authUrl: '/api/realtime-token'`. When it connects, it asks this server for a
   token. The server signs one for the signed-in user. Signing happens in this process and needs no call to
   Folkways.
3. The client connects with that token. The Folkways node checks the signature with the key's public half and lets
   the user do what the token allows.

Tokens are short-lived (10 minutes here; Folkways accepts at most 15) and reusable until they expire. The SDK keeps
the current token for every connect and reconnect. It asks this server for a new one about a minute before the
token expires (`reason: "expiring"`), or when the node refuses it (`reason: "rejected"`). Your app never handles a
token itself.

## Before you start

- Node.js 20.12 or newer and pnpm, as the [development guide](../../docs/DEVELOPMENT.md#prerequisites) describes.
- A segment in the [Folkways dashboard](https://docs.folkways.io/docs/js-sdk/prerequisites). For the example app,
  give it two topic rules:
  - `chat/>`, class **Durable**, operations `subscribe` and `publish`;
  - `typing/>`, class **Ephemeral**, operations `subscribe` and `signal`.

## 1. Create a signing key

1. In the dashboard, open the segment's **Signing keys** tab and choose **Add key**.
2. Choose **Generate a key pair** and **Ed25519**, and give the key an ID, such as `backend-2026-10`.
3. The dashboard shows the private key **once**. Copy it now. Folkways keeps only the public half and can't show the
   private key again.

Note the **Key ID**, and the **Segment ID** and **node URL** from the segment's **Connect** tab.

You can also create the key pair yourself and upload only the public key. A **shared secret (HS256)** works too, for
trying things out. See [Signing keys](https://docs.folkways.io/docs/js-sdk/authentication#signing-keys).

## 2. Store the key

From the repository root:

```bash
cd apps/token-server
cp .env.example .env
```

Save the private key in `secrets/`. Git ignores everything in that folder except its `.gitignore`:

```bash
cat > secrets/signing-key.pem    # paste the key, press Enter, then Ctrl-D
chmod 600 secrets/signing-key.pem
```

Then fill in `.env`, which git ignores too:

```bash
RTE_URL=https://rte.example.com
RTE_SEGMENT_ID=5faeecf0-db6e-41a3-9448-afe1b096a6d2
RTE_KEY_ID=backend-2026-10
RTE_PRIVATE_KEY_FILE=./secrets/signing-key.pem
```

The server reads the private key from one of three settings. Set exactly one:

| Setting | Holds | Use it when |
| --- | --- | --- |
| `RTE_PRIVATE_KEY_FILE` | The path of the private key file (PKCS#8 PEM, Ed25519 or P-256) | The key is a file on the server or a mounted secret |
| `RTE_PRIVATE_KEY` | The PEM itself. Newlines may be written as `\n` | Your host injects secrets as environment variables |
| `RTE_SECRET` | The shared secret of an HS256 key | You use a shared secret |

> [!WARNING]
> The private key lets anyone sign tokens for any user of your segment. Keep it out of your repository, your app's
> code and your logs. In production, keep it in your platform's secret manager. If it leaks,
> [replace it](#rotate-or-revoke-a-key).

## 3. Run the server

From the repository root:

```bash
pnpm install
pnpm --filter @folkwaysio/realtime build
pnpm --filter @folkwaysio/token-server dev
```

```text
token-server: listening on http://127.0.0.1:8787
  segment 5faeecf0-db6e-41a3-9448-afe1b096a6d2, key backend-2026-10 from ./secrets/signing-key.pem, tokens last 600 s
```

Before it listens, the server signs one token. If a setting is missing or the key can't sign, it says what is wrong
and exits. It restarts when you change its code; restart it yourself after you edit `.env`.

Try it with curl:

```bash
curl -c cookies.txt -H 'content-type: application/json' -d '{"name":"alice"}' http://127.0.0.1:8787/api/session
```

```bash
curl -b cookies.txt -X POST http://127.0.0.1:8787/api/realtime-token
```

The second command answers `{ "token": "eyJ…", "expiresAt": 1793191155000 }`.

For production, build it and run the output:

```bash
pnpm --filter @folkwaysio/token-server build
cd apps/token-server && NODE_ENV=production node dist/server.js
```

## 4. Connect the example app

Create `apps/react-example/.env.local` with the node URL:

```bash
VITE_RTE_URL=https://rte.example.com
```

With the token server running, start the app from the repository root:

```bash
pnpm --filter @folkwaysio/react-example dev
```

Open the page, sign in with any name and you are in `chat/lobby`. Open a second browser window, sign in with
another name and chat between the two.

The app's dev server forwards `/api` to this server, so the app, the sign-in cookie and the token endpoint share one
origin and no CORS is needed. If the token server runs somewhere else, set `TOKEN_SERVER_URL` in the app's
`.env.local` (default `http://127.0.0.1:8787`).

`pnpm dev` at the repository root starts the SDK in watch mode, the example app and this server together.

## HTTP API

| Method and path | Request | Response |
| --- | --- | --- |
| `GET /healthz` | | `{ "ok": true }` |
| `GET /api/session` | | `{ "identity": "user:alice" }`, or `{ "identity": null }` when nobody is signed in |
| `POST /api/session` | `{ "name": "alice" }`: 1 to 32 letters, digits, `.`, `-` or `_` | `{ "identity": "user:alice" }` and the session cookie; `400` for a bad name |
| `DELETE /api/session` | | `204`; clears the cookie |
| `POST /api/realtime-token` | `{ "reason": "initial" \| "expiring" \| "rejected" }` and the session cookie | `{ "token": "…", "expiresAt": <Unix ms> }`; `401` when nobody is signed in |

The token endpoint follows the contract of the SDK's `authUrl` option. The SDK sends `POST` with a JSON body and
your page's cookies, and reads the `token` field. Any status other than 2xx means "not signed in". Responses carry
`Cache-Control: no-store`, so no proxy or browser cache keeps a token.

## Settings

The server reads these from the environment. When there is a `.env` file in its folder, it loads that first.

| Variable | Default | Meaning |
| --- | --- | --- |
| `RTE_URL` | required | The node URL, from the segment's **Connect** tab |
| `RTE_SEGMENT_ID` | required | The segment ID (a UUID), from the **Connect** tab |
| `RTE_KEY_ID` | required | The signing key's ID (`kid`), from the **Signing keys** tab |
| `RTE_PRIVATE_KEY_FILE`, `RTE_PRIVATE_KEY` or `RTE_SECRET` | one required | The key's private half; see [Store the key](#2-store-the-key) |
| `RTE_TOKEN_TTL_SECONDS` | `600` | How long each token lives, from 60 to 900 seconds |
| `SESSION_SECRET` | random | Signs the sign-in cookie. At least 32 characters. Unset, a random one is made at startup, so restarting signs everyone out |
| `HOST` | `127.0.0.1` | Address to listen on. Use `0.0.0.0` in a container |
| `PORT` | `8787` | Port to listen on |
| `NODE_ENV` | | `production` marks the sign-in cookie `Secure` (HTTPS only) |

## Make it yours

The code is short, and each part is one file in `src/`:

| File | What it does | What to change |
| --- | --- | --- |
| `config.ts` | Reads and checks the settings and the private key | Read the key from your secret manager instead, if you like |
| `session.ts` | A stand-in sign-in: anyone can sign in with a name | Replace it with your app's login |
| `permissions.ts` | What each user's token allows | Grant each user only what they need |
| `app.ts` | The routes, and the token endpoint | Use your user IDs as identities |
| `server.ts` | Starts the server and checks the key | |

The token endpoint is the part to keep. In your backend it is a few lines behind your own login:

```ts
import { Folkways } from '@folkwaysio/realtime/server';

const rte = new Folkways.Rest({
  url: process.env.RTE_URL!,
  segment: process.env.RTE_SEGMENT_ID!,
  signingKey: { kid: process.env.RTE_KEY_ID!, privateKey: process.env.RTE_PRIVATE_KEY! },
});

app.post('/api/realtime-token', requireLogin, async (req, res) => {
  const { token, expiresAt } = await rte.createToken({
    identity: `user:${req.user.id}`,
    capabilities: [{ topics: `chat/team-${req.user.teamId}/>`, ops: ['subscribe', 'publish'] }],
  });
  res.set('cache-control', 'no-store').json({ token, expiresAt });
});
```

- **Identity.** Use a stable ID from your user database, such as `user:42`, not a name the user can change. Other
  users see it as the publisher of every event this user sends.
- **Permissions.** A token can only narrow what the segment's topic rules allow. Grant each user the topics they
  belong to, for example `chat/team-7/>` instead of `chat/>`.
- **Same origin.** Serve the token endpoint from your app's origin, or proxy it there as the example app does. Then
  the browser sends your session cookie with the SDK's request, and `SameSite` cookies protect it from other sites.
- **Publishing from your backend.** The same `rte` client publishes events over HTTP, such as a notice after a
  payment. See [Issue tokens from your backend](https://docs.folkways.io/docs/js-sdk/server-tokens).

## Before you deploy

- [ ] The example sign-in is replaced by your app's login, and the reminder about it in `server.ts` is gone.
- [ ] The private key is in your secret manager, readable only by this server, and never logged. This server never
      logs keys or tokens; it logs the identity and expiry of each token it issues.
- [ ] Everything is served over HTTPS, and `NODE_ENV=production` is set so cookies are `Secure`.
- [ ] `SESSION_SECRET` is set, or your own sessions are used.
- [ ] Each user gets only the permissions they need.
- [ ] The token endpoint is rate limited per user, like your other authenticated endpoints.
- [ ] Tokens stay short-lived. The default 10 minutes is a good choice.

## Rotate or revoke a key

To rotate a key without downtime:

1. In the dashboard, add a new signing key with a new ID. Both keys work side by side.
2. Save the new private key, set `RTE_KEY_ID` to the new ID and restart the server.
3. After 15 minutes, the longest a token can live, delete the old key in the dashboard.

If a private key leaks, add a new key, switch the server to it, and delete the leaked key right away. Deleting a key
closes every connection still using a token signed with it.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `RTE_… is not set` when the server starts | Fill in `.env` from `.env.example`, then restart the server |
| `this is the public key` | You saved the public half. Use the private key the dashboard showed when the key was created |
| `convert the key to PKCS#8 first` | Your P-256 key is in the older EC format. Convert it: `openssl pkcs8 -topk8 -nocrypt -in key.ec.pem -out key.pem` |
| `not an Ed25519 or P-256 private key` | The file is not a private key in PKCS#8 PEM. Check that you copied all of it, including the `BEGIN` and `END` lines |
| The app says `Can't reach the token server` | Start the token server, or set `TOKEN_SERVER_URL` in the app's `.env.local` |
| The app says `authUrl answered HTTP 401` | Nobody is signed in, or the browser didn't send the session cookie because the token endpoint is on another origin |
| The connection fails with `AuthInvalid` | `RTE_SEGMENT_ID` or `RTE_KEY_ID` doesn't match the key in the dashboard, or the key was deleted. Check that the server's clock is right |
| `Forbidden` when subscribing or publishing | The topic needs a rule that allows the operation, and the token's permissions (`src/permissions.ts`) must include it |

More in [Errors and troubleshooting](https://docs.folkways.io/docs/js-sdk/errors).
