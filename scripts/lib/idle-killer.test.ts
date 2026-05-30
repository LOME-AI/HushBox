/* eslint-disable sonarjs/publicly-writable-directories -- tmpdir is standard test fixture root */
/* eslint-disable @typescript-eslint/require-await -- mock callbacks intentionally async */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  shouldTearDown,
  heartbeatAgeMs,
  touchHeartbeat,
  acquireLaunchLock,
  releaseLaunchLock,
  isDaemonAlive,
  ensureDaemonRunning,
  resolveTsxCliPath,
  HEARTBEAT_BUCKET_MS,
  LAUNCH_LOCK_STALE_MS,
  type SpawnFunction,
} from './idle-killer.js';

let workDir = '';

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'hb-idle-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('shouldTearDown', () => {
  it('returns false when heartbeat is fresh (age < ttl) regardless of listeners', () => {
    expect(shouldTearDown({ heartbeatAgeMs: 1000, ttlMs: 60_000, portsHaveListeners: false })).toBe(
      false
    );
    expect(shouldTearDown({ heartbeatAgeMs: 1000, ttlMs: 60_000, portsHaveListeners: true })).toBe(
      false
    );
  });

  it('returns false when heartbeat is stale BUT a port has a listener (live-process veto)', () => {
    expect(
      shouldTearDown({ heartbeatAgeMs: 999_999, ttlMs: 60_000, portsHaveListeners: true })
    ).toBe(false);
  });

  it('returns true only when heartbeat is stale AND no ports have listeners', () => {
    expect(
      shouldTearDown({ heartbeatAgeMs: 999_999, ttlMs: 60_000, portsHaveListeners: false })
    ).toBe(true);
  });

  it('uses >= for the TTL boundary (age == ttl means stale)', () => {
    expect(
      shouldTearDown({ heartbeatAgeMs: 60_000, ttlMs: 60_000, portsHaveListeners: false })
    ).toBe(true);
  });
});

describe('heartbeatAgeMs', () => {
  it('returns now - mtimeMs', () => {
    expect(heartbeatAgeMs(900, 1000)).toBe(100);
  });

  it('clamps negative results to 0 (clock skew safety)', () => {
    expect(heartbeatAgeMs(1500, 1000)).toBe(0);
  });
});

describe('touchHeartbeat', () => {
  it('creates the heartbeat file when missing and stamps mtime ~now', async () => {
    const file = path.join(workDir, 'heartbeat');
    const before = Date.now();
    await touchHeartbeat(file);
    const after = Date.now();
    const stat = statSync(file);
    expect(stat.mtimeMs).toBeGreaterThanOrEqual(before - 1000);
    expect(stat.mtimeMs).toBeLessThanOrEqual(after + 1000);
  });

  it('updates the mtime of an existing heartbeat file', async () => {
    const file = path.join(workDir, 'heartbeat');
    writeFileSync(file, '');
    // Force old mtime
    const { utimesSync } = await import('node:fs');
    const past = new Date(Date.now() - 60_000);
    utimesSync(file, past, past);
    await touchHeartbeat(file);
    const stat = statSync(file);
    expect(stat.mtimeMs).toBeGreaterThan(past.getTime() + 5000);
  });

  it('exposes HEARTBEAT_BUCKET_MS for callers that want to bucket their ticks', () => {
    expect(HEARTBEAT_BUCKET_MS).toBeGreaterThan(0);
  });

  it('throws when the path is uncreatable (e.g. parent dir does not exist)', async () => {
    const blocked = path.join(workDir, 'no', 'such', 'parent', 'heartbeat');
    await expect(touchHeartbeat(blocked)).rejects.toThrow();
  });
});

