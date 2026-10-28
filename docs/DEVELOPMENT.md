# Development guide

How to set up this repository, build and bundle the SDK, run the tests and try your changes.

- [Prerequisites](#prerequisites)
- [Repository layout](#repository-layout)
- [Set up](#set-up)
- [Build and bundle](#build-and-bundle)
- [Develop with watch mode](#develop-with-watch-mode)
- [Test](#test)
- [Lint and type-check](#lint-and-type-check)
- [Try your changes in the example app](#try-your-changes-in-the-example-app)
- [Use a local build in your app](#use-a-local-build-in-your-app)
- [Wire protocol bindings](#wire-protocol-bindings)
- [Changesets and releases](#changesets-and-releases)
- [Troubleshooting](#troubleshooting)

## Prerequisites

- **Node.js 20.19 or newer.** The exact version is in [`.nvmrc`](../.nvmrc): run `nvm use` if you use nvm.
- **pnpm 10.20**, the version in `package.json`. The simplest way to get it is Corepack, which ships with Node.js:

  ```bash
  corepack enable
  ```

## Repository layout

```text
packages/realtime/        the SDK, published as @folkways/realtime
  src/api/                public API: Folkways.Realtime, topics, subscriptions, live views
  src/engine/             sessions, reconnects, tokens, subscriptions, outbox, local store
  src/transport/          WebSocket and HTTP transports, FlatBuffers codec
  src/shared/             codes, errors, cursors, logger, topic names
  src/server/             @folkways/realtime/server: Rest
  src/stores/             persistent stores, one entry point each
  test/                   engine, layer, type, entry-point and integration tests
  proto/rte.fbs           the wire schema
apps/react-example/       a chat built on the SDK
docs/                     these guides
```

Imports only go downwards: `api` → `engine` → `transport` → `shared`. A test checks this, so a wrong import fails
`pnpm test`.

## Set up

```bash
git clone https://github.com/Folkways/folkways-js.git
cd folkways-js
pnpm install
```

## Build and bundle

```bash
pnpm build                               # everything, through Turborepo
pnpm --filter @folkways/realtime build   # the SDK only
```

The SDK is bundled with [tsup](https://tsup.egoist.dev) into `packages/realtime/dist/`:

| Output | Files | Config |
| --- | --- | --- |
| ESM and CommonJS, with type declarations | `index.mjs`, `index.js`, `index.d.ts`, and the same for `server` and `stores/*` | `tsup.base.config.ts` |
| Browser script bundle (minified, global `Folkways`) | `index.global.js` | `tsup.iife.config.ts` |

Every build targets ES2020. `pnpm build` makes the build that is published, without source maps; `pnpm dev` adds
them. `pnpm clean` removes `dist/`.

## Develop with watch mode

```bash
pnpm dev
```

This rebuilds the SDK on every change (ESM and CommonJS only) and starts the example app's dev server, which picks
up the new build. To watch the SDK alone: `pnpm --filter @folkways/realtime dev`.

## Test

```bash
pnpm test                                     # builds, then runs every test
pnpm --filter @folkways/realtime test         # the SDK's tests only
pnpm --filter @folkways/realtime test:watch   # re-run on change
pnpm --filter @folkways/realtime exec vitest run test/engine.test.ts   # one file
```

The tests use [Vitest](https://vitest.dev):

| Tests | Where | What they cover |
| --- | --- | --- |
| Unit | `src/**/*.test.ts` | Codes, cursors, codec, stores, `Rest`, engine parts |
| Engine | `test/engine.test.ts` | Reconnects, resume, outbox and more, over a fake transport |
| Layers | `test/layers.test.ts` | The import direction between layers |
| Types | `test/types.test.ts` | The public types, checked by the compiler |
| Entry points | `test/entry-points.test.ts` | Errors and exports across `@folkways/realtime` and `/server` |
| Integration | `test/integration.test.ts` | The SDK against a real Folkways node. Run by the Folkways team; skipped elsewhere |

Add tests next to the code you change. Engine behaviour is easiest to test with the fake transport in
`test/support/fake-transport.ts`.

## Lint and type-check

```bash
pnpm lint
```

For the SDK this type-checks the sources and the tests with `tsc`; for the example app it runs ESLint.

## Try your changes in the example app

The example in `apps/react-example` uses the workspace's build of the SDK. You need a segment in the Folkways
dashboard and a token from your backend; its [README](../apps/react-example/README.md) explains both. Then:

```bash
pnpm dev
```

## Use a local build in your app

To try the SDK in another project before it is released, pack it and install the package file:

```bash
pnpm --filter @folkways/realtime build
cd packages/realtime
pnpm pack                     # writes folkways-realtime-<version>.tgz
```

```bash
# in your app
npm install /path/to/folkways-js/packages/realtime/folkways-realtime-<version>.tgz
```

Packing copies the repository's `README.md` into the package, so npm shows the same page as GitHub. Don't edit
`packages/realtime/README.md`; it is generated and ignored by git.
`pnpm --filter @folkways/realtime pack:release` packs the file a release publishes instead: its `package.json` has no
`scripts` or `devDependencies`, and packing fails if anything besides the build, `README.md`, `LICENSE` and `NOTICE`
would go in.
`packages/realtime/LICENSE` and `packages/realtime/NOTICE` are copies of the root files, so the package ships
them; change both copies together.

## Wire protocol bindings

`packages/realtime/proto/rte.fbs` is the FlatBuffers schema of the wire protocol, and
`src/transport/wire/generated/` holds the TypeScript generated from it. Don't edit the generated files. To
regenerate them after the schema changes, install [flatc](https://github.com/google/flatbuffers/releases) 24.3.25
(the version the `flatbuffers` runtime uses) and run:

```bash
pnpm --filter @folkways/realtime proto
```

Set `FLATC` if `flatc` isn't on your `PATH`.

## Changesets and releases

Releases are managed with [Changesets](https://github.com/changesets/changesets) and made by the
[Release workflow](../.github/workflows/release.yml).

- **Contributors:** when a change affects users of the package (a fix, a feature, a changed behaviour), run
  `pnpm changeset`, pick the bump (`patch`, `minor` or `major`) and describe the change in a sentence or two. Commit
  the generated file in `.changeset/` with your change. Changes to tests, tooling or these guides don't need one.
- **Maintainers:** to release what has been merged:
  1. Run `pnpm version-packages`. It turns the pending changesets into a version bump and changelog entries, and
     updates `src/api/version.ts` to match. Commit the result to `main`, through a pull request if you want a review.
  2. On GitHub, open **Actions → Release → Run workflow** on `main`. It lints, tests and builds the SDK, packs it with
     `pack:release`, creates the GitHub release `v<version>` with the package attached and the changelog entries as
     its notes, and publishes the same package to npm.

  Tick **Dry run** to only build and check the package; the run's summary lists the files it would publish. The
  workflow refuses to release while changesets are pending, or when the version is already tagged or on npm.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `pnpm: command not found` | Run `corepack enable`, or install pnpm 10.20 |
| `Unsupported engine` or odd syntax errors | Use Node.js 20.19 or newer (`nvm use`) |
| The example app doesn't see your SDK change | Make sure `pnpm dev` (or the SDK's `dev`) is running, or rebuild with `pnpm --filter @folkways/realtime build` |
| A test fails on an import | Check the layer rule above: `api` → `engine` → `transport` → `shared` |
| `need flatc 24.3.25` | Install that exact version, or point `FLATC` at it |
