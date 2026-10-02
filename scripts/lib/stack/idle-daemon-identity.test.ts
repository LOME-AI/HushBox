import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HELD_CLAIMS_ENV, claim, tryLock } from '../claims/claim.js';
import { RUN_CLAIM_ENV } from '../claims/registry.js';
import {
  auditExitCode,
  auditWorld,
  scanWorld,
  type AuditLine,
  type AuditedStack,
  type WorldScanDeps,
} from '../claims/world-audit.js';
import { NO_AGE_SOURCE } from '../claims/world-scan.js';
import { readOwnership } from '../claims/ownership.js';
import { canonicalPath } from '../canonical-path.js';
import { daemonIdentityLockPath, holdIdentity, parseDaemonIdentity } from './idle-killer-daemon.js';
import { ensureDaemonRunning, type SpawnFunction } from './idle-killer.js';
import { portFor, SLOTS } from './port-plan.js';
import type { DaemonIdentityRecord } from './idle-killer-daemon.js';

/**
 * Identity is a fact about a running process, so only a running process can
 * produce it. The daemon runs through tsx's loader in-process (`--import`)
 * rather than through its CLI, which forks: a signal has to reach the process
 * that actually holds the lock.
 */
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const DAEMON_ENTRY = fileURLToPath(new URL('idle-killer-daemon-entry.ts', import.meta.url));

/**
 * The slot this file has taken, and the sentinel port that belongs to it. Every
 * case here needs the plan's own sentinel rather than a number the kernel hands
 * out: the audit reads a slot back out of the port number, and a port outside
 * the plan carries none, so nothing could be asked about the daemon on it.
 *
 * Which slot is taken rather than named in advance, because a number named in
 * advance is one every run of this file binds at once — two runs would put two
 * daemons on one port and the second would lose the bind. What holds the slot
 * is a listener on another of its ports, held for the whole file; the sentinel
 * cannot hold it, because the daemons under test are what bind that. A slot
 * whose sentinel something already holds is passed over. Slots are issued
 * lowest-free, so the search runs downward, away from the ones checkouts hold,
 * and stops one above the bottom so that the case naming a slot this port does
 * not belong to always has a real one below.
 */
let slot: number;
let sentinel: number;
let slotReservation: Server;

/** A project name no compose file declares, so a teardown would find nothing. */
const STUB_PROJECT = 'hushbox-identity-suite-stub';

/**
 * What a case that spawns a daemon may spend, far above the runner's default.
 *
 * Plainly a larger budget rather than a cleverer instrument, because nothing
 * observable shortens what it covers. Every daemon here boots through tsx,
 * which compiles its whole module graph cold: a fraction of a second on an idle
 * machine, tens of seconds when many suites share one, after which the rest of
 * the file runs off a warm cache. The runner's default is sized for cases that
 * spawn nothing, so it is the first bound to lose when the host is busy, and
 * the loss reads as a broken mechanism rather than a slow one.
 * `idle-daemon-teardown-evidence.test.ts` carries the same budget for the same
 * boot.
 *
 * A bound on waiting and nothing else: what the cases read is what the daemon
 * states about itself, never the time it took to state it.
 */
const COLD_FIXTURE_BUDGET_MS = 60_000;

/**
 * What a hook here may spend, far above the runner's default.
 *
 * The bodies these cover are trivial — a temporary directory made and removed,
 * a listener closed, a signalled daemon reaped — and none of them waits for a
 * daemon to become ready. What they lose to is the host: when many suites run
 * at once a worker can go without a turn for longer than the runner allows a
 * hook, and the failure is then reported against whichever case the hook
 * belonged to rather than against anything that was slow.
 *
 * A bound on waiting and nothing else: a hook that genuinely hangs still fails,
 * later.
 */
const STARVED_HOOK_BUDGET_MS = 60_000;

/**
 * The checkout a daemon spawned from this entry reports, derived the way the
 * entry derives it: the repository root is three directories above the entry.
 */
const CHECKOUT = canonicalPath(path.resolve(path.dirname(DAEMON_ENTRY), '..', '..', '..'));

let repoRoot: string;
let registryDir: string;
let daemons: ChildProcess[];
let listeners: Server[];

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

