import { type ChildProcess, spawn } from 'node:child_process';
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
 * Starts a real RTE node from `RTE_BIN` on free ports. The node keeps no data
 * of its own: it reads segments and keys from a control plane running its dev
 * seed, at `RTE__CORE__SEGMENTS_API` (default `http://localhost:8080/internal/rte`)
 * with the node token in `RTE__CORE__SEGMENTS_API_TOKEN` (default `dev-node-token`).
 * Returns undefined when `RTE_BIN` is unset.
 */
export async function startNode(env: Record<string, string> = {}): Promise<RteNode | undefined> {
  const bin = process.env.RTE_BIN;
  if (!bin) return undefined;
  const [wsPort, httpPort, metricsPort] = [await freePort(), await freePort(), await freePort()];
  const child: ChildProcess = spawn(bin, [], {
    env: {
      ...process.env,
      RUST_LOG: process.env.RTE_LOG ?? 'warn',
      RTE__CORE__SEGMENTS_API: process.env.RTE__CORE__SEGMENTS_API ?? 'http://localhost:8080/internal/rte',
      RTE__CORE__SEGMENTS_API_TOKEN: process.env.RTE__CORE__SEGMENTS_API_TOKEN ?? 'dev-node-token',
      RTE__ADAPTERS__WEBSOCKET__PORT: String(wsPort),
      RTE__ADAPTERS__HTTP__PORT: String(httpPort),
      RTE__MONITORING__METRICS_PORT: String(metricsPort),
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
