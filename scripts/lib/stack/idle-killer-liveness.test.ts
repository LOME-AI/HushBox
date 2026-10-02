import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HELD_CLAIMS_ENV } from '../claims/claim.js';
import { RUN_CLAIM_ENV } from '../claims/registry.js';
import { ensureDaemonRunning, type SpawnFunction } from './idle-killer.js';
import { daemonLoop, liveClaimCount, type DaemonDeps } from './idle-killer-daemon.js';
import { portFor, SLOTS } from './port-plan.js';
import type { Readable, Writable } from 'node:stream';

/**
 * What the daemon decides is a kernel fact about other processes, so only real
 * ones can produce it. Both fixtures run through tsx's loader in-process
 * (`--import`) rather than through its CLI, which forks: a signal has to reach
 * the process that actually holds the lock.
 */
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const RUN_ENTRY = fileURLToPath(new URL('../claims/registry-run-entry.mjs', import.meta.url));
const CLAIM_ENTRY = fileURLToPath(new URL('../claims/claim-holder-entry.mjs', import.meta.url));

/** What `spawn` returns for the fixtures' `['pipe', 'pipe', 'inherit']` streams. */
type Fixture = ChildProcessByStdio<Writable, Readable, null>;

const SLOT = 41;

/**
 * What a case that spawns a fixture may spend, far above the runner's default.
 *
 * Plainly a larger budget rather than a cleverer instrument, because nothing
 * observable shortens what it covers. Every fixture here boots through tsx,
 * which compiles its whole module graph cold: a fraction of a second on an idle
 * machine, tens of seconds when many suites share one, after which the rest of
 * the file runs off a warm cache. The runner's default is sized for cases that
 * spawn nothing, so it is the first bound to lose when the host is busy, and
 * the loss reads as a broken mechanism rather than a slow one.
 * `idle-daemon-teardown-evidence.test.ts` carries the same budget for the same
 * boot.
 *
 * A bound on waiting and nothing else: the waits below end on a line the
 * fixture printed or on its exit, never on a clock.
 */
const COLD_FIXTURE_BUDGET_MS = 60_000;

/**
 * What a hook here may spend, far above the runner's default.
 *
 * The bodies these cover are trivial — a temporary directory made and removed,
 * a listener closed, a signalled fixture reaped — and none of them waits for a
 * fixture to become ready. What they lose to is the host: when many suites run
 * at once a worker can go without a turn for longer than the runner allows a
 * hook, and the failure is then reported against whichever case the hook
 * belonged to rather than against anything that was slow.
 *
 * A bound on waiting and nothing else: a hook that genuinely hangs still fails,
 * later.
 */
const STARVED_HOOK_BUDGET_MS = 60_000;

let workDir: string;
let registryDir: string;
let fixtures: Fixture[];
let listeners: Server[];

function waitForExit(child: Fixture): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => {
      resolve();
    });
  });
}

/** Resolves on the fixture's first line, so its claim is taken before we look. */
function firstLine(child: Fixture): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let seen = '';
    child.stdout.on('data', (chunk: Buffer) => {
      seen += chunk.toString();
      const newline = seen.indexOf('\n');
      if (newline !== -1) resolve(seen.slice(0, newline));
    });
    child.once('error', reject);
    child.once('exit', () => {
      reject(new Error('the fixture exited before it took its claim'));
    });
  });
}

/**
 * A fixture must lead its own process group on POSIX, or `SIGSTOP` suspends the
 * test runner with it: a stopped member of the runner's own group takes the
 * runner down. On Windows `detached` would remove the job object libuv
 * otherwise gives a child, which is the only automatic cleanup available there.
 */
function fixtureSpawnOptions(platform: NodeJS.Platform): { readonly detached: boolean } {
  return { detached: platform !== 'win32' };
}

async function startRun(): Promise<Fixture> {
  const child = spawn(
    process.execPath,
    [
      '--import',
      TSX_LOADER,
      RUN_ENTRY,
      registryDir,
      'pnpm dev',
      'development',
      String(SLOT),
      path.join(registryDir, 'checkout', '.git'),
      'hold',
    ],
    {
      // Neither the run nor the claims this process inherited: a fixture that
      // adopted the test runner's own run would register nothing of its own,
      // and one granted its parent's claims would report holding a lock it
      // never took.
      env: { ...process.env, [HELD_CLAIMS_ENV]: '', [RUN_CLAIM_ENV]: '' },
      stdio: ['pipe', 'pipe', 'inherit'],
      ...fixtureSpawnOptions(process.platform),
    }
  );
  fixtures.push(child);
  await firstLine(child);
  return child;
}