/** Fills {@link slot}, {@link sentinel} and {@link slotReservation}, whose comment is the ground. */
async function takeSlot(): Promise<void> {
  for (let candidate = SLOTS - 1; candidate >= 1; candidate -= 1) {
    const reservation = await bindOrNull(portFor('api', { slot: candidate, mode: 'development' }));
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
 * A fixture must lead its own process group on POSIX, or a signal aimed at it
 * can reach the test runner. On Windows `detached` would remove the job object
 * libuv otherwise gives a child, which is the only automatic cleanup there.
 */
function fixtureSpawnOptions(platform: NodeJS.Platform): { readonly detached: boolean } {
  return { detached: platform !== 'win32' };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Waits for a process this test has just spawned to reach the state the case
 * measures. A readiness wait for our own child, never a liveness decision: what
 * the daemon is asked afterwards is the lock, and the lock answers immediately.
 *
 * What ends the wait is observed rather than counted. While `producer` is
 * running the state is still on its way, so the only other outcome is that the
 * process which would have produced it is gone. A count would instead price the
 * sleeping and nothing else: it says nothing about the reads and timer
 * deliveries between the sleeps, so its span stays near its own floor however
 * long the cold `node --import tsx` boot actually takes, and enlarging the
 * number only moves that floor. {@link COLD_FIXTURE_BUDGET_MS} on the case is
 * the whole bound on the waiting.
 *
 * Liveness is read before the state and not after, so a fixture that reached
 * the state and then exited is still read as having reached it.
 */
async function waitUntil(producer: ChildProcess, ready: () => Promise<boolean>): Promise<void> {
  for (;;) {
    const gone = producer.exitCode !== null || producer.signalCode !== null;
    if (await ready()) return;
    if (gone) throw new Error('the fixture exited before it reached the state the case needs');
    await sleep(50);
  }
}

/**
 * The real daemon, spawned the way `ensureDaemonRunning` spawns one, except
 * that its claims go to a registry of this suite's own: a fixture writing into
 * the machine-wide one would leave a lock file behind on every run.
 */
async function startDaemon(
  options: { readonly composeProject?: string; readonly slot?: number } = {}
): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [
      '--import',
      TSX_LOADER,
      DAEMON_ENTRY,
      '--port',
      String(sentinel),
      '--slot',
      String(options.slot ?? slot),
      '--registry-dir',
      registryDir,
    ],
    {
      env: {
        ...process.env,
        // Neither the run nor the claims this process inherited: a daemon
        // granted its parent's claims would report holding a lock it never
        // took. The project name is passed rather than generated, so the only
        // stack this daemon could ever tear down is one that does not exist.
        [HELD_CLAIMS_ENV]: '',
        [RUN_CLAIM_ENV]: '',
        COMPOSE_PROJECT_NAME: options.composeProject ?? STUB_PROJECT,
      },
      stdio: 'ignore',
      ...fixtureSpawnOptions(process.platform),
    }
  );
  daemons.push(child);
  await waitUntil(child, async () => {
    const probe = await identityProbe(registryDir);
    return probe.held;
  });
  return child;
}

/** What the daemon's own claim says about the port, wherever it is kept. */
function identityProbe(dir?: string): Promise<{ held: boolean; holder: string | null }> {
  return tryLock(daemonIdentityLockPath(sentinel, dir));
}

/** Something that holds the port and proves nothing, which is the whole point. */
async function holdSentinelPort(): Promise<void> {
  const server = createServer();
  listeners.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(sentinel, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => {
      resolve();
    });
  });
  child.kill('SIGKILL');
  await exited;
}

