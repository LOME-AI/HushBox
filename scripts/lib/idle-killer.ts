/**
 * Per-worktree-slot inactivity daemon. One process per slot, exclusivity
 * enforced kernel-side by binding 127.0.0.1:HB_IDLE_DAEMON_PORT (any second
 * binder gets EADDRINUSE). Launch races between two `ensureStack` callers are
 * serialized by an O_EXCL lock file, which is also stale-broken if a previous
 * launcher crashed.
 *
 * Cross-platform: no flock, no abstract sockets, no /proc walks. Only fs ops,
 * node:net, and child_process.spawn — all behave identically on linux, darwin,
 * and win32 (modulo `windowsHide` for detached spawn).
 */
import { promises as fs, openSync, closeSync } from 'node:fs';
import { connect } from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { spawn as nodeSpawn } from 'node:child_process';

/** Bucket consecutive heartbeat ticks to one filesystem touch every 5s. */
export const HEARTBEAT_BUCKET_MS = 5000;

/** Stale-lock window. A launcher older than this is presumed dead. */
export const LAUNCH_LOCK_STALE_MS = 30_000;

export type SpawnFunction = typeof nodeSpawn;

export interface ShouldTearDownInput {
  heartbeatAgeMs: number;
  ttlMs: number;
  portsHaveListeners: boolean;
}

export function shouldTearDown(input: ShouldTearDownInput): boolean {
  if (input.portsHaveListeners) return false;
  return input.heartbeatAgeMs >= input.ttlMs;
}

export function heartbeatAgeMs(mtimeMs: number, nowMs: number): number {
  const diff = nowMs - mtimeMs;
  return Math.max(diff, 0);
}

/**
 * Stamp the heartbeat file's mtime to now. Creates the file if missing.
 * `'a'` mode opens for append, creating on miss — so a single open+utimes+close
 * sequence covers both create and refresh paths with no fork. Cheap enough
 * that bucketing via HEARTBEAT_BUCKET_MS is a politeness, not a necessity.
 */
export async function touchHeartbeat(heartbeatPath: string): Promise<void> {
  const handle = await fs.open(heartbeatPath, 'a');
  try {
    const now = new Date();
    await handle.utimes(now, now);
  } finally {
    await handle.close();
  }
}

function isErrnoCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && (error as { code: unknown }).code === code;
}

/**
 * Atomically claim the launch slot. Returns true if we got it.
 *
 * Uses O_CREAT|O_EXCL — atomic on every Node-supported FS. If the lock exists
 * but its mtime is older than LAUNCH_LOCK_STALE_MS, we assume the prior
 * launcher crashed and force-clear it before retrying. The pid we write inside
 * is informational only; we never trust it for liveness.
 */
export async function acquireLaunchLock(lockPath: string): Promise<boolean> {
  try {
    const fd = openSync(lockPath, 'wx');
    closeSync(fd);
    await fs.writeFile(lockPath, String(process.pid));
    return true;
  } catch (error) {
    if (!isErrnoCode(error, 'EEXIST')) throw error;
  }

  // Lock exists. Check for staleness. If the lock vanishes between EEXIST and
  // stat (extreme race), fs.stat throws — propagate; the caller's next attempt
  // (or its outer error handler) will redo the whole sequence cleanly. A try/
  // catch returning false here would obscure permission/IO errors that are
  // worth surfacing.
  const stat = await fs.stat(lockPath);
  const ageMs = Date.now() - stat.mtimeMs;
  if (ageMs < LAUNCH_LOCK_STALE_MS) {
    return false;
  }

  // Stale. Break and reclaim. unlink + the re-create can both lose to a
  // sibling launcher that wins between our checks; both error branches are
  // unreachable in single-process tests but defended against because the
  // race IS real across two ensureStack callers in different processes.
  return await stealStaleLock(lockPath);
}

/* v8 ignore start -- multi-process race branches inside; covered indirectly through acquireLaunchLock's happy path test */
async function stealStaleLock(lockPath: string): Promise<boolean> {
  try {
    await fs.unlink(lockPath);
  } catch {
    // Sibling already cleared it — fall through to wx.
  }
  try {
    const fd = openSync(lockPath, 'wx');
    closeSync(fd);
    await fs.writeFile(lockPath, String(process.pid));
    return true;
  } catch {
    return false;
  }
}
/* v8 ignore stop */

export async function releaseLaunchLock(lockPath: string): Promise<void> {
  try {
    await fs.unlink(lockPath);
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) return;
    throw error;
  }
}

export interface IsDaemonAliveOptions {
  /** Connect timeout. Default 500 ms — local TCP refuses or accepts in <50 ms. */
  timeoutMs?: number;
}

