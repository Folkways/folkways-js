import { type ChildProcess, spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { createServer } from 'node:net';

export interface RteNode {
  ws: string;
  http: string;
  stop(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => res(port));
    });
    s.on('error', rej);
  });
}

async function waitHealthy(url: string, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`RTE node not healthy at ${url}`);
}

/**
 * Starts a real RTE node from `RTE_BIN` on free ports, with the repository's
 * seeds (`RTE_DIR`, default: two levels above the binary's target dir).
 * Returns undefined when `RTE_BIN` is unset.
 */
export async function startNode(env: Record<string, string> = {}): Promise<RteNode | undefined> {
  const bin = process.env.RTE_BIN;
  if (!bin) return undefined;
  const dir = process.env.RTE_DIR ?? resolve(dirname(bin), '..', '..');
  const [wsPort, httpPort, metricsPort] = [await freePort(), await freePort(), await freePort()];
  const child: ChildProcess = spawn(bin, [], {
    cwd: dir,
    env: {
      ...process.env,
      RUST_LOG: process.env.RTE_LOG ?? 'warn',
      RTE__ADAPTERS__WEBSOCKET__PORT: String(wsPort),
      RTE__ADAPTERS__HTTP__PORT: String(httpPort),
      RTE__MONITORING__METRICS_PORT: String(metricsPort),
      RTE__CORE__SEGMENTS_FILE: resolve(dir, 'seeds/workspaces.json'),
      ...env,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  await waitHealthy(`http://127.0.0.1:${metricsPort}/healthz`, 15_000);
  return {
    ws: `ws://127.0.0.1:${wsPort}/v1/ws`,
    http: `http://127.0.0.1:${httpPort}`,
    stop: () =>
      new Promise<void>((res) => {
        if (child.exitCode !== null) return res();
        child.once('exit', () => res());
        child.kill('SIGKILL');
      }),
  };
}