async function startLaunchHolder(lockPath: string): Promise<Fixture> {
  const child = spawn(
    process.execPath,
    [
      '--import',
      TSX_LOADER,
      CLAIM_ENTRY,
      lockPath,
      'the idle daemon',
      'a rival launcher',
      'refuse',
    ],
    {
      // Never the claims this process inherited: a holder that believed it had
      // already been granted the lock would report `held` without taking one.
      env: { ...process.env, [HELD_CLAIMS_ENV]: '' },
      stdio: ['pipe', 'pipe', 'inherit'],
      ...fixtureSpawnOptions(process.platform),
    }
  );
  fixtures.push(child);
  expect(await firstLine(child)).toBe('held');
  return child;
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

/**
 * Takes a slot by binding one of its own allocated ports, and answers which
 * slot it got. The port comes from the plan rather than being kernel-assigned,
 * because a probe of a slot's ports can only read the ports that slot allocates:
 * a listener on any other number would satisfy the assertion without any such
 * probe having been able to see it, which is the whole of what this case guards.
 *
 * Which slot is not decided in advance, because a number chosen in advance is
 * one every run of this file binds at once. The bind is the exclusion — the
 * kernel refuses the second binder — and it is held until the case is over, so
 * there is no window in which two runs could hold one slot. Slots are issued
 * lowest-free, so the search runs downward, away from the ones checkouts hold.
 */
async function holdSlotPort(): Promise<number> {
  for (let slot = SLOTS - 1; slot >= 0; slot -= 1) {
    const server = await bindOrNull(portFor('api', { slot, mode: 'development' }));
    if (server === null) continue;
    listeners.push(server);
    return slot;
  }
  throw new Error(
    'every slot of the port plan has its api port bound, so this case cannot take one'
  );
}

function releaseSlotPort(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

async function kill(child: Fixture): Promise<void> {
  // SIGCONT first: a frozen process never observes SIGKILL until it runs.
  child.kill('SIGCONT');
  child.kill('SIGKILL');
  await waitForExit(child);
}

/** One pass of the loop against the real registry, with nothing real torn down. */
function daemonDeps(overrides: Partial<DaemonDeps> = {}): DaemonDeps {
  return {
    bindSingleton: vi.fn().mockResolvedValue({ close: vi.fn() }),
    holdIdentity: (_port, _slot, body) => body(),
    liveClaimCount: (slot: number) => liveClaimCount(slot, registryDir),
    composeDown: vi.fn(() => Promise.resolve({ exitCode: 0, output: '' })),
    recordTeardownFailure: vi.fn(() => Promise.resolve()),
    clearTeardownFailure: vi.fn(() => Promise.resolve()),
    sleep: vi.fn(() => Promise.reject(new Error('halt-test'))),
    log: vi.fn(),
    ...overrides,
  };
}

function daemonOptions(): Parameters<typeof daemonLoop>[0] {
  return {
    port: 0,
    slot: SLOT,
    pollMs: 0,
    graceWindowPolls: 1,
    composeProject: 'hushbox-stub-project',
    repoRoot: workDir,
  };
}

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-idle-liveness-'));
  registryDir = path.join(workDir, 'claims');
  await fs.mkdir(registryDir, { recursive: true });
  fixtures = [];
  listeners = [];
}, STARVED_HOOK_BUDGET_MS);

afterEach(async () => {
  for (const child of fixtures) await kill(child);
  for (const server of listeners) await releaseSlotPort(server);
  await fs.rm(workDir, { recursive: true, force: true });
}, STARVED_HOOK_BUDGET_MS);