describe('acquireLaunchLock / releaseLaunchLock', () => {
  it('returns true and creates the lock file on a fresh acquire', async () => {
    const lockPath = path.join(workDir, 'daemon.lock');
    expect(await acquireLaunchLock(lockPath)).toBe(true);
    expect(existsSync(lockPath)).toBe(true);
  });

  it('returns false when a second caller races against an existing fresh lock', async () => {
    const lockPath = path.join(workDir, 'daemon.lock');
    await acquireLaunchLock(lockPath);
    expect(await acquireLaunchLock(lockPath)).toBe(false);
  });

  it('breaks a stale lock (mtime older than LAUNCH_LOCK_STALE_MS) and acquires', async () => {
    const lockPath = path.join(workDir, 'daemon.lock');
    writeFileSync(lockPath, '');
    const { utimesSync } = await import('node:fs');
    const stale = new Date(Date.now() - LAUNCH_LOCK_STALE_MS - 1000);
    utimesSync(lockPath, stale, stale);
    expect(await acquireLaunchLock(lockPath)).toBe(true);
  });

  it('releaseLaunchLock removes the lock file (idempotent if already gone)', async () => {
    const lockPath = path.join(workDir, 'daemon.lock');
    await acquireLaunchLock(lockPath);
    await releaseLaunchLock(lockPath);
    expect(existsSync(lockPath)).toBe(false);
    // Releasing again should not throw.
    await releaseLaunchLock(lockPath);
  });

  it('releaseLaunchLock throws on non-ENOENT errors (e.g. unlinking a directory)', async () => {
    // Unlinking a directory yields EISDIR (linux) or EPERM (darwin) — neither
    // is ENOENT, so the helper rethrows.
    const dirPath = path.join(workDir, 'subdir');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dirPath);
    await expect(releaseLaunchLock(dirPath)).rejects.toThrow();
  });

  it('acquireLaunchLock rethrows non-EEXIST errors from the initial open (e.g. ENOENT parent)', async () => {
    // openSync('wx') on a missing parent yields ENOENT — non-EEXIST — surfaces.
    const inMissingParent = path.join(workDir, 'no', 'such', 'parent', 'daemon.lock');
    await expect(acquireLaunchLock(inMissingParent)).rejects.toThrow();
  });
});

describe('isDaemonAlive', () => {
  it('returns true when a TCP listener is bound on 127.0.0.1:port', async () => {
    const server: Server = createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (typeof address === 'string' || address === null) throw new Error('expected AddressInfo');
    const port = address.port;
    try {
      expect(await isDaemonAlive(port)).toBe(true);
    } finally {
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        })
      );
    }
  });

  it('returns false when no listener is bound on 127.0.0.1:port (ECONNREFUSED)', async () => {
    // Pick a port that's almost certainly free.
    const port = 39_999;
    expect(await isDaemonAlive(port)).toBe(false);
  });

  it('returns false on timeout', async () => {
    // Connect to a non-routable address via a port that won't resolve quickly;
    // use a tight timeout to force the timeout path.
    expect(await isDaemonAlive(39_999, { timeoutMs: 1 })).toBe(false);
  });
});

describe('resolveTsxCliPath', () => {
  it('resolves to an existing tsx cli binary inside node_modules', async () => {
    const { existsSync: existsSyncReal } = await import('node:fs');
    const cliPath = resolveTsxCliPath();
    expect(cliPath).toMatch(/tsx\/dist\/cli\.mjs$/);
    expect(existsSyncReal(cliPath)).toBe(true);
  });
});

describe('daemon-entry (integration)', () => {
  // End-to-end: launch the real daemon binary the same way `ensureDaemonRunning`
  // would (`node <tsx-cli> <daemon-entry>`) and verify it binds the singleton
  // TCP port. Regression guard against the earlier bug where the spawn used
  // `process.execPath` directly on a .ts file and crashed silently.
  //
  // This test does NOT route through `ensureDaemonRunning` because the daemon's
  // teardown path reads `COMPOSE_PROJECT_NAME` from inherited env. If we let it
  // inherit the real-stack value and the daemon survived past the test (e.g.,
  // detached + slow kill on a busy CI host), it would `docker compose down`
  // the actual hushbox stack on its first poll. We sandbox env here so even a
  // worst-case orphan can't touch real containers.
  it('binds the singleton port when launched via node + tsx CLI', async () => {
    const { spawn } = await import('node:child_process');
    const tickerDir = fileURLToPath(new URL('.', import.meta.url));
    const entryPath = path.join(tickerDir, 'idle-killer-daemon-entry.ts');
    const port = 18_999 + Math.floor(Math.random() * 1000);
    await touchHeartbeat(path.join(workDir, 'heartbeat'));

    const child = spawn(
      process.execPath,
      [
        resolveTsxCliPath(),
        entryPath,
        '--port',
        String(port),
        '--slot',
        '999',
        '--ttl-ms',
        '3600000',
        '--cache-dir',
        workDir,
      ],
      {
        // detached:true puts the child in its OWN process group. tsx's CLI
        // then spawns the actual daemon process inside that group. Killing
        // the negative pid (process group) at cleanup time signals the whole
        // group — including the inner tsx-launched daemon — so we don't leak
        // an orphan that would later run its teardown loop.
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: {
          ...process.env,
          // Fake compose project — even if the daemon ever runs its teardown
          // path, `docker compose -p <this> down` is a no-op against a name
          // that doesn't exist. Hard isolation from the real stack.
          COMPOSE_PROJECT_NAME: `hushbox-test-stub-${String(Math.floor(Math.random() * 1_000_000))}`,
          // Force the port-veto check to find a listener so the daemon won't
          // try to tear anything down even if its heartbeat ages out: set the
          // observed API port to its own singleton port (always bound).
          HB_API_PORT: String(port),
          HB_VITE_PORT: '0',
          HB_PREVIEW_PORT: '0',
        },
      }
    );

    try {
      // Generous bind window: under heavy parallel vitest load, the daemon's
      // initial tsx-loader + module-graph import can take 5–8s on the cold
      // path. 10s of polling avoids flakiness on a loaded runner.
      let alive = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await isDaemonAlive(port)) {
          alive = true;
          break;
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 100);
        });
      }
      expect(alive).toBe(true);
    } finally {
      // Kill the entire process group (negative pid). The outer node + the
      // tsx-spawned inner daemon both belong to it, so a single SIGKILL ends
      // both. Without this, tsx's child node survives a plain child.kill().
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* group may already be gone if the child died first */
        }
      }
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        child.once('exit', () => {
          resolve();
        });
      });
    }
  }, 30_000);
});

