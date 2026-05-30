/**
 * Idle-killer daemon entry point. Spawned detached by ensure-stack via
 * scripts/lib/idle-killer.ts. Runs forever (within a worktree-slot's lifecycle)
 * until either:
 *
 *   - heartbeat is older than TTL AND no listener on the slot's API/Vite/
 *     Preview ports (idle teardown), or
 *   - a second daemon tries to bind 127.0.0.1:port and fails — meaning a
 *     race in launch detection left us behind; the elder daemon owns the
 *     slot and we exit (singleton-conflict).
 *
 * Decisions are pure functions of injected deps; tests verify the loop
 * without spinning real docker, network, or fs.
 */
import { createServer, type Server } from 'node:net';
import path from 'node:path';
import { execa } from 'execa';
import { stat } from 'node:fs/promises';
import { shouldTearDown } from './idle-killer.js';
import { selectListenerLookup } from '../kill-ports.js';

export interface DaemonOptions {
  port: number;
  slot: number;
  cacheDir: string;
  ttlMs: number;
  pollMs: number;
  composeProject: string;
  repoRoot: string;
  apiPort: number;
  vitePort: number;
  previewPort: number;
}

export interface DaemonDeps {
  bindSingleton: (port: number) => Promise<{ close: () => void }>;
  readHeartbeatMtime: (heartbeatPath: string) => Promise<number | null>;
  portsHaveListeners: (ports: readonly number[]) => Promise<boolean>;
  composeDown: (project: string, repoRoot: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (message: string) => void;
}

export interface DaemonResult {
  exitReason: 'idle-teardown' | 'singleton-conflict';
}

function parseArgvPairs(argv: readonly string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === undefined || value === undefined) {
      throw new Error(`idle-killer-daemon: malformed argv near "${String(key)}"`);
    }
    map[key] = value;
  }
  return map;
}

function requirePositiveInt(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`idle-killer-daemon: invalid ${flag}`);
  }
  return parsed;
}

function requireNonNegativeInt(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`idle-killer-daemon: invalid ${flag}`);
  }
  return parsed;
}

export function parseDaemonArgs(argv: readonly string[]): {
  port: number;
  slot: number;
  ttlMs: number;
  cacheDir: string;
} {
  const map = parseArgvPairs(argv);
  const port = requirePositiveInt(map['--port'], '--port');
  const slot = requireNonNegativeInt(map['--slot'], '--slot');
  const ttlMs = requirePositiveInt(map['--ttl-ms'], '--ttl-ms');
  const cacheDir = map['--cache-dir'];
  if (!cacheDir) throw new Error('idle-killer-daemon: missing --cache-dir');
  return { port, slot, ttlMs, cacheDir };
}

export async function daemonLoop(options: DaemonOptions, deps: DaemonDeps): Promise<DaemonResult> {
  let singleton: { close: () => void };
  try {
    singleton = await deps.bindSingleton(options.port);
  } catch {
    deps.log(`singleton bind failed on port ${String(options.port)}; another daemon owns the slot`);
    return { exitReason: 'singleton-conflict' };
  }

  const heartbeatPath = path.join(options.cacheDir, 'heartbeat');
  const observedPorts = [options.apiPort, options.vitePort, options.previewPort];

  try {
    for (;;) {
      const mtime = await deps.readHeartbeatMtime(heartbeatPath);
      const ageMs = mtime === null ? Number.POSITIVE_INFINITY : deps.now() - mtime;
      const portsHaveListeners = await deps.portsHaveListeners(observedPorts);
      const tearDown = shouldTearDown({
        heartbeatAgeMs: ageMs,
        ttlMs: options.ttlMs,
        portsHaveListeners,
      });
      if (tearDown) {
        deps.log(
          `idle for ${String(Math.round(ageMs / 1000))}s (ttl ${String(Math.round(options.ttlMs / 1000))}s), no listeners → tearing down ${options.composeProject}`
        );
        await deps.composeDown(options.composeProject, options.repoRoot);
        return { exitReason: 'idle-teardown' };
      }
      await deps.sleep(options.pollMs);
    }
  } finally {
    singleton.close();
  }
}

/* v8 ignore start -- real-IO bindings exercised at runtime via the CLI; daemonLoop is tested with injected deps */
export function bindSingleton(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

export async function readHeartbeatMtime(heartbeatPath: string): Promise<number | null> {
  try {
    const s = await stat(heartbeatPath);
    return s.mtimeMs;
  } catch {
    return null;
  }
}

export async function portsHaveListeners(ports: readonly number[]): Promise<boolean> {
  const lookup = selectListenerLookup();
  for (const port of ports) {
    const pids = await lookup(port);
    if (pids.length > 0) return true;
  }
  return false;
}

export async function composeDown(project: string, repoRoot: string): Promise<void> {
  await execa('docker', ['compose', '-p', project, 'down'], {
    cwd: repoRoot,
    stdio: 'ignore',
    reject: false,
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
/* v8 ignore stop */
