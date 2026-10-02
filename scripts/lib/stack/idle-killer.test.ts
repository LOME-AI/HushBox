import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tryLock } from '../claims/claim.js';
import { RUN_CLAIM_ENV } from '../claims/registry.js';
import { LIFELINE_ENV } from '../spawn/long-lived.js';
import { daemonIdentityLockPath } from './idle-killer-daemon.js';
import {
  describeTeardownFailure,
  readTeardownFailure,
  recordTeardownFailure,
} from './idle-teardown-failure.js';
import {
  shouldTearDown,
  isDaemonAlive,
  ensureDaemonRunning,
  resolveTsxCliPath,
  EMPTY_POLLS_BEFORE_TEARDOWN,
  type SpawnFunction,
} from './idle-killer.js';
import { portFor, SLOTS } from './port-plan.js';

/**
 * What a wait for a daemon this suite spawned may spend, far above the runner's
 * default.
 *
 * Plainly a larger budget rather than a cleverer instrument, because nothing
 * observable shortens what it covers. The daemon boots through tsx, which
 * compiles its whole module graph cold: a fraction of a second on an idle
 * machine, tens of seconds when many suites share one. The runner's default is
 * sized for cases that spawn nothing, so it is the first bound to lose when the
 * host is busy, and the loss reads as a broken mechanism rather than a slow one.
 * `idle-daemon-teardown-evidence.test.ts` carries the same budget for the same
 * boot.
 *
 * A bound on waiting and nothing else: what the cases read is the state the
 * daemon reached, never the time it took to reach it.
 */
const COLD_FIXTURE_BUDGET_MS = 60_000;

/**
 * What a hook here may spend, far above the runner's default.
 *
 * The bodies these cover are trivial — a temporary directory made and removed,
 * a signalled process reaped — and none of them waits for a daemon to become
 * ready. What they lose to is the host: when many suites run at once a worker
 * can go without a turn for longer than the runner allows a hook, and the
 * failure is then reported against whichever case the hook belonged to rather
 * than against anything that was slow.
 *
 * A bound on waiting and nothing else: a hook that genuinely hangs still fails,
 * later.
 */
const STARVED_HOOK_BUDGET_MS = 60_000;

let workDir = '';

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'hb-idle-'));
}, STARVED_HOOK_BUDGET_MS);

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
}, STARVED_HOOK_BUDGET_MS);

