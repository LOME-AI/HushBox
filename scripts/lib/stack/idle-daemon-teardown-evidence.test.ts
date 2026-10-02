import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HELD_CLAIMS_ENV, tryLock } from '../claims/claim.js';
import { RUN_CLAIM_ENV } from '../claims/registry.js';
import {
  daemonIdentityLockPath,
  parseDaemonIdentity,
  type DaemonIdentityRecord,
} from './idle-killer-daemon.js';
import { ensureDaemonRunning, type SpawnFunction } from './idle-killer.js';
import {
  readTeardownFailure,
  recordTeardownFailure,
  type TeardownFailure,
} from './idle-teardown-failure.js';
import { portFor, SLOTS } from './port-plan.js';

/**
 * A teardown that cannot succeed is a fact about a running process, so only a
 * running process can produce the evidence. The daemon runs through tsx's
 * loader in-process (`--import`) rather than through its CLI, which forks: the
 * process that holds the port has to be the one this suite can address.
 *
 * The fixture entry runs the real loop, the real singleton bind, the real
 * identity claim and the real record writer. The one thing it stands in for is
 * the teardown's own result, which is this mechanism's input rather than any
 * part of it — and standing it in is also what keeps a suite off `docker
 * compose down`, a command with nothing to prove here and a shared stack to
 * lose.
 */
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const FIXTURE_ENTRY = fileURLToPath(new URL('idle-teardown-fixture-entry.mjs', import.meta.url));

/**
 * The slot this file has taken, and the sentinel port that belongs to it.
 *
 * Taken at run time rather than named in advance: a number named in advance is
 * one every concurrent run of this file hands its daemon at once, and the
 * daemon that loses the singleton bind returns without ever polling, so the
 * cases that wait on its evidence never see any.
 *
 * The sentinel cannot be its own reservation, because the daemon under test is
 * what binds it — a port this process bound and released would be free again in
 * the gap before the child got there. What holds the slot is a listener on
 * another of its ports, held for the whole file, and the sentinel is then the
 * port the plan gives that slot. A slot whose sentinel something already holds
 * is passed over. Slots are issued lowest-free (`scripts/lib/claims/slot-claim.ts`
 * scans upward from zero), so the search runs downward, away from the ones
 * checkouts hold.
 */
let slot: number;
let sentinel: number;
/**
 * Undefined until {@link takeSlot} has one, which is what lets the release
 * below say nothing when the setup never got that far: an unguarded release
 * throws out of the hook and reports after the setup failure that caused it,
 * leaving the named error the one a reader has to scroll back for.
 */
let slotReservation: Server | undefined;

/** What compose says when the file it is handed refuses to interpolate. */
const PERMANENT_FAILURE = 'error: required variable HB_POSTGRES_PORT is missing a value';

/**
 * What a case here may spend waiting, far above the runner's default.
 *
 * Plainly a larger budget rather than a cleverer instrument, because nothing
 * observable shortens the wait it covers. Every case spawns `node --import
 * tsx`, and whichever case spawns first pays the loader's cold compile of the
 * fixture's whole module graph: a fraction of a second on an idle machine, but
 * tens of seconds when many suites share one, after which the rest of the file
 * runs off a warm cache in about as long as one of those seconds. The runner's
 * default bound is sized for cases that spawn nothing, so it is the first thing
 * to lose when the host is busy, and the loss reads as a broken mechanism
 * rather than a slow one. `idle-killer.test.ts` widened its own wait on the
 * same cold boot for the same reason.
 *
 * A bound on waiting and nothing else: the cases read the state the fixture
 * leaves, never the time it took to leave it.
 */
const COLD_FIXTURE_BUDGET_MS = 60_000;