/**
 * Cross-platform daemon-liveness probe. Tries to open a TCP connection to
 * 127.0.0.1:port; the kernel responds synchronously with either a SYN-ACK
 * (alive) or a RST (ECONNREFUSED, dead). The socket is closed immediately —
 * no protocol exchange, no payload.
 */
/* v8 ignore start -- isDaemonAlive uses node:net sockets whose inline event handlers v8 reports as separate uncovered functions even when the outer behavior is fully tested (alive, dead, timeout). The behavior is covered by the three corresponding tests. */
export async function isDaemonAlive(
  port: number,
  options: IsDaemonAliveOptions = {}
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 500;
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    let settled = false;
    const settle = (alive: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(alive);
    };
    socket.setTimeout(timeoutMs, () => {
      settle(false);
    });
    socket.once('connect', () => {
      settle(true);
    });
    socket.once('error', () => {
      settle(false);
    });
  });
}
/* v8 ignore stop */

export interface EnsureDaemonOptions {
  port: number;
  cacheDir: string;
  daemonScriptPath: string;
  slot: number;
  ttlMs: number;
  /** Test injection. Defaults to the real `child_process.spawn`. */
  spawn?: SpawnFunction;
  /** Test injection. Defaults to {@link isDaemonAlive}. */
  isAlive?: (port: number) => Promise<boolean>;
  /** Test injection for the launch lock path. */
  lockPath?: string;
}

/**
 * The daemon entry point is a `.ts` file (the orchestrator and the daemon both
 * run via tsx). `process.execPath` is plain node, which can't load TypeScript
 * directly. Resolve tsx's `bin` from its package.json and run
 * `node <tsx-cli> <daemon-entry>` so the daemon inherits the same TS loader
 * as its parent. tsx's package `exports` map omits `./dist/cli.mjs`, so we
 * pull it from the published `bin` field on the package.json. Cross-platform:
 * the bin is a portable ESM entry shipped with the package.
 */
export function resolveTsxCliPath(): string {
  /* v8 ignore start -- requires real node_modules layout; covered by integration test */
  const require_ = createRequire(import.meta.url);
  const packageJsonPath = require_.resolve('tsx/package.json');
  const package_ = require_(packageJsonPath) as { bin?: string | Record<string, string> };
  const binEntry = typeof package_.bin === 'string' ? package_.bin : package_.bin?.['tsx'];
  if (binEntry === undefined) {
    throw new Error('idle-killer: tsx package.json has no resolvable bin entry');
  }
  return path.resolve(path.dirname(packageJsonPath), binEntry);
  /* v8 ignore stop */
}

/* v8 ignore start -- defaults fork a real subprocess at runtime; tests inject. */
async function resolveEnsureDaemonDefaults(options: EnsureDaemonOptions): Promise<{
  isAlive: (port: number) => Promise<boolean>;
  spawn: SpawnFunction;
  lockPath: string;
}> {
  const childProcess = await import('node:child_process');
  return {
    isAlive: options.isAlive ?? isDaemonAlive,
    spawn: options.spawn ?? childProcess.spawn,
    lockPath: options.lockPath ?? `${options.cacheDir}/daemon.lock`,
  };
}
/* v8 ignore stop */

/**
 * Ensure a daemon is running for this slot. Idempotent and safe to call
 * concurrently from multiple `ensureStack` invocations.
 *
 * Race sequence:
 *   1. Probe TCP — alive? return.
 *   2. Take O_EXCL launch lock — lost? assume the winner is spawning, return.
 *   3. Probe TCP again — alive now? winner finished, release lock, return.
 *   4. Spawn detached daemon, release lock.
 */
export async function ensureDaemonRunning(options: EnsureDaemonOptions): Promise<void> {
  const { isAlive, spawn, lockPath } = await resolveEnsureDaemonDefaults(options);
  if (await isAlive(options.port)) return;

  const gotLock = await acquireLaunchLock(lockPath);
  if (!gotLock) return;

  try {
    // Sibling launcher may have spawned in the window between our first probe
    // and our lock acquisition; re-check before spending the spawn.
    if (await isAlive(options.port)) return;

    // Spawn shape: `node <tsx-cli> <daemon-entry.ts> --flags…`. Without the
    // tsx-cli interposed, node would reject the `.ts` extension and the
    // daemon would crash silently under `stdio: 'ignore'`.
    const tsxCliPath = resolveTsxCliPath();
    const child = spawn(
      process.execPath,
      [
        tsxCliPath,
        options.daemonScriptPath,
        '--port',
        String(options.port),
        '--slot',
        String(options.slot),
        '--ttl-ms',
        String(options.ttlMs),
        '--cache-dir',
        options.cacheDir,
      ],
      {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }
    );
    child.unref();
  } finally {
    await releaseLaunchLock(lockPath);
  }
}