describe('shouldTearDown', () => {
  it('leaves a slot alone while a run still holds a claim on it', () => {
    expect(shouldTearDown({ liveClaims: 1, consecutiveEmptyPolls: 99, graceWindowPolls: 30 })).toBe(
      false
    );
  });

  it('leaves a slot alone one poll short of the grace window', () => {
    expect(shouldTearDown({ liveClaims: 0, consecutiveEmptyPolls: 29, graceWindowPolls: 30 })).toBe(
      false
    );
  });

  it('tears down on the poll that completes the grace window', () => {
    expect(shouldTearDown({ liveClaims: 0, consecutiveEmptyPolls: 30, graceWindowPolls: 30 })).toBe(
      true
    );
  });

  it('publishes a grace window of more than one poll, so one empty poll never tears down', () => {
    expect(EMPTY_POLLS_BEFORE_TEARDOWN).toBeGreaterThan(1);
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
  //
  // The registry is sandboxed for the same reason the compose project is: the
  // daemon's identity claim is keyed by its port, and the port this block hands
  // it is the one the plan gives a real slot's daemon. Written machine-wide, the
  // claim would sit at the path a world audit reads to learn who holds that
  // slot's sentinel, and answer it with this fixture's stub compose project —
  // reporting that slot as held by another stack's daemon.

  /**
   * The slot this block has taken, the sentinel port the plan gives that slot,
   * and the listener that holds the slot for as long as the daemon runs.
   *
   * Taken at run time rather than named in advance: a number named in advance
   * is one every concurrent run of this file hands its daemon at once, and the
   * daemon that loses the singleton bind exits without ever taking the identity
   * claim the second case waits on.
   *
   * The sentinel cannot be its own reservation, because the daemon under test
   * is what binds it — a port this process bound and released would be free
   * again in the gap before the child got there. What holds the slot is a
   * listener on another of its ports, held for the whole block, and the
   * sentinel is then the port the plan gives that slot. A slot whose sentinel
   * something already holds is passed over. Slots are issued lowest-free
   * (`scripts/lib/claims/slot-claim.ts` scans upward from zero), so the search
   * runs downward, away from the ones checkouts hold.
   */
  let slot = 0;
  let sentinel = 0;
  let slotReservation: Server | undefined;
  let registryDir = '';
  let child: ChildProcess | undefined;

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  /** A listener on `port`, or nothing when something else already holds it. */
  function bindOrNull(port: number): Promise<Server | null> {
    return new Promise((resolve) => {
      const server = createServer();
      const refuse = (): void => {
        resolve(null);
      };
      server.once('error', refuse);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', refuse);
        resolve(server);
      });
    });
  }

  function releaseListener(server: Server): Promise<void> {
    return new Promise((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }

  /** Fills {@link slot}, {@link sentinel} and {@link slotReservation}, whose comment is the ground. */
  async function takeSlot(): Promise<void> {
    for (let candidate = SLOTS - 1; candidate >= 0; candidate -= 1) {
      const reservation = await bindOrNull(
        portFor('api', { slot: candidate, mode: 'development' })
      );
      if (reservation === null) continue;
      const candidateSentinel = portFor('idleDaemon', { slot: candidate, mode: 'development' });
      const free = await bindOrNull(candidateSentinel);
      if (free === null) {
        await releaseListener(reservation);
        continue;
      }
      await releaseListener(free);
      slot = candidate;
      sentinel = candidateSentinel;
      slotReservation = reservation;
      return;
    }
    throw new Error('no slot of the port plan is free, so this suite cannot take one');
  }

  /**
   * Waits for the daemon this block has spawned to reach a state the cases
   * measure. A readiness wait for our own child, never a liveness decision:
   * what the daemon is asked afterwards is the lock, and the lock answers
   * immediately.
   *
   * What ends the wait is observed rather than counted. While the process that
   * would produce the state is running the state is still on its way, so the
   * only other outcome is that the process is gone — and `producer` is tsx's
   * CLI, which exits when the daemon it launched does, so a daemon that dies
   * before binding ends this wait rather than leaving it to a number. A count
   * would instead price the sleeping and nothing else: it says nothing about
   * the reads and timer deliveries between the sleeps, so its span stays near
   * its own floor however long the cold tsx compile of the daemon's module
   * graph actually takes, and enlarging the number only moves that floor.
   * {@link COLD_FIXTURE_BUDGET_MS} on the hook is the whole bound on the
   * waiting.
   *
   * Liveness is read before the state and not after, so a daemon that reached
   * the state and then exited is still read as having reached it.
   */
  async function waitUntil(producer: ChildProcess, ready: () => Promise<boolean>): Promise<void> {
    for (;;) {
      const gone = producer.exitCode !== null || producer.signalCode !== null;
      if (await ready()) return;
      if (gone) throw new Error('the daemon exited before it reached the state the cases need');
      await sleep(100);
    }
  }

  beforeAll(async () => {
    await takeSlot();
    registryDir = mkdtempSync(path.join(tmpdir(), 'hb-daemon-registry-'));
    const tickerDir = fileURLToPath(new URL('.', import.meta.url));
    const entryPath = path.join(tickerDir, 'idle-killer-daemon-entry.ts');

    child = spawn(
      process.execPath,
      [
        resolveTsxCliPath(),
        entryPath,
        '--port',
        String(sentinel),
        '--slot',
        String(slot),
        '--registry-dir',
        registryDir,
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
        },
      }
    );

    await waitUntil(child, () => isDaemonAlive(sentinel));
    await waitUntil(child, async () => {
      const probe = await tryLock(daemonIdentityLockPath(sentinel, registryDir));
      return probe.held;
    });
  }, COLD_FIXTURE_BUDGET_MS);

  afterAll(async () => {
    // Kill the entire process group (negative pid). The outer node + the
    // tsx-spawned inner daemon both belong to it, so a single SIGKILL ends
    // both. Without this, tsx's child node survives a plain child.kill().
    if (child?.pid !== undefined) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* group may already be gone if the child died first */
      }
    }
    await new Promise<void>((resolve) => {
      // Nothing to wait for when the spawn never happened, or when the process
      // has already been reaped.
      if (child?.exitCode !== null) {
        resolve();
        return;
      }
      child.once('exit', () => {
        resolve();
      });
    });
    rmSync(registryDir, { recursive: true, force: true });
    // Last, and only when the slot was taken: a block whose slot search found
    // nothing has a named failure to report, and closing an absent listener
    // would bury it under a second one.
    if (slotReservation !== undefined) await releaseListener(slotReservation);
  }, STARVED_HOOK_BUDGET_MS);

  it('binds the singleton port when launched via node + tsx CLI', async () => {
    await expect(isDaemonAlive(sentinel)).resolves.toBe(true);
  });

  it('keeps the claim that identifies it in the registry directory it was handed', async () => {
    await expect(tryLock(daemonIdentityLockPath(sentinel, registryDir))).resolves.toMatchObject({
      held: true,
    });
  });
});