let registryDir: string;
let daemons: ChildProcess[];

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Waits for a process this suite has just spawned to reach the state the case
 * measures. A readiness wait on our own child, never a liveness decision:
 * liveness is asked of the lock, which answers immediately.
 *
 * What ends the wait is observed rather than counted. A daemon whose teardown
 * cannot succeed polls for as long as it is alive, so while `producer` is alive
 * the state is still on its way and the only other outcome is that the process
 * which would have produced it is gone. An attempt budget here would instead be
 * a guess at how long a cold `node --import tsx` boot takes while many suites
 * share a host, and it is a guess that cannot be made safe by enlarging: the
 * attempts are not a span of time, because each read costs more the busier the
 * host is, so the same count spends wildly different amounts of waiting.
 * {@link COLD_FIXTURE_BUDGET_MS} is the whole bound on the wait; nothing here
 * decides anything from a clock.
 *
 * Liveness is read before the state and not after, so a producer that wrote the
 * state and then exited is still read as having produced it.
 */
async function waitUntil<T>(
  producer: ChildProcess,
  ready: () => Promise<T | undefined>
): Promise<T> {
  for (;;) {
    const gone = producer.exitCode !== null || producer.signalCode !== null;
    const answer = await ready();
    if (answer !== undefined) return answer;
    if (gone) throw new Error('the fixture exited before it reached the state the case needs');
    await sleep(25);
  }
}

/** The real daemon loop, in a real detached process, with a teardown result of our choosing. */
function startDaemon(teardown: {
  readonly exitCode: number;
  readonly output: string;
}): ChildProcess {
  const child = spawn(
    process.execPath,
    [
      '--import',
      TSX_LOADER,
      FIXTURE_ENTRY,
      '--port',
      String(sentinel),
      '--slot',
      String(slot),
      '--registry-dir',
      registryDir,
    ],
    {
      env: {
        ...process.env,
        // Neither the run nor the claims this process holds: a daemon granted
        // its parent's claims would report holding a lock it never took.
        [HELD_CLAIMS_ENV]: '',
        [RUN_CLAIM_ENV]: '',
        HB_FIXTURE_TEARDOWN_EXIT: String(teardown.exitCode),
        HB_FIXTURE_TEARDOWN_OUTPUT: teardown.output,
      },
      stdio: 'ignore',
      // A POSIX fixture leads its own group, or a signal aimed at it reaches the
      // test runner; on Windows `detached` would remove the job object libuv
      // otherwise gives a child.
      detached: process.platform !== 'win32',
    }
  );
  daemons.push(child);
  return child;
}

function evidence(): Promise<TeardownFailure | undefined> {
  return readTeardownFailure(sentinel, registryDir);
}

/**
 * What the daemon on the sentinel port states about itself, or nothing where no
 * live process holds the claim that identifies it.
 */
