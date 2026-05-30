/**
 * Detached-process entry point for the idle-killer daemon. Spawned by
 * scripts/lib/idle-killer.ts via `child_process.spawn(node, [this-file, ...])`.
 * All logic lives in idle-killer-daemon.ts; this file is only the runtime
 * wiring (env reading, real network/fs/exec) and the `daemonLoop` invocation.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import {
  parseDaemonArgs,
  daemonLoop,
  bindSingleton,
  readHeartbeatMtime,
  portsHaveListeners,
  composeDown,
  sleep,
} from './idle-killer-daemon.js';

/* v8 ignore start -- detached-subprocess entry; tested via idle-killer-daemon.test.ts */
async function main(): Promise<void> {
  const args = parseDaemonArgs(process.argv.slice(2));

  // Load env so we know which ports to monitor and which compose project we own.
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, '..', '..');
  loadDotenv({ path: path.join(repoRoot, '.env.scripts'), override: true });

  const apiPort = Number(process.env['HB_API_PORT']);
  const vitePort = Number(process.env['HB_VITE_PORT']);
  const previewPort = Number(process.env['HB_PREVIEW_PORT']);
  const composeProject = process.env['COMPOSE_PROJECT_NAME'] ?? 'hushbox';

  await daemonLoop(
    {
      port: args.port,
      slot: args.slot,
      cacheDir: args.cacheDir,
      ttlMs: args.ttlMs,
      pollMs: 60_000,
      composeProject,
      repoRoot,
      apiPort,
      vitePort,
      previewPort,
    },
    {
      bindSingleton,
      readHeartbeatMtime,
      portsHaveListeners,
      composeDown,
      sleep,
      now: () => Date.now(),
      log: (m) => {
        process.stdout.write(`${new Date().toISOString()} ${m}\n`);
      },
    }
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`idle-killer-daemon error: ${message}\n`);
  process.exit(1);
});
/* v8 ignore stop */