describe('ensureDaemonRunning', () => {
  it('is a no-op when a daemon is already alive', async () => {
    const spawn = vi.fn() as unknown as SpawnFunction;
    await ensureDaemonRunning({
      port: 1234,
      cacheDir: workDir,
      daemonScriptPath: '/fake/daemon.ts',
      slot: 1,
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

  it('passes tsx CLI as argv[0] so the .ts daemon entry actually loads', async () => {
    const spawn = vi.fn().mockReturnValue({ unref: vi.fn() }) as unknown as SpawnFunction;
    await ensureDaemonRunning({
      port: 1234,
      cacheDir: workDir,
      daemonScriptPath: '/fake/daemon.ts',
      slot: 0,
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

  it('hands the daemon an environment naming no spawner, so nothing it starts can arm on one', async () => {
    const spawn = vi.fn().mockReturnValue({ unref: vi.fn() }) as unknown as SpawnFunction;
    vi.stubEnv(LIFELINE_ENV, path.join(workDir, 'hb-0123456789'));

    await ensureDaemonRunning({
      port: 1234,
      cacheDir: workDir,
      daemonScriptPath: '/fake/daemon.ts',
      slot: 7,
      spawn,
      isAlive: () => Promise.resolve(false),
    });

    const call = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string[],
      { env: NodeJS.ProcessEnv },
    ];
    const options = call[2];
    // Absent rather than empty: an address that is present and names nothing is
    // the failure the spawn module raises on, and a daemon is the head of its
    // own chain rather than a spawner that lost its socket.
    expect(LIFELINE_ENV in options.env).toBe(false);
    // The rest of the environment still reaches it, or the daemon would lose the
    // stack it was launched for.
    expect(options.env['PATH']).toBe(process.env['PATH']);
  });

  it('hands the daemon an environment naming no run claim, so it records against no run but its own', async () => {
    const spawn = vi.fn().mockReturnValue({ unref: vi.fn() }) as unknown as SpawnFunction;
    vi.stubEnv(RUN_CLAIM_ENV, path.join(workDir, 'a-run-record'));

    await ensureDaemonRunning({
      port: 1234,
      cacheDir: workDir,
      daemonScriptPath: '/fake/daemon.ts',
      slot: 7,
      spawn,
      isAlive: () => Promise.resolve(false),
    });

    const call = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string[],
      { env: NodeJS.ProcessEnv },
    ];

    expect(RUN_CLAIM_ENV in call[2].env).toBe(false);
  });

  it('rechecks isAlive after acquiring the launch claim (covers the race)', async () => {
    let aliveCallCount = 0;
    const spawn = vi.fn() as unknown as SpawnFunction;
    await ensureDaemonRunning({
      port: 1234,
      cacheDir: workDir,
      daemonScriptPath: '/fake/daemon.ts',
      slot: 1,
      spawn,
      // First call (pre-claim) returns false; second call (post-claim) returns
      // true to simulate a sibling having just spawned.
      isAlive: () => {
        aliveCallCount++;
        return Promise.resolve(aliveCallCount >= 2);
      },
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(aliveCallCount).toBe(2);
  });

  it('surfaces what the spawn raised rather than swallowing it with the claim', async () => {
    const spawn = vi.fn(() => {
      throw new Error('spawn refused');
    }) as unknown as SpawnFunction;
    await expect(
      ensureDaemonRunning({
        port: 1234,
        cacheDir: workDir,
        daemonScriptPath: '/fake/daemon.ts',
        slot: 1,
        spawn,
        isAlive: () => Promise.resolve(false),
      })
    ).rejects.toThrow('spawn refused');
  });

  it('leaves the launch claim free once it returns, so the next launcher is not refused', async () => {
    const lockPath = path.join(workDir, 'daemon.lock');
    const spawn = vi.fn().mockReturnValue({ unref: vi.fn() }) as unknown as SpawnFunction;
    await ensureDaemonRunning({
      port: 1234,
      cacheDir: workDir,
      daemonScriptPath: '/fake/daemon.ts',
      slot: 1,
      spawn,
      isAlive: () => Promise.resolve(false),
      lockPath,
    });

    expect(existsSync(lockPath)).toBe(true);
    expect(await tryLock(lockPath)).toEqual({ held: false, holder: null });
  });

  it('surfaces a launch lock path that cannot be opened at all', async () => {
    const lockPath = path.join(workDir, 'daemon.lock');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(lockPath);
    const spawn = vi.fn() as unknown as SpawnFunction;

    await expect(
      ensureDaemonRunning({
        port: 1234,
        cacheDir: workDir,
        daemonScriptPath: '/fake/daemon.ts',
        slot: 1,
        spawn,
        isAlive: () => Promise.resolve(false),
        lockPath,
      })
    ).rejects.toMatchObject({ code: 'EISDIR' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('spawns past a launch lock file whose launcher is long gone', async () => {
    const lockPath = path.join(workDir, 'daemon.lock');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(lockPath, 'a launcher that crashed');
    const spawn = vi.fn().mockReturnValue({ unref: vi.fn() }) as unknown as SpawnFunction;

    await ensureDaemonRunning({
      port: 1234,
      cacheDir: workDir,
      daemonScriptPath: '/fake/daemon.ts',
      slot: 1,
      spawn,
      isAlive: () => Promise.resolve(false),
      lockPath,
    });

    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe('what a stack bring-up says about a daemon whose teardown is failing', () => {
  const failure = { consecutiveFailures: 12, exitCode: 1, reason: 'a variable with no value' };

  async function ensureBesideEvidence(
    reported: string[],
    options: { readonly alive?: boolean } = {}
  ): Promise<SpawnFunction> {
    const spawn = vi.fn().mockReturnValue({ unref: vi.fn() }) as unknown as SpawnFunction;
    await ensureDaemonRunning({
      port: 1234,
      cacheDir: workDir,
      daemonScriptPath: '/fake/daemon.ts',
      slot: 3,
      spawn,
      isAlive: () => Promise.resolve(options.alive ?? true),
      registryDir: workDir,
      log: (message) => reported.push(message),
    });
    return spawn;
  }

  it('reads the evidence out loud, so nobody has to know the record exists', async () => {
    await recordTeardownFailure(1234, failure, workDir);
    const reported: string[] = [];

    await ensureBesideEvidence(reported);

    expect(reported).toEqual([describeTeardownFailure(1234, 3, failure)]);
  });

  it('says nothing about a daemon whose teardowns have not failed', async () => {
    const reported: string[] = [];

    await ensureBesideEvidence(reported);

    expect(reported).toEqual([]);
  });

  it('reports the port it was asked about and no other', async () => {
    await recordTeardownFailure(4321, failure, workDir);
    const reported: string[] = [];

    await ensureBesideEvidence(reported);

    expect(reported).toEqual([]);
  });

  it('reports before it decides whether a daemon has to be spawned at all', async () => {
    await recordTeardownFailure(1234, failure, workDir);
    const reported: string[] = [];

    const spawn = await ensureBesideEvidence(reported, { alive: false });

    expect(reported).toHaveLength(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('warns on standard error when the caller named no channel of its own', async () => {
    await recordTeardownFailure(1234, failure, workDir);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await ensureDaemonRunning({
        port: 1234,
        cacheDir: workDir,
        daemonScriptPath: '/fake/daemon.ts',
        slot: 3,
        spawn: vi.fn() as unknown as SpawnFunction,
        isAlive: () => Promise.resolve(true),
        registryDir: workDir,
      });
      expect(warn).toHaveBeenCalledWith(describeTeardownFailure(1234, 3, failure));
    } finally {
      warn.mockRestore();
    }
  });

  it('ends nothing and claims nothing on the strength of what it read', async () => {
    await recordTeardownFailure(1234, failure, workDir);
    const reported: string[] = [];

    const spawn = await ensureBesideEvidence(reported);

    // The whole of what an observation may do: say so. A daemon reported here
    // is left running, exactly as one with nothing to report is.
    expect(spawn).not.toHaveBeenCalled();
    expect(await readTeardownFailure(1234, workDir)).toEqual(failure);
  });
});
