import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Runs against the published bundles, not src: each entry point bundles its
// own copy of src/shared, which only the build shows. `pnpm test` builds first.
const dist = fileURLToPath(new URL('../dist/', import.meta.url));
if (!existsSync(`${dist}server.mjs`)) throw new Error('dist/ is missing: run `pnpm build` first');

type Client = typeof import('../src/index');
type Server = typeof import('../src/server/index');

const require = createRequire(import.meta.url);
const builds = {
  esm: { client: () => import(`${dist}index.mjs`) as Promise<Client>, server: () => import(`${dist}server.mjs`) as Promise<Server> },
  cjs: { client: async () => require(`${dist}index.js`) as Client, server: async () => require(`${dist}server.js`) as Server },
};

describe('built entry points', () => {
  for (const [from, build] of Object.entries(builds)) {
    it(`recognise an error thrown by Rest from the ${from} server build`, async () => {
      const server = await build.server();
      const rest = new server.Folkways.Rest({ url: 'http://localhost:9006', segment: 'c7e5a92b-62a1-4b14-bd8f-8bb74c77d3ff', signingKey: { kid: 'k', privateKey: 'secret' } });
      const err: unknown = await rest.createToken({}).catch((e: unknown) => e);
      expect(err).toMatchObject({ name: 'RealtimeError', code: server.Code.InvalidArgument });

      expect(server.isRealtimeError(err)).toBe(true);
      for (const client of [await builds.esm.client(), await builds.cjs.client()]) {
        expect(client.isRealtimeError(err)).toBe(true);
        expect(client.isRealtimeError(new Error('RealtimeError'))).toBe(false);
      }
    });
  }
});
