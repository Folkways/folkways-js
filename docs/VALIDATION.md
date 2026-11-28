# Pull request validation

The Validation workflow runs on pull requests and pushes to main. It uses read-only permissions and does not publish packages.

- SDK and examples: frozen dependency install, workspace build, lint and tests, README TypeScript examples, release package inspection and ESM/CommonJS entry-point smoke tests.
- Protocol bindings: build the pinned FlatBuffers 24.3.25 compiler, regenerate bindings and fail on any tracked or untracked differences.

The public boundary check rejects newly introduced non-public repository references, endpoints, embedded key material and machine-specific paths without logging matched content. Existing findings are reported while the repository is being cleaned up. The package itself is checked without a baseline. This is a limited heuristic, not a substitute for secret scanning or review.

Run locally from the repository root after installing dependencies:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm lint
pnpm test
node scripts/check-readme.mjs
node --test scripts/check-public-boundary.test.mjs
node scripts/check-public-boundary.mjs source --strict
pnpm --filter @folkwaysio/realtime proto
git status --short
```

The README TypeScript blocks are compiled together as a single example using the built package's public types. They are not executed against a live service.

The protocol step needs FlatBuffers 24.3.25. See [Development guide](DEVELOPMENT.md#wire-protocol-bindings) for local setup. Live-service tests require a separately configured isolated test environment and are not a public pull request job. Keep credentials and service provisioning out of this repository.

Maintainers should require both validation jobs before merging. The strict source boundary check is also available through a manual workflow run. Once existing findings are removed, use strict source checking for every pull request.