function releaseListener(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

/** What a pass audits for when the stack under test is the daemon's own. */
function ownStack(overrides: Partial<AuditedStack> = {}): AuditedStack {
  return { composeProject: STUB_PROJECT, checkout: CHECKOUT, ...overrides };
}

/** The audit of a world in which the only thing running is the sentinel port. */
function scan(stack: AuditedStack = ownStack()): WorldScanDeps {
  return {
    repoRoot,
    // A scratch RAM filesystem, so the pass reads none of the machine's.
    ramHost: { platform: 'linux', parent: path.join(repoRoot, 'shm') },
    stack,
    containers: () => Promise.resolve([]),
    containerAges: NO_AGE_SOURCE,
    stuckContainers: () => Promise.resolve([]),
    databases: () => Promise.resolve([]),
    buckets: () => Promise.resolve([]),
    listeningPorts: () => Promise.resolve([sentinel]),
    listenerAge: NO_AGE_SOURCE,
    lifelineSockets: () => Promise.resolve([]),
    // Nothing of this suite is a compose project: every case here is about what
    // holds one sentinel port.
    composeProjects: () =>
      Promise.resolve({
        ownerships: [],
        activeWorktreePaths: [],
        repoCommonDir: CHECKOUT,
        slotOfWorktree: () => null,
      }),
  };
}

/** The one line the audit of that world produces. */
async function auditSentinel(stack: AuditedStack = ownStack()): Promise<AuditLine> {
  const lines = auditWorld(
    await scanWorld(scan(stack), registryDir),
    await readOwnership(registryDir)
  );
  return lines[0]!;
}

beforeAll(takeSlot, STARVED_HOOK_BUDGET_MS);

afterAll(async () => {
  await releaseListener(slotReservation);
}, STARVED_HOOK_BUDGET_MS);

beforeEach(async () => {
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-identity-root-'));
  registryDir = path.join(repoRoot, 'claims');
  await fs.mkdir(registryDir, { recursive: true });
  daemons = [];
  listeners = [];
}, STARVED_HOOK_BUDGET_MS);

afterEach(async () => {
  for (const child of daemons) await stop(child);
  for (const server of listeners) await releaseListener(server);
  await fs.rm(repoRoot, { recursive: true, force: true });
}, STARVED_HOOK_BUDGET_MS);

describe('the claim a daemon identifies itself with', () => {
  function identityOf(): DaemonIdentityRecord {
    return { slot, composeProject: STUB_PROJECT, repoRoot: CHECKOUT, pid: 4242 };
  }

  it('is held for as long as the daemon is running and free once it is over', async () => {
    let heldInside = false;

    await holdIdentity(
      sentinel,
      identityOf(),
      async () => {
        const probe = await identityProbe(registryDir);
        heldInside = probe.held;
      },
      registryDir
    );

    const afterwards = await identityProbe(registryDir);

    expect(heldInside).toBe(true);
    expect(afterwards.held).toBe(false);
  });

  it('carries the project, the checkout and the slot of the daemon holding it', async () => {
    let holder: string | null = null;

    await holdIdentity(
      sentinel,
      identityOf(),
      async () => {
        const probe = await identityProbe(registryDir);
        holder = probe.holder;
      },
      registryDir
    );

    expect(parseDaemonIdentity(holder)).toEqual(identityOf());
  });
});

describe(
  'the auditor against what is really on the sentinel port',
  { timeout: COLD_FIXTURE_BUDGET_MS },
  () => {
    it('recognises a running daemon of this stack and asks nobody to act on it', async () => {
      await startDaemon();

      const line = await auditSentinel();

      expect(line).toMatchObject({
        kind: 'port',
        id: String(sentinel),
        daemonIdentity: { kind: 'this-stack' },
      });
      expect(auditExitCode([line], [])).toBe(0);
    });

    it('reports a running daemon that would tear down a project this stack has moved off', async () => {
      // The case with a corpse: the environment was regenerated under a daemon
      // that captured its compose project at spawn, so what it would tear down is
      // no longer what this stack is.
      await startDaemon({ composeProject: 'hushbox-before-the-environment-was-regenerated' });

      const line = await auditSentinel();

      expect(line.daemonIdentity).toMatchObject({
        kind: 'other-stack',
        differences: [expect.stringContaining('hushbox-before-the-environment-was-regenerated')],
      });
      expect(auditExitCode([line], [])).toBe(1);
    });

    it('reports a running daemon proving itself on this port while watching another slot', async () => {
      const otherSlot = slot - 1;

      await startDaemon({ slot: otherSlot });

      const line = await auditSentinel();

      expect(line.daemonIdentity).toMatchObject({
        kind: 'other-stack',
        differences: [expect.stringContaining(`slot ${String(otherSlot)}`)],
      });
      expect(auditExitCode([line], [])).toBe(1);
    });

    it('reports a running daemon of a checkout this pass is not auditing for', async () => {
      await startDaemon();

      const line = await auditSentinel(ownStack({ checkout: repoRoot }));

      expect(line.daemonIdentity).toMatchObject({ kind: 'other-stack' });
      expect(auditExitCode([line], [])).toBe(1);
    });

    it('reports a daemon that holds the claim without stating any stack in it', async () => {
      // What every daemon built before a daemon stated its stack holds: a real
      // lock, held by a live process, carrying prose instead of a record.
      const line = await claim(
        { name: 'the idle daemon', lockPath: daemonIdentityLockPath(sentinel, registryDir) },
        { onHeld: 'refuse', holder: `idle daemon for slot ${String(slot)} (pid 4242)` },
        () => auditSentinel()
      );

      expect(line.daemonIdentity).toEqual({ kind: 'unstated' });
      expect(auditExitCode([line], [])).toBe(1);
    });

    it('reports a process that only holds the port', async () => {
      await holdSentinelPort();

      const line = await auditSentinel();

      expect(line).toMatchObject({
        id: String(sentinel),
        daemonIdentity: { kind: 'unidentified' },
      });
      expect(auditExitCode([line], [])).toBe(1);
    });

    it('stops recognising the daemon the moment it is killed', async () => {
      const daemon = await startDaemon();

      await stop(daemon);
      // The port is free now too, so the audit is given the reading it would have
      // taken while the daemon was still exiting: something on the port, nothing
      // holding the claim.
      const line = await auditSentinel();

      expect(line.daemonIdentity).toEqual({ kind: 'unidentified' });
    });
  }
);

describe('bringing a stack up beside a process that cannot identify itself', () => {
  it('treats the port as a running daemon and spawns nothing', async () => {
    // The rollout criterion: a daemon that predates identity holds the port and
    // proves nothing, and bring-up must not care. `ensureDaemonRunning` asks
    // the port whether a daemon is there, which is all it has ever asked, so an
    // unidentified holder is left running rather than replaced or ended.
    await holdSentinelPort();
    const daemonSpawn = vi.fn() as unknown as SpawnFunction;

    await ensureDaemonRunning({
      port: sentinel,
      cacheDir: repoRoot,
      daemonScriptPath: DAEMON_ENTRY,
      slot,
      spawn: daemonSpawn,
    });

    expect(daemonSpawn).not.toHaveBeenCalled();
  });
});

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