async function identity(): Promise<DaemonIdentityRecord | undefined> {
  const probe = await tryLock(daemonIdentityLockPath(sentinel, registryDir));
  return parseDaemonIdentity(probe.holder);
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

function exited(child: ChildProcess): Promise<void> {
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

// Every hook here carries the same budget the cases do. A suite's `timeout`
// option covers its cases and not its hooks, and the shared configuration sets
// only the test timeout, so a hook left bare waits on the runner's default —
// sized for hooks that spawn nothing, and the first thing to lose on a busy
// host to the same cold `node --import tsx` boot {@link COLD_FIXTURE_BUDGET_MS}
// describes.
beforeAll(takeSlot, COLD_FIXTURE_BUDGET_MS);

afterAll(async () => {
  if (slotReservation !== undefined) await releaseListener(slotReservation);
}, COLD_FIXTURE_BUDGET_MS);

beforeEach(async () => {
  registryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-teardown-registry-'));
  daemons = [];
}, COLD_FIXTURE_BUDGET_MS);

afterEach(async () => {
  for (const child of daemons) await stop(child);
  await fs.rm(registryDir, { recursive: true, force: true });
}, COLD_FIXTURE_BUDGET_MS);

describe('a real daemon whose teardown cannot succeed', { timeout: COLD_FIXTURE_BUDGET_MS }, () => {
  it('leaves what the failing teardown said where the next command will read it', async () => {
    const daemon = startDaemon({
      exitCode: 1,
      output: `pulling the compose file\n${PERMANENT_FAILURE}\n`,
    });

    const found = await waitUntil(daemon, evidence);

    expect(found).toMatchObject({ exitCode: 1, reason: PERMANENT_FAILURE });
  });

  it('counts its attempts up, so a teardown that will never succeed reads as one', async () => {
    const daemon = startDaemon({ exitCode: 1, output: PERMANENT_FAILURE });

    const found = await waitUntil(daemon, async () => {
      const seen = await evidence();
      return seen !== undefined && seen.consecutiveFailures >= 3 ? seen : undefined;
    });

    expect(found.consecutiveFailures).toBeGreaterThanOrEqual(3);
  });

  it('is still holding its port and its claim while the evidence stands', async () => {
    const daemon = startDaemon({ exitCode: 1, output: PERMANENT_FAILURE });

    await waitUntil(daemon, evidence);

    expect(daemon.exitCode).toBeNull();
    await expect(tryLock(daemonIdentityLockPath(sentinel, registryDir))).resolves.toMatchObject({
      held: true,
    });
  });
});

describe('the bring-up that meets it', { timeout: COLD_FIXTURE_BUDGET_MS }, () => {
  it('tells whoever ran the command, and neither ends the daemon nor spawns another', async () => {
    const daemon = startDaemon({ exitCode: 1, output: PERMANENT_FAILURE });
    await waitUntil(daemon, evidence);
    const before = await identity();
    const reported: string[] = [];
    const daemonSpawn = vi.fn() as unknown as SpawnFunction;

    await ensureDaemonRunning({
      port: sentinel,
      cacheDir: registryDir,
      daemonScriptPath: FIXTURE_ENTRY,
      slot,
      spawn: daemonSpawn,
      registryDir,
      log: (message) => {
        reported.push(message);
      },
    });

    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain(PERMANENT_FAILURE);
    // The port, not the attempt count: the count climbs on every poll a failing
    // teardown survives, so the one the report carries is settled after the
    // last read anything out here can take. What the rendered sentence says
    // about a count is settled where the count is an argument.
    expect(reported[0]).toContain(String(sentinel));
    expect(daemonSpawn).not.toHaveBeenCalled();
    // The identity claim, not the record beside it, is what says the daemon is
    // the same one: it names the process, the kernel releases it the instant
    // that process dies, and nothing rewrites it while the daemon lives. The
    // record names no daemon at all, and two reads of it disagree whenever the
    // window between them straddles one of its writes.
    expect(before).toMatchObject({ pid: daemon.pid, slot });
    expect(await identity()).toEqual(before);
    expect(await evidence()).toBeDefined();
  });
});

describe('a real daemon whose teardown succeeds', { timeout: COLD_FIXTURE_BUDGET_MS }, () => {
  it('tears down, exits, and leaves nothing for anyone to read', async () => {
    const daemon = startDaemon({ exitCode: 0, output: '' });

    await exited(daemon);

    expect(daemon.exitCode).toBe(0);
    expect(await evidence()).toBeUndefined();
  });

  it('says nothing to the bring-up that follows it', async () => {
    const daemon = startDaemon({ exitCode: 0, output: '' });
    await exited(daemon);
    const reported: string[] = [];

    await ensureDaemonRunning({
      port: sentinel,
      cacheDir: registryDir,
      daemonScriptPath: FIXTURE_ENTRY,
      slot,
      spawn: vi.fn() as unknown as SpawnFunction,
      isAlive: () => Promise.resolve(true),
      registryDir,
      log: (message) => {
        reported.push(message);
      },
    });

    expect(reported).toEqual([]);
  });

  it('withdraws the evidence a daemon before it left on the same port', async () => {
    await recordTeardownFailure(
      sentinel,
      { consecutiveFailures: 9, exitCode: 1, reason: PERMANENT_FAILURE },
      registryDir
    );

    const daemon = startDaemon({ exitCode: 0, output: '' });
    await exited(daemon);

    expect(await evidence()).toBeUndefined();
  });
});