describe('ensureDaemonRunning', () => {
  it('is a no-op when a daemon is already alive', async () => {
    const spawn = vi.fn() as unknown as SpawnFunction;
    await ensureDaemonRunning({
      port: 1234,
      cacheDir: workDir,
      daemonScriptPath: '/fake/daemon.ts',
      slot: 1,
      ttlMs: 3_600_000,
      spawn,
      isAlive: () => Promise.resolve(true),
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('spawns the daemon detached when no daemon is alive', async () => {
    const spawn = vi.fn().mockReturnValue({
      unref: vi.fn(),
      // Mimic enough of a ChildProcess for the helper to "fire and forget"
    }) as unknown as SpawnFunction;
    await ensureDaemonRunning({
      port: 1234,
      cacheDir: workDir,
      daemonScriptPath: '/fake/daemon.ts',
      slot: 7,
      ttlMs: 3_600_000,
      spawn,
      isAlive: () => Promise.resolve(false),
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    const [, args, options] = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string[],
      { detached: boolean; stdio: string | unknown[]; windowsHide?: boolean },
    ];
    expect(args).toContain('/fake/daemon.ts');
    expect(args).toContain('--port');
    expect(args).toContain('1234');
    expect(args).toContain('--slot');
    expect(args).toContain('7');
    expect(options.detached).toBe(true);
    expect(options.windowsHide).toBe(true);
  });

  it('does not spawn when another caller wins the launch lock', async () => {
    const lockPath = path.join(workDir, 'daemon.lock');
    // Pre-acquire the lock to simulate another caller mid-launch.
    await acquireLaunchLock(lockPath);
    const spawn = vi.fn() as unknown as SpawnFunction;
    await ensureDaemonRunning({
      port: 1234,
      cacheDir: workDir,
      daemonScriptPath: '/fake/daemon.ts',
      slot: 1,
      ttlMs: 3_600_000,
      spawn,
      isAlive: () => Promise.resolve(false),
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('passes tsx CLI as argv[0] so the .ts daemon entry actually loads', async () => {
    const spawn = vi.fn().mockReturnValue({ unref: vi.fn() }) as unknown as SpawnFunction;
    await ensureDaemonRunning({
      port: 1234,
      cacheDir: workDir,
      daemonScriptPath: '/fake/daemon.ts',
      slot: 0,
      ttlMs: 60_000,
      spawn,
      isAlive: () => Promise.resolve(false),
    });
    const [bin, args] = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string[],
    ];
    // argv[0] = node, argv[1] = tsx CLI, argv[2] = daemon script.
    expect(bin).toBe(process.execPath);
    expect(args[0]).toBe(resolveTsxCliPath());
    expect(args[1]).toBe('/fake/daemon.ts');
  });

  it('rechecks isAlive after acquiring the lock (covers the race)', async () => {
    let aliveCallCount = 0;
    const spawn = vi.fn() as unknown as SpawnFunction;
    await ensureDaemonRunning({
      port: 1234,
      cacheDir: workDir,
      daemonScriptPath: '/fake/daemon.ts',
      slot: 1,
      ttlMs: 3_600_000,
      spawn,
      // First call (pre-lock) returns false; second call (post-lock) returns
      // true to simulate a sibling having just spawned.
      isAlive: () => {
        aliveCallCount++;
        return Promise.resolve(aliveCallCount >= 2);
      },
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(aliveCallCount).toBe(2);
  });
});
