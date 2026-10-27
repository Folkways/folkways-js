# Contributing

Thank you for helping improve the Folkways JavaScript SDK. This guide explains how to propose a change and what we
look for when reviewing it.

## Ways to help

- **Code review:** read a pull request and comment on it. Check that the code is
  clear, correct, and matches the style of the surrounding code.
- ** Coding:** fix a bug, add a feature, or improve existing code.
- **Report a bug or ask for a feature:** see [Getting help and reporting issues](SUPPORT.md).
- **Improve documentation:** fix the README or these guides here. For the documentation site, open an issue
  describing what is missing or unclear.
- **Fix a bug or build a feature:** read on.

Security problems are the exception: never report them in an issue or a pull request. Follow the
[security policy](SECURITY.md) instead.

## Before you start

- **Small fixes** (a typo, a clear bug with an obvious fix): open a pull request directly.
- **Anything larger**, and every change to the public API: open an issue first and describe what you want to change
  and why. The public API is what `@folkways/realtime` exports, with its types in
  `packages/realtime/src/api/types.ts`. It is a promise to every app that uses the SDK, so we agree on changes to it
  before any code is written.

## Workflow

1. Fork the repository and create a branch from `main`.
2. Set up the repository: see the [development guide](DEVELOPMENT.md).
3. Make your change, with tests that cover it.
4. Check everything passes:

   ```bash
   pnpm lint
   pnpm test
   ```

5. If the change affects users of the package, add a changeset with `pnpm changeset`
   (see [Changesets and releases](DEVELOPMENT.md#changesets-and-releases)).
6. Open a pull request against `main`. Say what you changed and why, how you tested it, and link the issue it
   resolves.

A maintainer will review it. We may ask for changes; push them to the same branch.

## Guidelines

**Design**

- Keep the layers: `api` → `engine` → `transport` → `shared`. Lower layers never import higher ones; a test checks
  this.
- Keep the SDK small. It has one runtime dependency, `flatbuffers`; adding another needs a good reason and a
  discussion first.
- Everything in the main entry point must run in browsers, React Native, Node.js, Deno and Bun. Code that needs a
  specific runtime, like `node:fs`, belongs in its own entry point, as `stores/file` does.
- Report failures as a `RealtimeError` with a code from `Code`, so apps can handle them in one way.

**Security and privacy**

- Never log tokens, keys or payloads, not even at `debug` level.
- Never put a token in a URL.
- Code that holds a signing key belongs in `@folkways/realtime/server` only.

**Code**

- TypeScript in `strict` mode. Match the style of the code around your change.
- Document every public export with a short JSDoc comment that says what it does and its defaults.
- Don't edit the generated wire bindings by hand; regenerate them (see the development guide).

**Tests**

- Every bug fix comes with a test that fails without the fix.
- Prefer the engine tests' fake transport over timing-dependent tests.

**Commits**

- Write the subject in the imperative ("Fix reconnect after Draining"), and use the body to explain why.
- Keep unrelated changes in separate pull requests.

## License

By contributing, you agree that your contributions are licensed under the Apache License, Version 2.0,
like the rest of the project (section 5 of the license).

Sign off every commit with `git commit -s`. The `Signed-off-by` line certifies the
[Developer Certificate of Origin](https://developercertificate.org/): that you wrote the change, or
otherwise have the right to submit it under this license.
