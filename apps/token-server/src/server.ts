import type { Rest } from '@folkwaysio/realtime/server';
import { createApp, createRest } from './app.js';
import { type Config, ConfigError, loadConfig } from './config.js';

function fail(message: string): never {
  console.error(`token-server: ${message}`);
  process.exit(1);
}

function readConfig(): Config {
  // Load .env into process.env, when there is one.
  try {
    process.loadEnvFile();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  try {
    return loadConfig();
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return fail(`fix these settings in .env (see .env.example):\n  ${err.problems.join('\n  ')}`);
  }
}

/** The signing client, after signing one token: a key that can't sign stops the server here, not on a user's first request. */
async function signingClient(config: Config): Promise<Rest> {
  try {
    const rte = createRest(config);
    await rte.createToken({ identity: 'token-server', kind: 'service', ttlMs: 60_000 });
    return rte;
  } catch (err) {
    return fail(`the signing key in ${config.keySource} can't sign tokens: ${(err as Error).message}`);
  }
}

const config = readConfig();
const app = createApp(config, await signingClient(config));
const server = app.listen(config.port, config.host, (err) => {
  if (err) fail(`can't listen on ${config.host}:${config.port}: ${err.message}`);
  console.log(`token-server: listening on http://${config.host}:${config.port}`);
  console.log(`  segment ${config.segment}, key ${config.signingKey.kid} from ${config.keySource}, tokens last ${config.tokenTtlMs / 1000} s`);
  if (!config.sessionSecretFromEnv) console.log('  SESSION_SECRET is not set: sign-ins last until the server restarts');
  console.log("  This example signs anyone in by name. Use your app's own login before you deploy it.");
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