describe('the slot predicate, against real runs', { timeout: COLD_FIXTURE_BUDGET_MS }, () => {
  it('leaves the slot alone while a run holds a claim on it', async () => {
    await startRun();
    const deps = daemonDeps();

    await expect(daemonLoop(daemonOptions(), deps)).rejects.toThrow('halt-test');

    expect(deps.composeDown).not.toHaveBeenCalled();
  });

  it('leaves the slot alone while its run is frozen rather than finished', async () => {
    const run = await startRun();
    // A frozen run writes nothing, so anything reading a clock reports it dead
    // and tears down a stack in use. Its lock is a kernel fact and outlives the
    // freeze.
    run.kill('SIGSTOP');
    const deps = daemonDeps();

    await expect(daemonLoop(daemonOptions(), deps)).rejects.toThrow('halt-test');

    expect(deps.composeDown).not.toHaveBeenCalled();
    run.kill('SIGCONT');
  });

  it('tears the slot down once the run holding it has been killed', async () => {
    const run = await startRun();
    await kill(run);
    const deps = daemonDeps();

    const result = await daemonLoop(daemonOptions(), deps);

    expect(deps.composeDown).toHaveBeenCalledWith('hushbox-stub-project', workDir);
    expect(result.exitReason).toBe('idle-teardown');
  });

  /**
   * A record can be damaged while the run it describes is still holding its
   * lock, and the lock is what says the run is alive. A pass that read the
   * damaged record and reported no claim would have this daemon tear down the
   * stack that run is using — the failure this predicate exists to prevent,
   * arriving through the one path nothing would suspect.
   */
  it('leaves the slot alone while the run holding it has a record nothing can read', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await startRun();
    const present = await fs.readdir(registryDir);
    const runDir = path.join(registryDir, present.find((name) => !name.endsWith('.lock')) ?? '');
    await fs.writeFile(path.join(runDir, 'run.json'), '{ not json');
    const deps = daemonDeps();

    await expect(daemonLoop(daemonOptions(), deps)).rejects.toThrow('halt-test');

    expect(deps.composeDown).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('counts a run on another slot as no reason to keep this one', async () => {
    await startRun();
    const deps = daemonDeps();

    const result = await daemonLoop({ ...daemonOptions(), slot: SLOT + 1 }, deps);

    expect(result.exitReason).toBe('idle-teardown');
  });
});

describe('the port probe the predicate no longer consults', () => {
  it('tears the slot down while a leaked process still holds one of its ports', async () => {
    // The deadlock this predicate was rewritten to break: a listener on the
    // slot's ports used to veto teardown, so a child leaked by a dead run made
    // the slot look busy and permanently blocked the reclaimer whose whole job
    // was to clean up after that child. Nothing claims the slot here, so the
    // listener is the only thing that could hold it.
    const slot = await holdSlotPort();
    const deps = daemonDeps();

    const result = await daemonLoop({ ...daemonOptions(), slot }, deps);

    expect(deps.composeDown).toHaveBeenCalledWith('hushbox-stub-project', workDir);
    expect(result.exitReason).toBe('idle-teardown');
  });
});

describe(
  'the daemon launch claim, against real launchers',
  { timeout: COLD_FIXTURE_BUDGET_MS },
  () => {
    it('does not spawn a second daemon while a live launcher holds the claim', async () => {
      const lockPath = path.join(workDir, 'daemon.lock');
      await startLaunchHolder(lockPath);
      const daemonSpawn = vi.fn() as unknown as SpawnFunction;

      await ensureDaemonRunning({
        port: 1234,
        cacheDir: workDir,
        daemonScriptPath: path.join(workDir, 'daemon.ts'),
        slot: SLOT,
        spawn: daemonSpawn,
        isAlive: () => Promise.resolve(false),
        lockPath,
      });

      expect(daemonSpawn).not.toHaveBeenCalled();
    });

    it('does not spawn a second daemon while the launcher holding the claim is frozen', async () => {
      const lockPath = path.join(workDir, 'daemon.lock');
      const holder = await startLaunchHolder(lockPath);
      holder.kill('SIGSTOP');
      const daemonSpawn = vi.fn() as unknown as SpawnFunction;

      await ensureDaemonRunning({
        port: 1234,
        cacheDir: workDir,
        daemonScriptPath: path.join(workDir, 'daemon.ts'),
        slot: SLOT,
        spawn: daemonSpawn,
        isAlive: () => Promise.resolve(false),
        lockPath,
      });

      expect(daemonSpawn).not.toHaveBeenCalled();
      holder.kill('SIGCONT');
    });

    it('spawns as soon as the launcher holding the claim is killed', async () => {
      const lockPath = path.join(workDir, 'daemon.lock');
      const holder = await startLaunchHolder(lockPath);
      await kill(holder);
      const daemonSpawn = vi.fn().mockReturnValue({ unref: vi.fn() }) as unknown as SpawnFunction;

      await ensureDaemonRunning({
        port: 1234,
        cacheDir: workDir,
        daemonScriptPath: path.join(workDir, 'daemon.ts'),
        slot: SLOT,
        spawn: daemonSpawn,
        isAlive: () => Promise.resolve(false),
        lockPath,
      });

      expect(daemonSpawn).toHaveBeenCalledTimes(1);
    });
  }
);

describe('the fixture harness platform branch', () => {
  // Both cases prove which branch a platform string selects, and nothing about
  // how either operating system behaves: nothing in this suite runs on Windows.
  it('gives a POSIX fixture a process group of its own', () => {
    expect(fixtureSpawnOptions('linux')).toEqual({ detached: true });
  });

  it('leaves a Windows fixture in the job object libuv gives it', () => {
    expect(fixtureSpawnOptions('win32')).toEqual({ detached: false });
  });
});
