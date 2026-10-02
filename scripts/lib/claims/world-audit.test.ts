import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  mintStageDatabaseName,
  runDatabasePrefix,
  runTokenFor,
  scratchBucketName,
  scratchBucketPrefix,
  slotDatabaseName,
} from '@hushbox/db/test-db';
import { HOUR_MS } from '@hushbox/shared/test-time';
import { e2eOutputDir, findFreeAsideName } from '../../e2e-clean.js';
import { composeProjectName } from '../cli/worktree.js';
import { FIXTURE_BOOT_BUDGET_MS, untilFileWritten } from '../bounded-wait.setup.js';
import { snapshotsDir } from '../bundling/bundle-snapshot.js';
import {
  RAM_ROOT_OWNER_FILE,
  TMPFS_MAGIC,
  prepareRamRoot,
  ramPathsFor,
} from '../stack/ram-root.js';
import {
  daemonIdentityLockPath,
  formatDaemonIdentity,
  type DaemonIdentityRecord,
} from '../stack/idle-killer-daemon.js';
import { portFor } from '../stack/port-plan.js';
import { socketAnswerFor } from '../spawn/long-lived.js';
import { HELD_CLAIMS_ENV, claim } from './claim.js';
import { currentRunId, readOwnership } from './ownership.js';
import {
  RECLAIM_BOUNDARY_PHRASE,
  UNOWNED_RECLAIM_AFTER_MS,
  type ResourceAge,
} from './resource-age.js';
import {
  RUN_CLAIM_ENV,
  addResource,
  addSpawnedProcess,
  lockPathFor,
  registerRun,
  type RunInit,
} from './registry.js';
import {
  auditExitCode,
  auditWorld,
  formatAuditLine,
  readComposeProjectWorld,
  removeWranglerStore,
  reportWorldAudit,
  scanWorld,
  type AuditLine,
  type AuditShape,
  type AuditedStack,
  type ComposeProjectWorld,
  type ContainerReading,
  type DaemonIdentity,
  type LifelineSocketReading,
  type ListenerReading,
  type ProcessGroupReading,
  type StoreAnswer,
  type ProcessReading,
  type RunRootReading,
  type StrayGroupReading,
  type WorldReading,
  type WorldScanDeps,
} from './world-audit.js';
import { NO_AGE_SOURCE, NO_STUCK_CONTAINER_SOURCE } from './world-scan.js';
import type { ProjectOwnership } from '../../docker-cleanup.js';
import type { SocketAnswer } from '../spawn/long-lived.js';
import type { RamRootHost, ReadStatfs } from '../stack/ram-root.js';

let registryDir: string;
let repoRoot: string;
/** The directory standing in for the machine's RAM filesystem, so no case reads or writes the real one. */
let ramParent: string;

/** The mount namespace every root this suite claims, and every pass it drives, is in. */
const SCRATCH_NAMESPACE = 'mnt:[1]';

/** The scratch RAM filesystem every pass this suite drives scans for E2E RAM roots. */
function scratchRamHost(): RamRootHost {
  return {
    platform: 'linux',
    parent: ramParent,
    mountNamespace: () => Promise.resolve(SCRATCH_NAMESPACE),
  };
}

/** The permission bits a directory takes a write through. */
const WRITE_PERMISSIONS = 0o222;

/** The one of those the owner of a directory writes through. */
const OWNER_WRITE = 0o200;

/** The compose project of the stack every case in this suite audits for. */
const PROJECT = 'hushbox-audited';

/**
 * The clone the compose-project cases are built against: one checkout git
 * still lists, one directory that is no longer a checkout of anything, and a
 * second clone of the same repository. Fabricated absolute paths rather than
 * real directories — nothing here reads them, and both sides of every
 * comparison the triage makes reach it through the same spelling.
 */
const CLONE = {
  commonDir: path.join(path.sep, 'repo', 'clone', '.git'),
  checkout: path.join(path.sep, 'repo', 'clone', 'main'),
  stranded: path.join(path.sep, 'repo', 'clone', 'feature-a'),
  siblingCommonDir: path.join(path.sep, 'repo', 'sibling', '.git'),
};

/** Containers found standing, with no age asked of any of them. */
function found(...names: readonly string[]): ContainerReading[] {
  return names.map((name) => ({ name, age: undefined }));
}

/** Ports found listening, with no age asked of any of them. */
function listening(...ports: readonly number[]): ListenerReading[] {
  return ports.map((port) => ({ port, age: undefined }));
}

/** The compose reading of a machine on which no project of ours is running. */
function noProjects(): ComposeProjectWorld {
  return {
    ownerships: [],
    activeWorktreePaths: [],
    repoCommonDir: CLONE.commonDir,
    slotOfWorktree: () => null,
  };
}

/** What a pass audits for: the one thing the idle daemon has to agree with. */
function auditedStack(overrides: Partial<AuditedStack> = {}): AuditedStack {
  return { composeProject: PROJECT, checkout: repoRoot, ...overrides };
}

/** What a daemon of the stack under test states about itself. */
function daemonIdentity(overrides: Partial<DaemonIdentityRecord> = {}): DaemonIdentityRecord {
  return { slot: 3, composeProject: PROJECT, repoRoot, pid: process.pid, ...overrides };
}

function init(overrides: Partial<RunInit> = {}): RunInit {
  return {
    command: 'pnpm dev',
    mode: 'development',
    slot: 3,
    gitCommonDir: path.join(registryDir, 'checkout', '.git'),
    registryDir,
    ...overrides,
  };
}

function emptyWorld(overrides: Partial<WorldReading> = {}): WorldReading {
  return {
    containers: [],
    databases: [],
    buckets: [],
    listeningPorts: [],
    daemonPorts: [],
    processGroups: [],
    strayGroups: [],
    snapshots: [],
    asides: [],
    lifelineSockets: [],
    wranglerStores: [],
    unreclaimedStores: [],
    storeAnswers: [],
    composeProjects: noProjects(),
    stuckContainers: [],
    runRoots: [],
    unreadable: [],
    uncovered: [],
    ...overrides,
  };
}

/** Every source one pass reads, answering with nothing until a case says otherwise. */
function worldScan(overrides: Partial<WorldScanDeps> = {}): WorldScanDeps {
  return {
    repoRoot,
    stack: auditedStack(),
    containers: () => Promise.resolve([]),
    containerAges: NO_AGE_SOURCE,
    stuckContainers: () => Promise.resolve([]),
    databases: () => Promise.resolve([]),
    buckets: () => Promise.resolve([]),
    listeningPorts: () => Promise.resolve([]),
    listenerAge: NO_AGE_SOURCE,
    lifelineSockets: () => Promise.resolve([]),
    composeProjects: () => Promise.resolve(noProjects()),
    // Answered rather than asked of the machine, so a case about the reclaim
    // is not also a case about whatever else is running while it runs. The
    // cases about the question itself name their own answer, and the ones
    // about the kernel's answer pass none at all.
    probeStore: () => Promise.resolve({ kind: 'vacant' }),
    // Answered rather than read off the machine, for the same reason: a case
    // about anything else must not also be a case about every process running
    // beside it. The cases whose subject is the census read the real machine.
    processes: () => Promise.resolve({ kind: 'read', processes: [] }),
    // A pass that may remove things removes a stranded RAM root, so one left
    // reading the machine's own RAM filesystem could take another checkout's.
    ramHost: scratchRamHost(),
    ...overrides,
  };
}

/** Classifies `world` against a registry holding whatever `hold` recorded. */
async function classify(
  world: WorldReading,
  hold: () => Promise<void> = () => Promise.resolve()
): Promise<AuditLine[]> {
  await hold();
  return auditWorld(world, await readOwnership(registryDir));
}

/** Runs `body` inside a live run, so the registry answers owned-live while it runs. */
async function withLiveRun<T>(
  body: () => Promise<T>,
  record: () => Promise<void>,
  overrides: Partial<RunInit> = {}
): Promise<T> {
  return registerRun(init(overrides), async () => {
    await record();
    return body();
  });
}

/** Runs `body` while a daemon holds the claim that identifies it on `port`. */
async function withDaemonIdentity<T>(
  port: number,
  body: () => Promise<T>,
  holder: string = formatDaemonIdentity(daemonIdentity())
): Promise<T> {
  return claim(
    { name: 'the idle daemon', lockPath: daemonIdentityLockPath(port, registryDir) },
    { onHeld: 'refuse', holder },
    body
  );
}

/**
 * Makes the enclosing run's record unreadable in the form that needs no
 * corruption: a record a wider checkout wrote names a mode this one has never
 * heard of. The run behind it goes on holding its lock, so it is as live as any
 * other and its resources are unknowable rather than absent.
 */
async function damageOwnRecord(): Promise<void> {
  const record = path.join(process.env[RUN_CLAIM_ENV] ?? '', 'run.json');
  const written: unknown = JSON.parse(await fs.readFile(record, 'utf8'));
  await fs.writeFile(
    record,
    JSON.stringify({ ...(written as object), mode: 'a-mode-this-checkout-has-never-heard-of' })
  );
}

/** Whether a store is still on disk under the checkout every case is built in. */
async function storeExists(store: string): Promise<boolean> {
  try {
    await fs.stat(path.join(repoRoot, store));
    return true;
  } catch {
    return false;
  }
}

/** A pass that may empty a store, told whatever the case wants said about each one. */
function reclaimingPass(overrides: Partial<WorldScanDeps> = {}): WorldScanDeps {
  return worldScan({
    reclaimStrandedStores: (store) => removeWranglerStore(repoRoot, store),
    ...overrides,
  });
}

/** What a store holds, under the checkout every case is built in. */
function storeContents(store: string): Promise<string[]> {
  return fs.readdir(path.join(repoRoot, store));
}

/** Leaves an owned-expired claim behind: the run throws, so its record survives. */
async function leaveExpiredClaim(record: () => Promise<void>): Promise<void> {
  await registerRun(init(), async () => {
    await record();
    throw new Error('the run was killed');
  }).catch(() => undefined);
}

/**
 * A run id no registry has ever held, which is what a resource nothing here can
 * account for names. Fixed rather than minted so the line a case reads is the
 * same one every time it runs.
 */
const FOREIGN_RUN = '3aa435a4-bded-46fc-96e5-0cab70aca703';

/**
 * Leaves the state a run that ended the way it meant to leaves: its record gone
 * and its lock file behind. Nothing is recorded against it, because the point
 * of these cases is a resource whose only surviving attribution is its own name.
 */
async function endedRun(): Promise<string> {
  return registerRun(init(), () => Promise.resolve(currentRunId() ?? ''));
}

beforeEach(async () => {
  // The invocation running this suite is itself a registered run and advertises
  // it in the environment every child inherits, so a case calling `registerRun`
  // would adopt that run instead of registering its own — recording this
  // suite's fabricated resources into the outer run's directory and classifying
  // them against a scoped registry that never saw them. Both tokens start empty
  // before the first case, never cleared after one.
  vi.stubEnv(RUN_CLAIM_ENV, '');
  vi.stubEnv(HELD_CLAIMS_ENV, '');
  registryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-audit-registry-'));
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-audit-root-'));
  ramParent = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-audit-shm-'));
});

afterEach(async () => {
  // Ahead of the removals, because one that throws would otherwise skip it. The
  // runner restores stubs before each test and never after the last one, so the
  // tokens this file blanks in setup outlive the file without this.
  vi.unstubAllEnvs();
  await fs.rm(registryDir, { recursive: true, force: true });
  await fs.rm(repoRoot, { recursive: true, force: true });
  await fs.rm(ramParent, { recursive: true, force: true });
});

describe('classifying a container', () => {
  it('reports one whose run still holds its claim as owned-live', async () => {
    const world = emptyWorld({ containers: found('hushbox-emulator-0') });

    const lines = await withLiveRun(
      () => classify(world),
      () => addResource({ kind: 'container', id: 'hushbox-emulator-0' })
    );

    expect(lines).toEqual([
      expect.objectContaining({
        kind: 'container',
        state: 'owned-live',
        owner: expect.stringContaining('pnpm dev'),
      }),
    ]);
  });

  it('reports one whose run is gone as owned-expired', async () => {
    await leaveExpiredClaim(() => addResource({ kind: 'container', id: 'hushbox-emulator-0' }));

    const lines = await classify(emptyWorld({ containers: found('hushbox-emulator-0') }));

    expect(lines[0]).toMatchObject({
      state: 'owned-expired',
      owner: expect.stringContaining('pnpm dev'),
    });
  });

  it('reports one no claim names as unowned, with no owner', async () => {
    const lines = await classify(emptyWorld({ containers: found('hushbox-emulator-0') }));

    expect(lines[0]).toMatchObject({ state: 'unowned', owner: undefined });
  });
});

/**
 * The second class whose report line turns on how long it has stood, and the
 * one where the line had gone false: the pass every stack bring-up runs removes
 * an unclaimed container past the boundary, while the report still sent a
 * reader to remove it by hand.
 */
describe('a container nothing accounts for, against the boundary', () => {
  const NAME = 'hushbox-emulator-0';
  const PAST: ResourceAge = { kind: 'known', elapsedMs: UNOWNED_RECLAIM_AFTER_MS + HOUR_MS };

  function unclaimed(age?: ResourceAge): Promise<AuditLine[]> {
    return classify(emptyWorld({ containers: [{ name: NAME, age }] }));
  }

  it('says the next pass reclaims one that has stood past the boundary', async () => {
    const lines = await unclaimed(PAST);
    const rendered = formatAuditLine(lines[0]!);

    expect(rendered).toContain(RECLAIM_BOUNDARY_PHRASE);
    expect(rendered).not.toContain('remove it by hand');
  });

  it('asks nobody to act on one the next pass reclaims', async () => {
    expect(auditExitCode(await unclaimed(PAST), [])).toBe(0);
  });

  /**
   * Compared against the same world read without an age rather than against a
   * sentence written out here: what the criterion asks is that the line below
   * the boundary is the line this reported before a boundary reached the class,
   * and only the two lines side by side can say that.
   */
  it('reports one below the boundary in the words it used before there was a boundary', async () => {
    const below = await unclaimed({ kind: 'known', elapsedMs: UNOWNED_RECLAIM_AFTER_MS - HOUR_MS });
    const before = await unclaimed();

    expect(formatAuditLine(below[0]!)).toBe(formatAuditLine(before[0]!));
    expect(auditExitCode(below, [])).toBe(1);
  });

  it('says how long it has stood could not be read rather than implying it is fresh', async () => {
    const lines = await unclaimed({
      kind: 'unreadable',
      reason: 'the listing carried no creation time for it',
    });

    expect(formatAuditLine(lines[0]!)).toContain('could not be read');
    expect(auditExitCode(lines, [])).toBe(1);
  });

  /**
   * The gate the removing pass applies, read back out of the report: a reader
   * that cannot tell who is alive cannot tell what is abandoned, so a claim on
   * this container may exist in the record nobody could read.
   */
  it('leaves one past the boundary standing while a live run’s record could not be read', async () => {
    const lines = await withLiveRun(() => unclaimed(PAST), damageOwnRecord);

    expect(formatAuditLine(lines[0]!)).toContain('ownership unestablished');
    expect(auditExitCode(lines, [])).toBe(1);
  });

  it('is asked of the containers the pass found, by name', async () => {
    const world = await scanWorld(
      worldScan({
        containers: () => Promise.resolve([NAME]),
        containerAges: () =>
          Promise.resolve(
            new Map<string, ResourceAge>([[NAME, { kind: 'known', elapsedMs: HOUR_MS }]])
          ),
      }),
      registryDir
    );

    expect(world.containers).toEqual([{ name: NAME, age: { kind: 'known', elapsedMs: HOUR_MS } }]);
  });

  it('is left unestablished by a pass that states it has no source', async () => {
    const world = await scanWorld(
      worldScan({ containers: () => Promise.resolve([NAME]), containerAges: NO_AGE_SOURCE }),
      registryDir
    );

    expect(world.containers).toEqual([{ name: NAME, age: undefined }]);
  });

  it('keeps the containers it listed when the age reading fails', async () => {
    const world = await scanWorld(
      worldScan({
        containers: () => Promise.resolve([NAME]),
        containerAges: () => Promise.reject(new Error('docker is not running')),
      }),
      registryDir
    );

    expect(world.containers).toEqual([{ name: NAME, age: undefined }]);
    expect(world.unreadable).toEqual(['how long the containers have stood: docker is not running']);
  });

  /**
   * One reading held still while the container's age is the only thing that
   * moves, which is the whole of what the age is allowed to reach. The lines
   * are written out rather than compared against a second classification,
   * because what this pins is the sentence each other class printed before the
   * container class learned its age.
   */
  it('changes no other class over one frozen reading', async () => {
    const lines = await classify(
      emptyWorld({
        containers: [{ name: NAME, age: PAST }],
        stuckContainers: [{ name: 'hushbox-postgres-3', state: 'exited' }],
        databases: ['hb_t_ab12cd34ef_w1'],
        buckets: [scratchBucketName('ab12cd34ef', 'one')],
        listeningPorts: listening(10_003),
        asides: ['run-ab12cd34ef'],
      })
    );

    const others = lines.filter((found) => found.kind !== 'container');

    expect(others.map((found) => formatAuditLine(found))).toEqual([
      'stuck-container hushbox-postgres-3 (docker has it exited) — unowned — no claim — a ' +
        'compose project’s containers are not recorded one by one, so nothing here can say ' +
        'which bring-up left this one behind — remove it by hand once you have confirmed the ' +
        'project it belongs to is not using it — `pnpm docker:cleanup` reclaims only a ' +
        'container no compose project owns, and a teardown reaches this one only by taking ' +
        'the whole project down',
      'database hb_t_ab12cd34ef_w1 — unowned — no claim — nothing recorded it, which is what ' +
        'a process that held no run claim leaves behind, so nothing here can say what created ' +
        'it — reclaimed by `pnpm test` — one whose creation stamp cannot be read goes on the ' +
        'pass that finds it, and one carrying a readable stamp goes to the pre-registry path ' +
        'on that stamp',
      'bucket hushbox-scratch-ab12cd34ef-one — unowned — no claim — nothing recorded it, ' +
        'which is what a process that held no run claim leaves behind, so nothing here can ' +
        'say what created it — remove it by hand once you have confirmed it is yours — `pnpm ' +
        'test` reclaims one whose run recorded it, and nothing reclaims one no claim names',
      'port 10003 (vite, development band, slot 3) — unowned — no claim — nothing recorded ' +
        'it, which is what a process that held no run claim leaves behind, so nothing here ' +
        'can say what created it — remove it by hand once you have confirmed it is yours — ' +
        '`pnpm dev:clean` reclaims one whose run recorded it, and only `pnpm dev:clean ' +
        '--unowned` ends one no claim names',
      "aside run-ab12cd34ef — unowned — unclaimed by design — a finished run's discarded " +
        'output — removed by `pnpm e2e` — an aside has no live consumer, so it is reclaimed ' +
        'rather than reported',
    ]);
  });
});

describe('the age source a pass states', () => {
  /**
   * The enforcement is the compiler's rather than this runner's: an unused
   * `@ts-expect-error` is an error of its own, so the directive below fails the
   * build the moment a pass that names no container-age source stops being
   * refused.
   *
   * What it refuses is the shape in which nothing looks broken. A pass that
   * left the source off and a source that answered about no container reach the
   * boundary as the same unestablished age, so a pass that simply forgot
   * reports every container as something only a human can remove, and every
   * layer of it is individually consistent.
   */
  it('refuses a pass that leaves the container-age source off', () => {
    const unstated: Omit<WorldScanDeps, 'containerAges'> = worldScan();

    // @ts-expect-error a pass that cannot date its containers says so, rather than leaving the source off
    const pass: WorldScanDeps = unstated;

    expect(pass.containers).toBe(unstated.containers);
  });

  /**
   * The listener class is the container class's twin: the same optional source,
   * the same reclaim boundary put to the answer, and the same collapse between
   * a pass that cannot ask and a pass that forgot. One reader meeting two age
   * sources under two disciplines takes the laxer one as the pattern, so the
   * two are held to one.
   */
  it('refuses a pass that leaves the listener-age source off', () => {
    const unstated: Omit<WorldScanDeps, 'listenerAge'> = worldScan();

    // @ts-expect-error a pass that cannot date its listeners says so, rather than leaving the source off
    const pass: WorldScanDeps = unstated;

    expect(pass.listeningPorts).toBe(unstated.listeningPorts);
  });
});

describe('the stuck-container source a pass states', () => {
  /**
   * Held to the age sources' discipline and enforced the same way — an unused
   * `@ts-expect-error` is an error of its own, so the directive below fails the
   * build the moment a pass that names no source for the class stops being
   * refused.
   *
   * The collapse it refuses is the class's own rather than an age's: a pass
   * that left the listing off reads no stopped container, which is the reading
   * a machine running all of its own produces, so a caller that forgot the
   * source certifies the class clean and every layer of it stays individually
   * consistent.
   */
  it('refuses a pass that leaves the stuck-container listing off', () => {
    const unstated: Omit<WorldScanDeps, 'stuckContainers'> = worldScan();

    // @ts-expect-error a pass that cannot list stopped containers says so, rather than leaving the source off
    const pass: WorldScanDeps = unstated;

    expect(pass.containers).toBe(unstated.containers);
  });
});

describe('classifying a database by its name', () => {
  it('attributes a per-worker database to the run its name carries', async () => {
    const lines = await withLiveRun(
      () => classify(emptyWorld({ databases: ['hb_t_ab12cd34ef_w1'] })),
      () => addResource({ kind: 'database', id: runDatabasePrefix('ab12cd34ef') })
    );

    expect(lines[0]).toMatchObject({ kind: 'database', state: 'owned-live' });
  });

  it('attributes a staged template database to the build that recorded its name', async () => {
    const lines = await withLiveRun(
      () => classify(emptyWorld({ databases: ['hb_stage_abc1234def567890'] })),
      () => addResource({ kind: 'database', id: 'hb_stage_abc1234def567890' })
    );

    expect(lines[0]).toMatchObject({ id: 'hb_stage_abc1234def567890', state: 'owned-live' });
  });

  it('reports a staged template database no build recorded as unowned', async () => {
    const lines = await classify(emptyWorld({ databases: ['hb_stage_abc1234def567890'] }));

    expect(lines[0]).toMatchObject({ id: 'hb_stage_abc1234def567890', state: 'unowned' });
  });

  it("attributes a per-worker database to the run its name carries once that run's record is gone", async () => {
    const ended = await endedRun();

    const lines = await classify(
      emptyWorld({ databases: [slotDatabaseName(runTokenFor(ended), '1')] })
    );

    expect(lines[0]).toMatchObject({ kind: 'database', state: 'owned-expired' });
  });

  it("attributes a staged template database to the run its name carries once that run's record is gone", async () => {
    const ended = await endedRun();

    const lines = await classify(
      emptyWorld({ databases: [mintStageDatabaseName(runTokenFor(ended))] })
    );

    expect(lines[0]).toMatchObject({ kind: 'stage-database', state: 'owned-expired' });
  });

  it('leaves a per-worker database naming a run no claim ever held unowned', async () => {
    const lines = await classify(
      emptyWorld({ databases: [slotDatabaseName(runTokenFor(FOREIGN_RUN), '1')] })
    );

    expect(lines[0]).toMatchObject({ kind: 'database', state: 'unowned' });
  });

  it('leaves a staged template database naming a run no claim ever held unowned', async () => {
    const lines = await classify(
      emptyWorld({ databases: [mintStageDatabaseName(runTokenFor(FOREIGN_RUN))] })
    );

    expect(lines[0]).toMatchObject({ kind: 'stage-database', state: 'unowned' });
  });

  it('reads the name and never the comment, so a database mid-creation is still attributed', async () => {
    // A database is comment-less between its CREATE and its COMMENT; its name
    // exists from the instant it does, which is why the name is the attribution.
    const lines = await withLiveRun(
      () => classify(emptyWorld({ databases: ['hb_t_ab12cd34ef_w1', 'hb_t_ab12cd34ef_w2'] })),
      () => addResource({ kind: 'database', id: runDatabasePrefix('ab12cd34ef') })
    );

    expect(lines.map((line) => line.state)).toEqual(['owned-live', 'owned-live']);
  });
});

describe('classifying a scratch bucket by its name', () => {
  it('attributes a bucket to the run token it carries', async () => {
    const lines = await withLiveRun(
      () => classify(emptyWorld({ buckets: ['hushbox-scratch-ab12cd34ef-one'] })),
      () => addResource({ kind: 'bucket', id: scratchBucketPrefix('ab12cd34ef') })
    );

    expect(lines[0]).toMatchObject({ kind: 'bucket', state: 'owned-live' });
  });

  it('reports a bucket whose token no claim names as unowned', async () => {
    const lines = await classify(
      emptyWorld({ buckets: ['hushbox-scratch-3aa435a4-bded-46fc-96e5-0cab70aca703'] })
    );

    expect(lines[0]).toMatchObject({ state: 'unowned' });
  });

  it("attributes a bucket to the run its name carries once that run's record is gone", async () => {
    const ended = await endedRun();

    const lines = await classify(
      emptyWorld({ buckets: [scratchBucketName(runTokenFor(ended), 'one')] })
    );

    expect(lines[0]).toMatchObject({ kind: 'bucket', state: 'owned-expired' });
  });

  it('leaves a bucket naming a run no claim ever held unowned', async () => {
    const lines = await classify(
      emptyWorld({ buckets: [scratchBucketName(runTokenFor(FOREIGN_RUN), 'one')] })
    );

    expect(lines[0]).toMatchObject({ kind: 'bucket', state: 'unowned' });
  });

  it('reports a bucket named before buckets carried a token at all as unowned', async () => {
    const lines = await classify(emptyWorld({ buckets: ['hushbox-scratch-legacy'] }));

    expect(lines[0]).toMatchObject({ id: 'hushbox-scratch-legacy', state: 'unowned' });
  });
});

/**
 * The one class here whose report line turns on how long it has stood, because
 * it is the one this command reclaims itself.
 */
describe('a listener nothing accounts for, against the boundary', () => {
  const PORT = 10_003;

  function unclaimed(age?: ResourceAge): Promise<AuditLine[]> {
    return classify(emptyWorld({ listeningPorts: [{ port: PORT, age }] }));
  }

  it('says a run reclaims one that has stood past the boundary', async () => {
    const lines = await unclaimed({
      kind: 'known',
      elapsedMs: UNOWNED_RECLAIM_AFTER_MS + HOUR_MS,
    });

    expect(formatAuditLine(lines[0]!)).toContain(RECLAIM_BOUNDARY_PHRASE);
    expect(formatAuditLine(lines[0]!)).not.toContain('remove it by hand');
  });

  it('asks nobody to act on one a run reclaims', async () => {
    const lines = await unclaimed({
      kind: 'known',
      elapsedMs: UNOWNED_RECLAIM_AFTER_MS + HOUR_MS,
    });

    expect(auditExitCode(lines, [])).toBe(0);
  });

  /**
   * Compared against the same world read without an age rather than against a
   * sentence written out here: what the criterion asks is that the line below
   * the boundary is the line this reported before a boundary existed, and only
   * the two lines side by side can say that.
   */
  it('reports one below the boundary in the words it used before there was a boundary', async () => {
    const below = await unclaimed({ kind: 'known', elapsedMs: UNOWNED_RECLAIM_AFTER_MS - HOUR_MS });
    const before = await unclaimed();

    expect(formatAuditLine(below[0]!)).toBe(formatAuditLine(before[0]!));
    expect(auditExitCode(below, [])).toBe(1);
  });

  it('is asked of each listening port by the pass that reads the world', async () => {
    const asked: number[] = [];
    const world = await scanWorld(
      worldScan({
        listeningPorts: () => Promise.resolve([PORT]),
        listenerAge: (port) => {
          asked.push(port);
          return Promise.resolve({ kind: 'known', elapsedMs: HOUR_MS });
        },
      }),
      registryDir
    );

    expect(asked).toEqual([PORT]);
    expect(world.listeningPorts).toEqual([
      { port: PORT, age: { kind: 'known', elapsedMs: HOUR_MS } },
    ]);
  });

  it('is left unestablished by a pass with nothing to ask', async () => {
    const world = await scanWorld(
      worldScan({ listeningPorts: () => Promise.resolve([PORT]) }),
      registryDir
    );

    expect(world.listeningPorts).toEqual([{ port: PORT, age: undefined }]);
  });

  it('says how long it has stood could not be read rather than implying it is fresh', async () => {
    const lines = await unclaimed({ kind: 'unreadable', reason: 'nothing is holding it any more' });

    expect(formatAuditLine(lines[0]!)).toContain('could not be read');
    expect(auditExitCode(lines, [])).toBe(1);
  });
});

describe('classifying a listener on this slot’s bands', () => {
  it('names the service, band and slot the port belongs to', async () => {
    const lines = await classify(emptyWorld({ listeningPorts: listening(10_003) }));

    expect(lines[0]).toMatchObject({ kind: 'port', id: '10003' });
    expect(lines[0]?.detail).toContain('vite');
    expect(lines[0]?.detail).toContain('slot 3');
  });

  it('attributes a port to the run that recorded it', async () => {
    const lines = await withLiveRun(
      () => classify(emptyWorld({ listeningPorts: listening(10_003) })),
      () => addResource({ kind: 'port', id: '10003' })
    );

    expect(lines[0]).toMatchObject({
      state: 'owned-live',
      owner: expect.stringContaining('pnpm dev'),
    });
  });
});

/**
 * The loader a fixture of this suite needs to import a module of ours, resolved
 * the way the bundling suite resolves it.
 */
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

/** The registry a fixture registers its run through. */
const REGISTRY_MODULE = new URL('registry.ts', import.meta.url).href;

/** What a case that starts a fixture and reads the machine may spend. */
const RUN_ROOT_CASE_TIMEOUT_MS = FIXTURE_BOOT_BUDGET_MS * 3;

/**
 * A program that registers a run and keeps holding it.
 *
 * It holds on a timer rather than on standard input, which is what the
 * registry's own fixture holds on: the process these cases decapitate is the
 * one that gave the holder its standard input, so a holder waiting on that
 * reaches end-of-file the moment the case does its work. The timer is what
 * keeps the process alive and nothing reads it — the claim is a lock, and every
 * standing these cases assert comes from the kernel.
 */
function holderProgram(runFile: string, gitCommonDir: string): string {
  return String.raw`
    const { registerRun, RUN_CLAIM_ENV } = await import(${JSON.stringify(REGISTRY_MODULE)});
    const { writeFileSync } = await import('node:fs');
    const { basename } = await import('node:path');
    await registerRun(
      {
        command: 'pnpm dev',
        mode: 'development',
        slot: 3,
        gitCommonDir: ${JSON.stringify(gitCommonDir)},
        registryDir: ${JSON.stringify(registryDir)},
      },
      async () => {
        writeFileSync(${JSON.stringify(runFile)}, basename(process.env[RUN_CLAIM_ENV]) + '\n');
        await new Promise((resolve) => setTimeout(resolve, ${String(RUN_ROOT_CASE_TIMEOUT_MS)}));
      }
    );
  `;
}

/** The command line a holder is started on. */
function holderCommand(runFile: string): string[] {
  return [
    '--import',
    TSX_LOADER,
    '--input-type=module',
    '-e',
    holderProgram(runFile, path.join(registryDir, 'checkout', '.git')),
  ];
}

/**
 * A live claim whose own process leads its process group, which is what every
 * healthy run of this repository looks like.
 */
async function withRootedRun(body: (runId: string) => Promise<void>): Promise<void> {
  const runFile = path.join(registryDir, 'rooted-run');
  const holder = spawn(process.execPath, holderCommand(runFile), {
    detached: true,
    stdio: 'ignore',
  });
  try {
    const published = await untilFileWritten(runFile, FIXTURE_BOOT_BUDGET_MS);
    await body(published.trim());
  } finally {
    holder.kill('SIGKILL');
  }
}

/**
 * A live claim held only by what a killed run left behind: a detached leader
 * starts the holder inside its own group and exits, so the group outlives the
 * process that made it. That is the shape a killed development run leaves, and
 * it is driven here rather than inferred from the rooted one.
 */
async function withDecapitatedRun(body: (runId: string) => Promise<void>): Promise<void> {
  const runFile = path.join(registryDir, 'decapitated-run');
  const holderPidFile = path.join(registryDir, 'decapitated-holder');
  const leader = `
    const { spawn } = await import('node:child_process');
    const { writeFileSync } = await import('node:fs');
    const held = spawn(process.execPath, ${JSON.stringify(holderCommand(runFile))}, {
      stdio: 'ignore',
    });
    writeFileSync(${JSON.stringify(holderPidFile)}, String(held.pid));
    held.unref();
    process.exit(0);
  `;
  const started = spawn(process.execPath, ['--input-type=module', '-e', leader], {
    detached: true,
    stdio: 'ignore',
  });
  await new Promise<void>((resolve) => {
    started.once('exit', () => {
      resolve();
    });
  });
  const published = await untilFileWritten(runFile, FIXTURE_BOOT_BUDGET_MS);
  const holderPid = Number(await untilFileWritten(holderPidFile, FIXTURE_BOOT_BUDGET_MS));
  try {
    await body(published.trim());
  } finally {
    process.kill(holderPid, 'SIGKILL');
  }
}

/** The standing the pass read for `runId`, out of a whole reading of the world. */
function standingOf(roots: readonly RunRootReading[], runId: string): string | undefined {
  return roots.find((root) => root.runId === runId)?.standing;
}

describe('where a live run’s own process stands', () => {
  it(
    'reads a run whose process leads its group as rooted',
    async () => {
      await withRootedRun(async (runId) => {
        const world = await scanWorld(worldScan(), registryDir);

        expect(standingOf(world.runRoots, runId)).toBe('rooted');
      });
    },
    RUN_ROOT_CASE_TIMEOUT_MS
  );

  it(
    'reads a run whose group has lost its leader as decapitated',
    async () => {
      await withDecapitatedRun(async (runId) => {
        const world = await scanWorld(worldScan(), registryDir);

        expect(standingOf(world.runRoots, runId)).toBe('decapitated');
      });
    },
    RUN_ROOT_CASE_TIMEOUT_MS
  );

  it(
    'establishes nothing on a platform that publishes no process groups',
    async () => {
      await withDecapitatedRun(async (runId) => {
        const world = await scanWorld(worldScan({ platform: 'win32' }), registryDir);

        expect(standingOf(world.runRoots, runId)).toBe('unestablished');
      });
    },
    RUN_ROOT_CASE_TIMEOUT_MS
  );

  it(
    'leaves the decapitated tree running, having only read it',
    async () => {
      await withDecapitatedRun(async (runId) => {
        await scanWorld(worldScan(), registryDir);

        const after = await scanWorld(worldScan(), registryDir);
        expect(standingOf(after.runRoots, runId)).toBe('decapitated');
      });
    },
    RUN_ROOT_CASE_TIMEOUT_MS
  );
});

describe('a resource a live run holds whose own process is gone', () => {
  /** A port a live run recorded, classified against the standing it is given. */
  async function portHeldBy(standing: RunRootReading['standing']): Promise<AuditLine> {
    return withLiveRun(
      async () => {
        const lines = await classify(
          emptyWorld({
            listeningPorts: listening(10_003),
            runRoots: [{ runId: currentRunId() ?? '', standing }],
          })
        );
        return lines[0]!;
      },
      () => addResource({ kind: 'port', id: '10003' })
    );
  }

  it('is one a human must act on', async () => {
    expect(auditExitCode([await portHeldBy('decapitated')], [])).toBe(1);
  });

  it('says the claim is held by what the run left behind', async () => {
    const rendered = formatAuditLine(await portHeldBy('decapitated'));

    expect(rendered).toContain('owned-live');
    expect(rendered).toContain('left behind');
  });

  it('is still nothing to do where the run’s own process leads its group', async () => {
    const line = await portHeldBy('rooted');

    expect(formatAuditLine(line)).toContain('nothing to do');
    expect(auditExitCode([line], [])).toBe(0);
  });

  it('is nothing to do where no standing could be established', async () => {
    const line = await portHeldBy('unestablished');

    expect(formatAuditLine(line)).toContain('nothing to do');
    expect(auditExitCode([line], [])).toBe(0);
  });
});

describe('classifying a container a compose project owns that docker is not running', () => {
  it('names it, which nothing else does', async () => {
    const lines = await classify(
      emptyWorld({ stuckContainers: [{ name: 'hushbox-0-minio-setup-run-a1', state: 'created' }] })
    );

    expect(lines[0]).toMatchObject({
      kind: 'stuck-container',
      id: 'hushbox-0-minio-setup-run-a1',
      state: 'unowned',
    });
  });

  it('says which state docker has it in', async () => {
    const lines = await classify(
      emptyWorld({ stuckContainers: [{ name: 'hushbox-0-minio-setup-run-a1', state: 'created' }] })
    );

    expect(formatAuditLine(lines[0]!)).toContain('created');
  });

  it('is one a human must act on', async () => {
    const lines = await classify(
      emptyWorld({ stuckContainers: [{ name: 'hushbox-0-minio-setup-run-a1', state: 'created' }] })
    );

    expect(auditExitCode(lines, [])).toBe(1);
  });

  it('is read from the listing the pass is given', async () => {
    const world = await scanWorld(
      worldScan({
        stuckContainers: () =>
          Promise.resolve([{ name: 'hushbox-0-minio-setup-run-a1', state: 'created' }]),
      }),
      registryDir
    );

    expect(world.stuckContainers).toEqual([
      { name: 'hushbox-0-minio-setup-run-a1', state: 'created' },
    ]);
  });

  it('reports the class as unread where the listing could not be taken', async () => {
    const world = await scanWorld(
      worldScan({ stuckContainers: () => Promise.reject(new Error('Docker not running')) }),
      registryDir
    );

    expect(world.stuckContainers).toEqual([]);
    expect(world.unreadable.join(' ')).toContain('Docker not running');
  });

  it('reports the class as one it does not cover where the pass has no listing', async () => {
    const world = await scanWorld(
      worldScan({ stuckContainers: NO_STUCK_CONTAINER_SOURCE }),
      registryDir
    );

    expect(world.uncovered.join(' ')).toContain('does not cover');
  });

  /**
   * The pair this states apart is the whole reason the source is stated: both
   * readings carry the same empty list, so a reader told nothing about the one
   * on the left is told the machine is clean.
   */
  it('covers the class where a listing found none of it', async () => {
    const world = await scanWorld(
      worldScan({ stuckContainers: () => Promise.resolve([]) }),
      registryDir
    );

    expect(world.uncovered).toEqual([]);
  });

  it('says out loud that it covered none of the class', async () => {
    const printed: string[] = [];

    await reportWorldAudit(
      worldScan({ stuckContainers: NO_STUCK_CONTAINER_SOURCE }),
      (message) => printed.push(message),
      registryDir
    );

    expect(printed.join(' ')).toContain(
      'containers a compose project owns that docker is not running: this report does not cover them here'
    );
  });

  it('says none of that where a listing found none of the class', async () => {
    const printed: string[] = [];

    await reportWorldAudit(
      worldScan({ stuckContainers: () => Promise.resolve([]) }),
      (message) => printed.push(message),
      registryDir
    );

    expect(printed.join(' ')).not.toContain('does not cover them here');
  });
});

describe('classifying a dist snapshot', () => {
  it('reads its own lock rather than the run registry', async () => {
    const lines = await classify(
      emptyWorld({ snapshots: [{ id: 'web-dist-1', held: true, holder: 'pnpm e2e' }] })
    );

    expect(lines[0]).toMatchObject({ kind: 'snapshot', state: 'owned-live', owner: 'pnpm e2e' });
  });

  it('reports one whose serve is over as owned-expired', async () => {
    const lines = await classify(
      emptyWorld({ snapshots: [{ id: 'web-dist-1', held: false, holder: null }] })
    );

    expect(lines[0]).toMatchObject({ state: 'owned-expired', owner: undefined });
  });
});

describe('classifying a purge aside', () => {
  it('reads the owner out of the directory name, not out of a resource record', async () => {
    let expected: AuditLine[] = [];
    await withLiveRun(
      async () => {
        const runId = currentRunId()!;
        expected = await classify(emptyWorld({ asides: [`test-results.purge-${runId}.0`] }));
      },
      () => Promise.resolve()
    );

    expect(expected[0]).toMatchObject({ kind: 'aside', state: 'owned-live' });
  });

  it('reports an aside naming no run at all as unowned', async () => {
    const lines = await classify(emptyWorld({ asides: ['test-results.purge-0'] }));

    expect(lines[0]).toMatchObject({ state: 'unowned' });
  });
});

describe('classifying the socket a spawning process answers its children on', () => {
  const address = path.join('var', 'scratch', 'hb-0123456789');

  /** The socket half of a reading, carrying whatever a connect to it answered. */
  function sockets(answer?: SocketAnswer): LifelineSocketReading[] {
    return [{ address, answer }];
  }

  it('reports one whose run still holds its claim as owned-live', async () => {
    const lines = await withLiveRun(
      () => classify(emptyWorld({ lifelineSockets: sockets() })),
      () => addResource({ kind: 'socket', id: address })
    );

    expect(lines[0]).toMatchObject({
      kind: 'socket',
      id: address,
      state: 'owned-live',
      owner: expect.stringContaining('pnpm dev'),
    });
  });

  it('reports one whose run is gone as owned-expired, and names what reclaims it', async () => {
    await leaveExpiredClaim(() => addResource({ kind: 'socket', id: address }));

    const lines = await classify(emptyWorld({ lifelineSockets: sockets() }));

    expect(lines[0]).toMatchObject({ state: 'owned-expired' });
    expect(formatAuditLine(lines[0]!)).toContain('pnpm dev:clean');
  });

  it("says an expired claim's file will have its removal attempted rather than already made", async () => {
    // The same ground the unowned refused line stands on: a removal the
    // operating system refuses is reported and the file left standing, so a
    // line promising the reclaim is contradicted by the pass that makes it.
    await leaveExpiredClaim(() => addResource({ kind: 'socket', id: address }));

    const lines = await classify(emptyWorld({ lifelineSockets: sockets() }));

    const rendered = formatAuditLine(lines[0]!);
    expect(rendered).toContain('attempts the removal');
    expect(rendered).not.toContain('reclaimed by');
  });

  it('asks a human about one no claim names that answers a connect', async () => {
    const lines = await classify(emptyWorld({ lifelineSockets: sockets({ kind: 'answered' }) }));

    expect(lines[0]).toMatchObject({ state: 'unowned', owner: undefined });
    expect(formatAuditLine(lines[0]!)).toContain('end the process answering on it');
    expect(auditExitCode(lines, [])).toBe(1);
  });

  it('names the reclaim for one no claim names that refuses a connect, and asks nobody', async () => {
    const lines = await classify(emptyWorld({ lifelineSockets: sockets({ kind: 'refused' }) }));

    expect(lines[0]).toMatchObject({ state: 'unowned', owner: undefined });
    expect(formatAuditLine(lines[0]!)).toContain('pnpm dev:clean');
    expect(auditExitCode(lines, [])).toBe(0);
  });

  it('says what a refused-connect socket will have attempted rather than that it is already done', async () => {
    // The dry run makes no removal, so it cannot know one the operating system
    // will refuse — and the command that does make it exits non-zero on that
    // refusal. A line promising the reclaim is a dry run contradicted by the
    // real pass; a line naming the attempt is true of both.
    const lines = await classify(emptyWorld({ lifelineSockets: sockets({ kind: 'refused' }) }));

    const rendered = formatAuditLine(lines[0]!);
    expect(rendered).toContain('attempts the removal');
    expect(rendered).not.toContain('reclaimed by');
  });

  it('asks a human about one whose connect neither answered nor was refused, and says what stopped it', async () => {
    const lines = await classify(
      emptyWorld({ lifelineSockets: sockets({ kind: 'unknown', reason: 'EACCES' }) })
    );

    expect(formatAuditLine(lines[0]!)).toContain('EACCES');
    expect(auditExitCode(lines, [])).toBe(1);
  });

  it('asks nobody about one whose connect found no file there', async () => {
    // `removeSocketFile` in `scripts/lib/spawn/long-lived.ts` treats this same answer as a
    // no-op, because it names no file there is anything to remove. A line asking a human to
    // clear it would be asking for an act on a file that has already gone.
    //
    // The answer comes from {@link socketAnswerFor}, the function a real connect's error code
    // goes through, so this case fails if that mapping ever stops producing it.
    const lines = await classify(
      emptyWorld({ lifelineSockets: sockets(socketAnswerFor('ENOENT')) })
    );

    expect(auditExitCode(lines, [])).toBe(0);
  });

  it('tells the reader nothing to do about one whose connect found no file there', async () => {
    const lines = await classify(
      emptyWorld({ lifelineSockets: sockets(socketAnswerFor('ENOENT')) })
    );

    expect(formatAuditLine(lines[0]!)).toContain('nothing to do — the connect found no file there');
  });

  it('asks a human about one nothing connected to, because that establishes neither answer', async () => {
    const lines = await classify(emptyWorld({ lifelineSockets: sockets() }));

    expect(formatAuditLine(lines[0]!)).toContain('nothing connected to it');
    expect(auditExitCode(lines, [])).toBe(1);
  });

  it('says what the file is, which its path alone does not', async () => {
    const lines = await classify(emptyWorld({ lifelineSockets: sockets() }));

    expect(lines[0]?.detail).toContain('spawn');
  });
});

describe('classifying a wrangler local store', () => {
  const stranded = path.join('apps', 'api', '.wrangler', 'state', 'v3');

  it('reports a store no stack mode names as unowned', async () => {
    const lines = await classify(emptyWorld({ wranglerStores: [stranded] }));

    expect(lines).toEqual([
      expect.objectContaining({ kind: 'wrangler-state', id: stranded, state: 'unowned' }),
    ]);
  });

  it('says the bring-up reclaims a stranded store rather than asking a human to remove it', async () => {
    const lines = await classify(emptyWorld({ wranglerStores: [stranded] }));

    const rendered = formatAuditLine(lines[0]!);

    expect(rendered).toContain('emptied by the next stack bring-up');
    expect(rendered).not.toContain('remove it by hand');
    expect(auditExitCode(lines, [])).toBe(0);
  });

  it('asks a human for the store a reclaim tried and failed to remove, naming what stopped it', async () => {
    const lines = await classify(
      emptyWorld({
        wranglerStores: [stranded],
        unreclaimedStores: [{ store: stranded, reason: 'EACCES: permission denied' }],
      })
    );

    const rendered = formatAuditLine(lines[0]!);

    expect(rendered).toContain('remove the directory by hand');
    expect(rendered).toContain('EACCES: permission denied');
    expect(auditExitCode(lines, [])).toBe(1);
  });

  it('says nothing about the store a stack mode names, which that stack keeps between runs', async () => {
    const lines = await classify(
      emptyWorld({
        wranglerStores: [path.join('apps', 'api', '.wrangler', 'state', 'development')],
      })
    );

    expect(lines).toEqual([]);
  });
});

describe('reclaiming a stranded wrangler store', () => {
  /** A checkout holding one store a stack mode names and one nothing does. */
  async function twoStores(): Promise<{ stranded: string; named: string }> {
    const stranded = path.join('apps', 'api', '.wrangler', 'state', 'v3');
    const named = path.join('apps', 'api', '.wrangler', 'state', 'development');
    await fs.mkdir(path.join(repoRoot, stranded, 'r2'), { recursive: true });
    await fs.mkdir(path.join(repoRoot, named, 'r2'), { recursive: true });
    return { stranded, named };
  }

  function reclaimingScan(
    reclaimStrandedStores: (store: string) => Promise<string | undefined>
  ): WorldScanDeps {
    return worldScan({ reclaimStrandedStores });
  }

  it('empties the store no stack mode names and leaves the one a mode does', async () => {
    const { stranded, named } = await twoStores();

    await reportWorldAudit(
      reclaimingScan((store) => removeWranglerStore(repoRoot, store)),
      () => undefined,
      registryDir
    );

    expect(await storeContents(stranded)).toEqual([]);
    expect(await storeContents(named)).toEqual(['r2']);
  });

  it('reports what it removed, because a reclaim is something that happened', async () => {
    const { stranded } = await twoStores();
    const printed: string[] = [];

    await reportWorldAudit(
      reclaimingScan((store) => removeWranglerStore(repoRoot, store)),
      (message) => printed.push(message),
      registryDir
    );

    expect(printed.join('\n')).toContain(`reclaimed the wrangler store ${stranded}`);
  });

  it('says of the store it removed what the standing line says of one left behind', async () => {
    await twoStores();
    const printed: string[] = [];

    await reportWorldAudit(
      reclaimingScan((store) => removeWranglerStore(repoRoot, store)),
      (message) => printed.push(message),
      registryDir
    );

    expect(printed.join('\n')).toContain('no invocation this repository makes writes to it');
  });

  it('removes nothing on a pass that was given nothing to remove with', async () => {
    const { stranded } = await twoStores();

    const report = await reportWorldAudit(worldScan(), () => undefined, registryDir);

    expect(await storeExists(stranded)).toBe(true);
    expect(report.lines.map((found) => found.id)).toContain(stranded);
  });

  it('reclaims a stranded store while another run of this checkout is live', async () => {
    const { stranded } = await twoStores();
    const reclaim = vi.fn((store: string) => removeWranglerStore(repoRoot, store));

    await withLiveRun(
      async () => {
        // The pass runs outside that run rather than inside it, which is the
        // arrangement that used to defer: a live run somebody else holds.
        const runDir = process.env[RUN_CLAIM_ENV] ?? '';
        vi.stubEnv(RUN_CLAIM_ENV, '');
        await reportWorldAudit(reclaimingScan(reclaim), () => undefined, registryDir);
        vi.stubEnv(RUN_CLAIM_ENV, runDir);
      },
      () => Promise.resolve()
    );

    expect(reclaim).toHaveBeenCalledWith(stranded);
    expect(await storeContents(stranded)).toEqual([]);
  });

  it('reclaims a stranded store while a live run\u2019s record cannot be read', async () => {
    const { stranded } = await twoStores();
    const reclaim = vi.fn((store: string) => removeWranglerStore(repoRoot, store));

    await withLiveRun(async () => {
      const runDir = process.env[RUN_CLAIM_ENV] ?? '';
      vi.stubEnv(RUN_CLAIM_ENV, '');
      await reportWorldAudit(reclaimingScan(reclaim), () => undefined, registryDir);
      vi.stubEnv(RUN_CLAIM_ENV, runDir);
    }, damageOwnRecord);

    expect(reclaim).toHaveBeenCalledWith(stranded);
    expect(await storeContents(stranded)).toEqual([]);
  });

  it('names every stranded store it found on a housekeeping pass, so one that stood is never silent', async () => {
    const { stranded } = await twoStores();
    const printed: string[] = [];

    await reportWorldAudit(
      reclaimingScan(() => Promise.resolve('EACCES: permission denied')),
      (message) => printed.push(message),
      registryDir,
      'what-must-be-done'
    );

    expect(printed.join('\n')).toContain(stranded);
  });

  it('leaves a store it could not remove standing, and asks a human for that one', async () => {
    const { stranded } = await twoStores();

    const report = await reportWorldAudit(
      reclaimingScan(() => Promise.resolve('EACCES: permission denied')),
      () => undefined,
      registryDir
    );

    expect(await storeExists(stranded)).toBe(true);
    expect(auditExitCode(report.lines, report.unreadable)).toBe(1);
  });

  it('says what stopped a removal rather than reporting the store as removed', async () => {
    await twoStores();

    const report = await reportWorldAudit(
      reclaimingScan(() => Promise.resolve('EACCES: permission denied')),
      () => undefined,
      registryDir
    );

    expect(formatAuditLine(report.lines[0]!)).toContain('EACCES: permission denied');
  });

  it('answers with the reason a removal threw rather than throwing at the caller', async () => {
    const { named } = await twoStores();
    // A directory standing where the store's own parent must be: the removal
    // is asked for a path whose parent is a file, which is the shape of every
    // failure this returns rather than raises.
    const wedged = path.join(named, 'r2', 'not-a-directory');
    await fs.writeFile(path.join(repoRoot, wedged), 'not a directory');

    const reason = await removeWranglerStore(repoRoot, path.join(wedged, 'store'));

    expect(reason).toContain('ENOTDIR');
  });
});

describe('a wrangler store a process is inside', () => {
  const stranded = path.join('apps', 'api', '.wrangler', 'state', 'v3');
  const second = path.join('.wrangler', 'state', 'v3');

  /** Two stores no stack mode names, so one can be spared while the other goes. */
  async function twoStranded(): Promise<void> {
    await fs.mkdir(path.join(repoRoot, stranded, 'r2'), { recursive: true });
    await fs.mkdir(path.join(repoRoot, second, 'r2'), { recursive: true });
  }

  it('leaves the store a process holds open and reclaims the one nothing is inside', async () => {
    await twoStranded();

    await reportWorldAudit(
      reclaimingPass({
        probeStore: (store): Promise<StoreAnswer> =>
          Promise.resolve(store === stranded ? { kind: 'occupied' } : { kind: 'vacant' }),
      }),
      () => undefined,
      registryDir
    );

    expect(await storeContents(stranded)).toEqual(['r2']);
    expect(await storeContents(second)).toEqual([]);
  });

  it('says something is inside the store it left, and asks nobody to do anything', async () => {
    await twoStranded();

    const report = await reportWorldAudit(
      reclaimingPass({
        probeStore: (): Promise<StoreAnswer> => Promise.resolve({ kind: 'occupied' }),
      }),
      () => undefined,
      registryDir
    );

    const rendered = report.lines.map((found) => formatAuditLine(found));
    expect(rendered[0]).toContain('a process holds a file open inside it');
    expect(rendered[0]).toContain('the next stack bring-up');
    expect(rendered.join('\n')).not.toContain('by hand');
    expect(auditExitCode(report.lines, report.unreadable)).toBe(0);
  });

  it('leaves the store standing where the question could not be answered, and says so', async () => {
    await twoStranded();

    const report = await reportWorldAudit(
      reclaimingPass({
        probeStore: (): Promise<StoreAnswer> =>
          Promise.resolve({ kind: 'unknown', reason: 'nothing to ask' }),
      }),
      () => undefined,
      registryDir
    );

    expect(await storeExists(stranded)).toBe(true);
    expect(formatAuditLine(report.lines[0]!)).toContain('could not be asked (nothing to ask)');
    expect(auditExitCode(report.lines, report.unreadable)).toBe(0);
  });

  it('cannot put the question on a platform with no process filesystem', async () => {
    await twoStranded();

    const report = await reportWorldAudit(
      reclaimingPass({ platform: 'darwin', probeStore: undefined }),
      () => undefined,
      registryDir
    );

    expect(await storeExists(stranded)).toBe(true);
    expect(formatAuditLine(report.lines[0]!)).toContain('no process filesystem');
  });

  it('names the store it left standing on the pass that prints only what it did', async () => {
    await twoStranded();
    const printed: string[] = [];

    await reportWorldAudit(
      reclaimingPass({
        probeStore: (): Promise<StoreAnswer> => Promise.resolve({ kind: 'occupied' }),
      }),
      (message) => printed.push(message),
      registryDir,
      'what-must-be-done'
    );

    expect(printed.join('\n')).toContain(stranded);
    expect(printed.join('\n')).toContain('a process holds a file open inside it');
  });

  it('puts the question to nothing on a checkout whose every store a stack mode names', async () => {
    await fs.mkdir(path.join(repoRoot, 'apps', 'api', '.wrangler', 'state', 'development'), {
      recursive: true,
    });
    const probeStore = vi.fn((): Promise<StoreAnswer> => Promise.resolve({ kind: 'vacant' }));

    await reportWorldAudit(reclaimingPass({ probeStore }), () => undefined, registryDir);

    expect(probeStore).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === 'linux')(
    'spares a store this very process holds a file open inside',
    async () => {
      await twoStranded();
      const held = await fs.open(path.join(repoRoot, stranded, 'r2', 'held'), 'w');

      try {
        const report = await reportWorldAudit(
          reclaimingPass({ probeStore: undefined }),
          () => undefined,
          registryDir
        );

        expect(await storeExists(stranded)).toBe(true);
        expect(formatAuditLine(report.lines[0]!)).toContain(
          'a process holds a file open inside it'
        );
      } finally {
        await held.close();
      }
    }
  );

  it.runIf(process.platform === 'linux')(
    'reclaims a store no process holds open, on the same question',
    async () => {
      await twoStranded();

      await reportWorldAudit(
        reclaimingPass({ probeStore: undefined }),
        () => undefined,
        registryDir
      );

      expect(await storeContents(stranded)).toEqual([]);
      expect(await storeContents(second)).toEqual([]);
    }
  );

  it.runIf(process.platform === 'linux')(
    'reads a descriptor into a store that has since been deleted as nothing holding it',
    async () => {
      await twoStranded();
      const file = path.join(repoRoot, stranded, 'r2', 'held');
      const held = await fs.open(file, 'w');

      try {
        await fs.rm(file);

        await reportWorldAudit(
          reclaimingPass({ probeStore: undefined }),
          () => undefined,
          registryDir
        );

        expect(await storeContents(stranded)).toEqual([]);
      } finally {
        await held.close();
      }
    }
  );
});

describe('the barrier a reclaim leaves where the store was', () => {
  const stranded = path.join('apps', 'api', '.wrangler', 'state', 'v3');

  /** Gives the owner of a directory the write permission back. */
  async function letTheOwnerWrite(directory: string): Promise<void> {
    const found = await fs.stat(directory);
    await fs.chmod(directory, found.mode | OWNER_WRITE);
  }

  /** A checkout holding one store nothing names, with something in it. */
  async function oneStranded(): Promise<void> {
    await fs.mkdir(path.join(repoRoot, stranded, 'r2'), { recursive: true });
  }

  it('leaves the store standing with nothing in it', async () => {
    await oneStranded();

    await reportWorldAudit(reclaimingPass(), () => undefined, registryDir);

    expect(await storeExists(stranded)).toBe(true);
    expect(await storeContents(stranded)).toEqual([]);
  });

  it.runIf(process.platform === 'linux')(
    'refuses a write in the directory it left standing',
    async () => {
      await oneStranded();

      await reportWorldAudit(reclaimingPass(), () => undefined, registryDir);

      await expect(fs.mkdir(path.join(repoRoot, stranded, 'r2'))).rejects.toThrow(/EACCES/);
    }
  );

  it('says what stands there now on the line that reports the reclaim', async () => {
    await oneStranded();
    const printed: string[] = [];

    await reportWorldAudit(reclaimingPass(), (message) => printed.push(message), registryDir);

    expect(printed.join('\n')).toContain('no write permission');
  });

  it('says on that line where the barrier holds, since a permission is the platform’s to enforce', async () => {
    await oneStranded();
    const printed: string[] = [];

    await reportWorldAudit(reclaimingPass(), (message) => printed.push(message), registryDir);

    expect(printed.join('\n')).toContain('wherever the platform enforces one');
  });

  it.runIf(process.platform === 'linux')(
    'leaves a store something is inside able to take a write',
    async () => {
      await oneStranded();

      await reportWorldAudit(
        reclaimingPass({
          probeStore: (): Promise<StoreAnswer> => Promise.resolve({ kind: 'occupied' }),
        }),
        () => undefined,
        registryDir
      );

      await fs.mkdir(path.join(repoRoot, stranded, 'kv'));
      expect(await storeContents(stranded)).toContain('r2');
    }
  );

  it('reports nothing about the barrier a previous pass left', async () => {
    await oneStranded();
    await reportWorldAudit(reclaimingPass(), () => undefined, registryDir);
    const printed: string[] = [];

    const report = await reportWorldAudit(
      reclaimingPass(),
      (message) => printed.push(message),
      registryDir
    );

    expect(report.lines.map((found) => found.id)).not.toContain(stranded);
    expect(printed.join('\n')).not.toContain(stranded);
  });

  it('asks nobody to act on a barrier a previous pass left', async () => {
    await oneStranded();
    await reportWorldAudit(reclaimingPass(), () => undefined, registryDir);

    const report = await reportWorldAudit(reclaimingPass(), () => undefined, registryDir);

    expect(auditExitCode(report.lines, report.unreadable)).toBe(0);
  });

  it('puts the question to nothing where every store found is a barrier', async () => {
    await oneStranded();
    await reportWorldAudit(reclaimingPass(), () => undefined, registryDir);
    const probeStore = vi.fn((): Promise<StoreAnswer> => Promise.resolve({ kind: 'vacant' }));

    await reportWorldAudit(reclaimingPass({ probeStore }), () => undefined, registryDir);

    expect(probeStore).not.toHaveBeenCalled();
  });

  it('reclaims a store whose write permission was put back', async () => {
    await oneStranded();
    await reportWorldAudit(reclaimingPass(), () => undefined, registryDir);
    await letTheOwnerWrite(path.join(repoRoot, stranded));
    await fs.mkdir(path.join(repoRoot, stranded, 'r2'));
    const printed: string[] = [];

    await reportWorldAudit(reclaimingPass(), (message) => printed.push(message), registryDir);

    expect(printed.join('\n')).toContain(`reclaimed the wrangler store ${stranded}`);
  });

  it('says what will stand there on the line for a store nothing has removed yet', async () => {
    await oneStranded();

    const report = await reportWorldAudit(worldScan(), () => undefined, registryDir);

    expect(formatAuditLine(report.lines[0]!)).toContain('no write permission');
  });

  it.runIf(process.platform === 'linux')(
    'asks a human about a store nothing can write that still holds something',
    async () => {
      await oneStranded();
      const directory = path.join(repoRoot, stranded);
      const found = await fs.stat(directory);
      await fs.chmod(directory, found.mode & ~WRITE_PERMISSIONS);

      try {
        const report = await reportWorldAudit(reclaimingPass(), () => undefined, registryDir);

        expect(formatAuditLine(report.lines[0]!)).toContain('remove the directory by hand');
        expect(auditExitCode(report.lines, report.unreadable)).toBe(1);
      } finally {
        // The suite's own teardown removes this tree, and a directory holding
        // something is one nothing can empty while it carries this permission.
        await letTheOwnerWrite(directory);
      }
    }
  );

  it('lets an ordinary recursive removal take the barrier away', async () => {
    await oneStranded();
    await reportWorldAudit(reclaimingPass(), () => undefined, registryDir);

    await fs.rm(path.join(repoRoot, stranded), { recursive: true, force: true });

    expect(await storeExists(stranded)).toBe(false);
  });
});

describe('an E2E RAM root whose checkout is gone', () => {
  /** A filesystem reading that admits any root, so making one asks nothing of the machine's. */
  const anyTmpfs: ReadStatfs = () => Promise.resolve({ type: TMPFS_MAGIC, bsize: 1, bavail: 0 });

  /** A checkout path nothing stands at. */
  function goneCheckout(name = 'gone'): string {
    return path.join(repoRoot, 'checkouts', name);
  }

  /** A checkout path a directory stands at. */
  async function liveCheckout(): Promise<string> {
    const checkout = path.join(repoRoot, 'checkouts', 'live');
    await fs.mkdir(checkout, { recursive: true });
    return checkout;
  }

  /**
   * Makes the RAM root of `checkout` on the scratch RAM filesystem the way an
   * E2E bring-up of that checkout on `host` does, with a file in its persist root.
   */
  async function plantRoot(checkout: string, host = scratchRamHost()): Promise<string> {
    const paths = await prepareRamRoot(checkout, 0, { host, statfs: anyTmpfs });
    if (paths === undefined) throw new Error('a Linux host always yields a RAM root');
    await fs.mkdir(paths.persist, { recursive: true });
    await fs.writeFile(path.join(paths.persist, 'left-behind.sqlite'), 'held');
    return paths.root;
  }

  async function exists(directory: string): Promise<boolean> {
    try {
      await fs.stat(directory);
      return true;
    } catch {
      return false;
    }
  }

  it('is removed by a pass that may change something', async () => {
    const root = await plantRoot(goneCheckout());

    await reportWorldAudit(reclaimingPass(), () => undefined, registryDir);

    expect(await exists(root)).toBe(false);
  });

  it('is reported as a stranded RAM root nobody owns', async () => {
    const root = await plantRoot(goneCheckout());

    const report = await reportWorldAudit(worldScan(), () => undefined, registryDir);

    expect(report.lines).toEqual([
      expect.objectContaining({ kind: 'ram-root', id: root, state: 'unowned' }),
    ]);
  });

  it('is left standing by a pass that was given nothing to remove with', async () => {
    const root = await plantRoot(goneCheckout());

    const report = await reportWorldAudit(worldScan(), () => undefined, registryDir);

    expect(report.lines.map((found) => found.id)).toContain(root);
    expect(await exists(root)).toBe(true);
  });

  it('is named on the line that reports the reclaim', async () => {
    const root = await plantRoot(goneCheckout());
    const printed: string[] = [];

    await reportWorldAudit(reclaimingPass(), (message) => printed.push(message), registryDir);

    expect(printed.join('\n')).toContain(`reclaimed the E2E RAM root ${root}`);
  });

  it('is the only root a pass takes where another root’s checkout still stands', async () => {
    const stranded = await plantRoot(goneCheckout());
    const current = await plantRoot(await liveCheckout());

    await reportWorldAudit(reclaimingPass(), () => undefined, registryDir);

    expect(await exists(stranded)).toBe(false);
    expect(await exists(current)).toBe(true);
  });

  it('is the only directory a pass takes where a root-named one carries no owner file', async () => {
    const stranded = await plantRoot(goneCheckout());
    const unowned = ramPathsFor(goneCheckout('never-claimed'), scratchRamHost())?.root ?? '';
    await fs.mkdir(path.join(unowned, 'persist'), { recursive: true });

    await reportWorldAudit(reclaimingPass(), () => undefined, registryDir);

    expect(await exists(stranded)).toBe(false);
    expect(await exists(unowned)).toBe(true);
  });

  it('is the only directory a pass takes where one no root is named like holds an owner file', async () => {
    const stranded = await plantRoot(goneCheckout());
    const foreign = path.join(ramParent, 'another-program');
    await fs.mkdir(foreign);
    await fs.copyFile(
      path.join(stranded, RAM_ROOT_OWNER_FILE),
      path.join(foreign, RAM_ROOT_OWNER_FILE)
    );

    await reportWorldAudit(reclaimingPass(), () => undefined, registryDir);

    expect(await exists(stranded)).toBe(false);
    expect(await exists(foreign)).toBe(true);
  });

  it('is the only root a pass takes where another was claimed in another mount namespace', async () => {
    const stranded = await plantRoot(goneCheckout());
    const elsewhere = await plantRoot(goneCheckout('elsewhere'), {
      ...scratchRamHost(),
      mountNamespace: () => Promise.resolve('mnt:[2]'),
    });

    await reportWorldAudit(reclaimingPass(), () => undefined, registryDir);

    expect(await exists(stranded)).toBe(false);
    expect(await exists(elsewhere)).toBe(true);
  });

  it('is the only root a pass takes where another records no mount namespace', async () => {
    const stranded = await plantRoot(goneCheckout());
    const unrecorded = await plantRoot(goneCheckout('unrecorded'), {
      platform: 'linux',
      parent: ramParent,
    });

    await reportWorldAudit(reclaimingPass(), () => undefined, registryDir);

    expect(await exists(stranded)).toBe(false);
    expect(await exists(unrecorded)).toBe(true);
  });

  it('is left standing by a pass on a host that states no mount namespace, like its own', async () => {
    const statesNone: RamRootHost = { platform: 'linux', parent: ramParent };
    const root = await plantRoot(goneCheckout(), statesNone);

    await reportWorldAudit(reclaimingPass({ ramHost: statesNone }), () => undefined, registryDir);

    expect(await exists(root)).toBe(true);
  });

  it('is not reported where it was claimed in another mount namespace', async () => {
    await plantRoot(goneCheckout(), {
      ...scratchRamHost(),
      mountNamespace: () => Promise.resolve('mnt:[2]'),
    });

    const report = await reportWorldAudit(worldScan(), () => undefined, registryDir);

    expect(report.lines).toEqual([]);
  });

  it('is removed where a file stands in the way of its checkout path', async () => {
    await fs.writeFile(path.join(repoRoot, 'a-file'), 'not a directory');
    const root = await plantRoot(path.join(repoRoot, 'a-file', 'checkout'));

    await reportWorldAudit(reclaimingPass(), () => undefined, registryDir);

    expect(await exists(root)).toBe(false);
  });

  it.runIf(process.platform === 'linux' && process.getuid?.() !== 0)(
    'is left standing, with the class reported unread, where its checkout path cannot be looked at',
    async () => {
      const locked = path.join(repoRoot, 'locked');
      await fs.mkdir(locked);
      const root = await plantRoot(path.join(locked, 'checkout'));
      const { mode } = await fs.stat(locked);
      await fs.chmod(locked, 0o000);

      try {
        const report = await reportWorldAudit(reclaimingPass(), () => undefined, registryDir);

        expect(await exists(root)).toBe(true);
        expect(report.unreadable).toEqual([expect.stringMatching(/^E2E RAM roots: EACCES/)]);
      } finally {
        // The suite's teardown removes this tree, which it cannot enter without this.
        await fs.chmod(locked, mode);
      }
    }
  );

  it('is looked for only on Linux, where the roots are made', async () => {
    const root = await plantRoot(goneCheckout());

    await reportWorldAudit(
      reclaimingPass({ ramHost: { platform: 'darwin', parent: ramParent } }),
      () => undefined,
      registryDir
    );
    const leftOffLinux = await exists(root);
    await reportWorldAudit(reclaimingPass(), () => undefined, registryDir);

    expect(leftOffLinux).toBe(true);
    expect(await exists(root)).toBe(false);
  });

  it('is said to be removed by the bring-up, with nobody asked to act', async () => {
    const root = await plantRoot(goneCheckout());

    const report = await reportWorldAudit(worldScan(), () => undefined, registryDir);

    const rendered = formatAuditLine(report.lines[0]!);
    expect(rendered).toContain(`removed by the next stack bring-up`);
    expect(rendered).toContain(root);
    expect(auditExitCode(report.lines, report.unreadable)).toBe(0);
  });

  it('is said to belong to the checkout its owner file names, not to a stack mode', async () => {
    await plantRoot(goneCheckout());

    const report = await reportWorldAudit(worldScan(), () => undefined, registryDir);

    const rendered = formatAuditLine(report.lines[0]!);
    expect(rendered).toContain('the checkout its owner file names');
    expect(rendered).not.toContain('stack mode');
  });

  it('is never said to be left behind as a barrier inside this checkout', async () => {
    await plantRoot(goneCheckout());

    const report = await reportWorldAudit(worldScan(), () => undefined, registryDir);

    const rendered = formatAuditLine(report.lines[0]!);
    expect(rendered).not.toContain('inside this checkout');
    expect(rendered).not.toContain('no write permission');
  });

  it('is put in front of a human when the removal fails, naming what stopped it', async () => {
    await plantRoot(goneCheckout());

    const report = await reportWorldAudit(
      reclaimingPass({ reclaimStrandedStores: () => Promise.resolve('EACCES: permission denied') }),
      () => undefined,
      registryDir
    );

    const rendered = formatAuditLine(report.lines[0]!);
    expect(rendered).toContain('remove the directory by hand');
    expect(rendered).toContain('EACCES: permission denied');
    expect(rendered).toContain('the checkout its owner file names');
    expect(auditExitCode(report.lines, report.unreadable)).toBe(1);
  });

  it.runIf(process.platform === 'linux')(
    'is spared while this very process holds a file open inside it',
    async () => {
      const root = await plantRoot(goneCheckout());
      const held = await fs.open(path.join(root, 'persist', 'left-behind.sqlite'), 'r');

      try {
        const report = await reportWorldAudit(
          reclaimingPass({ probeStore: undefined }),
          () => undefined,
          registryDir
        );

        expect(await exists(root)).toBe(true);
        expect(formatAuditLine(report.lines[0]!)).toContain(
          'a process holds a file open inside it'
        );
      } finally {
        await held.close();
      }
    }
  );

  it.runIf(process.platform === 'linux')(
    'is removed once the machine says no process holds anything open inside it',
    async () => {
      const root = await plantRoot(goneCheckout());

      await reportWorldAudit(
        reclaimingPass({ probeStore: undefined }),
        () => undefined,
        registryDir
      );

      expect(await exists(root)).toBe(false);
    }
  );
});

describe('the exit verdict', () => {
  it('is clean when everything is owned', async () => {
    const lines = await withLiveRun(
      () => classify(emptyWorld({ containers: found('hushbox-emulator-0') })),
      () => addResource({ kind: 'container', id: 'hushbox-emulator-0' })
    );

    expect(auditExitCode(lines, [])).toBe(0);
  });

  it('is non-zero on an unowned resource', async () => {
    const lines = await classify(emptyWorld({ containers: found('hushbox-emulator-0') }));

    expect(auditExitCode(lines, [])).toBe(1);
  });

  it('is clean on an unowned purge aside, which is removed rather than reported', async () => {
    const lines = await classify(emptyWorld({ asides: ['test-results.purge-0'] }));

    expect(lines[0]?.state).toBe('unowned');
    expect(auditExitCode(lines, [])).toBe(0);
  });

  it('is clean on a wrangler store no stack mode names, which the bring-up reclaims', async () => {
    const lines = await classify(
      emptyWorld({ wranglerStores: [path.join('apps', 'api', '.wrangler', 'state', 'v3')] })
    );

    expect(lines[0]?.state).toBe('unowned');
    expect(auditExitCode(lines, [])).toBe(0);
  });

  it('is non-zero when a class could not be read, because nothing was certified', () => {
    expect(auditExitCode([], ['buckets: connection refused'])).toBe(1);
  });

  it('is clean on the idle-killer’s sentinel, which the same line tells the reader to leave', async () => {
    const sentinel = portFor('idleDaemon', { slot: 3, mode: 'development' });

    const lines = await classify(
      emptyWorld({
        listeningPorts: listening(sentinel),
        daemonPorts: [{ port: sentinel, identity: { kind: 'this-stack' } }],
      })
    );

    expect(lines[0]?.state).toBe('unowned');
    expect(auditExitCode(lines, [])).toBe(0);
  });

  it('counts nothing whose repair tells the reader to leave it alone', async () => {
    const lines = await classify(
      emptyWorld({
        containers: found('hushbox-emulator-0'),
        buckets: ['hushbox-scratch-ab12cd34ef-one'],
        listeningPorts: listening(
          portFor('idleDaemon', { slot: 3, mode: 'development' }),
          portFor('vite', { slot: 3, mode: 'development' })
        ),
        daemonPorts: [
          {
            port: portFor('idleDaemon', { slot: 3, mode: 'development' }),
            identity: { kind: 'this-stack' },
          },
        ],
        asides: ['test-results.purge-0'],
        wranglerStores: [path.join('apps', 'api', '.wrangler', 'state', 'v3')],
      })
    );

    const leaveAlone = lines.filter((found) => formatAuditLine(found).includes('leave it'));

    expect(leaveAlone).toHaveLength(1);
    expect(auditExitCode(leaveAlone, [])).toBe(0);
  });
});

describe('the report line', () => {
  it('names no file as defective when nothing claims the resource', async () => {
    const lines = await classify(emptyWorld({ containers: found('hushbox-emulator-0') }));

    const rendered = formatAuditLine(lines[0]!);
    expect(rendered).not.toContain('defect');
    expect(rendered).not.toContain('mobile-image.ts');
  });

  it('says a process holding no run claim is what leaves an unrecorded resource', async () => {
    const lines = await classify(emptyWorld({ containers: found('hushbox-emulator-0') }));

    expect(formatAuditLine(lines[0]!)).toContain('held no run claim');
  });

  it('tells the reader to remove an unclaimed staging database rather than blaming a file that claims one', async () => {
    const lines = await classify(emptyWorld({ databases: ['hb_stage_abc1234def567890'] }));

    const rendered = formatAuditLine(lines[0]!);
    expect(rendered).not.toContain('spawner defect');
    expect(rendered).not.toContain('test-db-provision.ts');
    expect(rendered).toContain('remove it by hand');
  });

  it('blames no file for an unclaimed per-worker database either, since provisioning claims one', async () => {
    const lines = await classify(emptyWorld({ databases: ['hb_t_ab12cd34ef_w1'] }));

    const rendered = formatAuditLine(lines[0]!);
    expect(rendered).not.toContain('defect');
    expect(rendered).not.toContain('test-db-provision.ts');
  });

  it('says what reclaims an unclaimed per-worker database rather than asking a human to remove one', async () => {
    const lines = await classify(emptyWorld({ databases: ['hb_t_ab12cd34ef_w1'] }));

    const rendered = formatAuditLine(lines[0]!);
    expect(rendered).toContain('reclaimed by `pnpm test`');
    expect(rendered).not.toContain('remove it by hand');
  });

  it('names both readings that reclaim an unclaimed per-worker database, since one waits and one does not', async () => {
    const lines = await classify(emptyWorld({ databases: ['hb_t_ab12cd34ef_w1'] }));

    const rendered = formatAuditLine(lines[0]!);
    expect(rendered).toContain('creation stamp cannot be read');
    expect(rendered).toContain('pre-registry');
  });

  it('asks nobody to act on an unclaimed per-worker database, since a sweep takes every one of them', async () => {
    const lines = await classify(emptyWorld({ databases: ['hb_t_ab12cd34ef_w1'] }));

    expect(auditExitCode(lines, [])).toBe(0);
  });

  it('names the flag that ends an unclaimed port rather than promising nothing ends one', async () => {
    const lines = await classify(emptyWorld({ listeningPorts: listening(10_003) }));

    const rendered = formatAuditLine(lines[0]!);
    expect(rendered).not.toContain('nothing reclaims one no claim names');
    expect(rendered).toContain('--unowned');
  });

  it('names the run an unattributable staging database was staged by, when its name carries one', async () => {
    const lines = await classify(
      emptyWorld({ databases: [mintStageDatabaseName(runTokenFor(FOREIGN_RUN))] })
    );

    expect(formatAuditLine(lines[0]!)).toContain(`its name names run ${FOREIGN_RUN}`);
  });

  it('still says nothing recorded a staging database whose name carries no run', async () => {
    const lines = await classify(emptyWorld({ databases: ['hb_stage_abc1234def567890'] }));

    expect(formatAuditLine(lines[0]!)).toContain('its name carries no run');
  });

  it('asks a human to remove an unattributable staging database whichever spelling names it', async () => {
    const lines = await classify(
      emptyWorld({ databases: [mintStageDatabaseName(runTokenFor(FOREIGN_RUN))] })
    );

    const rendered = formatAuditLine(lines[0]!);
    expect(rendered).toContain('remove it by hand');
    expect(auditExitCode(lines, [])).toBe(1);
  });

  it('holds the exit code open on an unclaimed staging database, since only a human removes one', async () => {
    const lines = await classify(emptyWorld({ databases: ['hb_stage_abc1234def567890'] }));

    expect(auditExitCode(lines, [])).toBe(1);
  });

  it('names the owning run and needs no repair when a live run owns it', async () => {
    const lines = await withLiveRun(
      () => classify(emptyWorld({ containers: found('hushbox-emulator-0') })),
      () => addResource({ kind: 'container', id: 'hushbox-emulator-0' })
    );

    const rendered = formatAuditLine(lines[0]!);
    expect(rendered).toContain('pnpm dev');
    expect(rendered).toContain('nothing to do');
  });

  it('says what reclaims a stranded wrangler store rather than telling the reader to claim it', async () => {
    const lines = await classify(
      emptyWorld({ wranglerStores: [path.join('apps', 'api', '.wrangler', 'state', 'v3')] })
    );

    const rendered = formatAuditLine(lines[0]!);
    expect(rendered).toContain('emptied by the next stack bring-up');
    expect(rendered).not.toContain('remove it by hand');
  });

  it('names what reclaims a resource whose owner is gone', async () => {
    await leaveExpiredClaim(() => addResource({ kind: 'container', id: 'hushbox-emulator-0' }));

    const lines = await classify(emptyWorld({ containers: found('hushbox-emulator-0') }));

    expect(formatAuditLine(lines[0]!)).toContain('pnpm docker:cleanup');
  });
});

/**
 * Runs `body` with a scratch directory standing in for the RAM filesystem, so a
 * snapshot planted for the scan to find is made there and never on the
 * machine's own.
 */
async function withScratchRamHost<T>(body: (ramHost: RamRootHost) => Promise<T>): Promise<T> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-audit-ram-'));
  try {
    return await body({ platform: 'linux', parent });
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
}

describe('reading the world', () => {
  it('probes each snapshot directory’s own lock and ignores the lock files beside them', async () => {
    const world = await withScratchRamHost(async (ramHost) => {
      const snapshots = snapshotsDir(repoRoot, ramHost);
      await fs.mkdir(path.join(snapshots, 'web-dist-1'), { recursive: true });
      await fs.writeFile(path.join(snapshots, 'web-dist-1.lock'), 'pnpm e2e');

      return scanWorld({
        repoRoot,
        ramHost,
        stack: auditedStack(),
        containers: () => Promise.resolve([]),
        containerAges: NO_AGE_SOURCE,
        stuckContainers: () => Promise.resolve([]),
        databases: () => Promise.resolve([]),
        buckets: () => Promise.resolve([]),
        listeningPorts: () => Promise.resolve([]),
        listenerAge: NO_AGE_SOURCE,
        lifelineSockets: () => Promise.resolve([]),
        composeProjects: () => Promise.resolve(noProjects()),
      });
    });

    expect(world.snapshots).toEqual([{ id: 'web-dist-1', held: false, holder: null }]);
  });

  /** Mints a purge aside beside `outputDir` the way an E2E run's reset does, answering its name. */
  async function mintAside(outputDir: string): Promise<string> {
    await fs.mkdir(outputDir, { recursive: true });
    const aside = await findFreeAsideName(path.dirname(outputDir), path.basename(outputDir));
    await fs.mkdir(path.join(path.dirname(outputDir), aside));
    return aside;
  }

  it('finds the purge asides minted beside the output directory of the checkout it reads', async () => {
    const ramHost = scratchRamHost();
    const aside = await mintAside(ramPathsFor(repoRoot, ramHost)?.testResults ?? '');

    const world = await scanWorld(worldScan({ ramHost }), registryDir);

    expect(world.asides).toEqual([aside]);
  });

  it('passes over the asides beside the output directory of the checkout these scripts run from', async () => {
    const ramHost = scratchRamHost();
    await mintAside(e2eOutputDir(ramHost));

    const world = await scanWorld(worldScan({ ramHost }), registryDir);

    expect(world.asides).toEqual([]);
  });

  it('finds the purge asides beside the checkout’s own output directory off Linux', async () => {
    const aside = await mintAside(path.join(repoRoot, 'test-results'));

    const world = await scanWorld(
      worldScan({ ramHost: { platform: 'darwin', parent: ramParent } }),
      registryDir
    );

    expect(world.asides).toEqual([aside]);
  });

  it('finds the wrangler state directories of the repository root and of every app', async () => {
    await fs.mkdir(path.join(repoRoot, '.wrangler', 'state', 'v3'), { recursive: true });
    await fs.mkdir(path.join(repoRoot, 'apps', 'api', '.wrangler', 'state', 'development'), {
      recursive: true,
    });
    await fs.mkdir(path.join(repoRoot, 'apps', 'web'), { recursive: true });

    const world = await scanWorld({
      repoRoot,
      ramHost: scratchRamHost(),
      stack: auditedStack(),
      containers: () => Promise.resolve([]),
      containerAges: NO_AGE_SOURCE,
      stuckContainers: () => Promise.resolve([]),
      databases: () => Promise.resolve([]),
      buckets: () => Promise.resolve([]),
      listeningPorts: () => Promise.resolve([]),
      listenerAge: NO_AGE_SOURCE,
      lifelineSockets: () => Promise.resolve([]),
      composeProjects: () => Promise.resolve(noProjects()),
    });

    expect([...world.wranglerStores].toSorted((a, b) => a.localeCompare(b))).toEqual([
      path.join('.wrangler', 'state', 'v3'),
      path.join('apps', 'api', '.wrangler', 'state', 'development'),
    ]);
  });

  it('takes only the directories of a state tree, so a seed receipt beside them is not a store', async () => {
    const state = path.join(repoRoot, '.wrangler', 'state');
    await fs.mkdir(path.join(state, 'v3'), { recursive: true });
    await fs.writeFile(path.join(state, 'model-weights-seed.json'), '{}');

    const world = await scanWorld({
      repoRoot,
      ramHost: scratchRamHost(),
      stack: auditedStack(),
      containers: () => Promise.resolve([]),
      containerAges: NO_AGE_SOURCE,
      stuckContainers: () => Promise.resolve([]),
      databases: () => Promise.resolve([]),
      buckets: () => Promise.resolve([]),
      listeningPorts: () => Promise.resolve([]),
      listenerAge: NO_AGE_SOURCE,
      lifelineSockets: () => Promise.resolve([]),
      composeProjects: () => Promise.resolve(noProjects()),
    });

    expect(world.wranglerStores).toEqual([path.join('.wrangler', 'state', 'v3')]);
  });

  it('records the class it could not read instead of failing the whole audit', async () => {
    const world = await scanWorld({
      repoRoot,
      ramHost: scratchRamHost(),
      stack: auditedStack(),
      containers: () => Promise.reject(new Error('docker is not running')),
      containerAges: NO_AGE_SOURCE,
      stuckContainers: () => Promise.resolve([]),
      databases: () => Promise.resolve(['hb_t_ab12cd34ef_w1']),
      buckets: () => Promise.resolve([]),
      listeningPorts: () => Promise.resolve([]),
      listenerAge: NO_AGE_SOURCE,
      lifelineSockets: () => Promise.resolve([]),
      composeProjects: () => Promise.resolve(noProjects()),
    });

    expect(world.unreadable).toEqual(['containers: docker is not running']);
    expect(world.databases).toEqual(['hb_t_ab12cd34ef_w1']);
  });

  it('reports a released claim’s leftover lock file as a free snapshot, never as a live one', async () => {
    const world = await withScratchRamHost(async (ramHost) => {
      const snapshots = snapshotsDir(repoRoot, ramHost);
      await fs.mkdir(snapshots, { recursive: true });
      await fs.writeFile(path.join(snapshots, 'web-dist-gone.lock'), 'pnpm e2e');

      return scanWorld({
        repoRoot,
        ramHost,
        stack: auditedStack(),
        containers: () => Promise.resolve([]),
        containerAges: NO_AGE_SOURCE,
        stuckContainers: () => Promise.resolve([]),
        databases: () => Promise.resolve([]),
        buckets: () => Promise.resolve([]),
        listeningPorts: () => Promise.resolve([]),
        listenerAge: NO_AGE_SOURCE,
        lifelineSockets: () => Promise.resolve([]),
        composeProjects: () => Promise.resolve(noProjects()),
      });
    });

    expect(world.snapshots).toEqual([]);
  });
});

describe('the registry the audit reads', () => {
  it('classifies by the lock and not by a claim file being present', async () => {
    const runId = await registerRun(init(), async () => {
      await addResource({ kind: 'container', id: 'hushbox-emulator-0' });
      return currentRunId()!;
    });

    // A released claim leaves its lock file behind, carrying the last holder's
    // name; reading that as a claim would make every finished run look live.
    // The name is that file's first line — asserted as the line rather than as
    // something the file contains, because the primitive never shortens the
    // file and containment would pass on one whose first line is something
    // else entirely.
    const left = await fs.readFile(lockPathFor(registryDir, runId), 'utf8');
    expect(left.split('\n')[0]).toBe('pnpm dev');

    const lines = await classify(emptyWorld({ containers: found('hushbox-emulator-0') }));
    expect(lines[0]).toMatchObject({ state: 'unowned' });
  });
});

describe('classifying against a live run whose record could not be read', () => {
  const PORT = 5432;

  it('stops calling a resource unowned, because a claim on it may exist and be unreadable', async () => {
    const lines = await withLiveRun(
      () => classify(emptyWorld({ listeningPorts: listening(PORT) })),
      damageOwnRecord
    );

    expect(lines[0]).toMatchObject({ kind: 'port', id: String(PORT), state: 'unknown' });
  });

  it('stops blaming a spawner for the missing claim', async () => {
    const lines = await withLiveRun(
      () => classify(emptyWorld({ listeningPorts: listening(PORT) })),
      damageOwnRecord
    );

    expect(formatAuditLine(lines[0]!)).not.toContain('spawner defect');
  });

  it('tells the reader to deal with the record rather than to remove the resource', async () => {
    const lines = await withLiveRun(
      () => classify(emptyWorld({ listeningPorts: listening(PORT) })),
      damageOwnRecord
    );

    expect(formatAuditLine(lines[0]!)).toContain('record');
    expect(formatAuditLine(lines[0]!)).not.toContain('remove it by hand');
  });

  it('still asks a human to act, because nothing here was established', async () => {
    const lines = await withLiveRun(
      () => classify(emptyWorld({ listeningPorts: listening(PORT) })),
      damageOwnRecord
    );

    expect(auditExitCode(lines, [])).toBe(1);
  });

  it('leaves a resource the readable claims do account for exactly as it was', async () => {
    const lines = await withLiveRun(
      () => classify(emptyWorld({ containers: found('hushbox-emulator-0') })),
      () => addResource({ kind: 'container', id: 'hushbox-emulator-0' })
    );

    expect(lines[0]).toMatchObject({ state: 'owned-live' });
  });

  it('goes back to unowned once the run behind the record has gone', async () => {
    await withLiveRun(() => Promise.resolve(), damageOwnRecord);

    const lines = await classify(emptyWorld({ listeningPorts: listening(PORT) }));

    expect(lines[0]).toMatchObject({ state: 'unowned' });
  });

  it('still calls a staging database whose name carries no run unknown, since a record names one', async () => {
    const lines = await withLiveRun(
      () => classify(emptyWorld({ databases: ['hb_stage_abc1234def567890'] })),
      damageOwnRecord
    );

    expect(lines[0]).toMatchObject({ kind: 'stage-database', state: 'unknown' });
  });

  it('leaves a bucket carrying no run token unowned, since no record could ever name it', async () => {
    // The one line that answers without the reading above, and the asymmetry is
    // between the two families rather than an oversight: a token-less bucket
    // has no claim id to look up, so `unowned` was established without
    // consulting a record and an unread one takes nothing from it. A staging
    // database carries its claim id in its own whole name, which is why the
    // case above is unknown.
    const lines = await withLiveRun(
      () => classify(emptyWorld({ buckets: ['hushbox-scratch-legacy'] })),
      damageOwnRecord
    );

    expect(lines[0]).toMatchObject({ kind: 'bucket', state: 'unowned' });
  });

  it('keeps the exemption of a daemon that proved it is this stack’s', async () => {
    const sentinel = portFor('idleDaemon', { slot: 3, mode: 'development' });

    const lines = await withLiveRun(
      () =>
        classify(
          emptyWorld({
            listeningPorts: listening(sentinel),
            daemonPorts: [{ port: sentinel, identity: { kind: 'this-stack' } }],
          })
        ),
      damageOwnRecord
    );

    expect(auditExitCode(lines, [])).toBe(0);
  });
});

describe('the printed report', () => {
  it('asks the kernel about a socket no claim names, and about no other', async () => {
    const claimed = path.join('var', 'scratch', 'hb-1111111111');
    const stray = path.join('var', 'scratch', 'hb-2222222222');
    const probeSocket = vi.fn((): Promise<SocketAnswer> => Promise.resolve({ kind: 'refused' }));

    const report = await withLiveRun(
      () =>
        reportWorldAudit(
          worldScan({ lifelineSockets: () => Promise.resolve([claimed, stray]), probeSocket }),
          () => undefined,
          registryDir
        ),
      () => addResource({ kind: 'socket', id: claimed })
    );

    expect(probeSocket.mock.calls).toEqual([[stray]]);
    expect(auditExitCode(report.lines, report.unreadable)).toBe(0);
  });

  it('asks the kernel about no socket at all while a live run\u2019s record cannot be read', async () => {
    const stray = path.join('var', 'scratch', 'hb-2222222222');
    const probeSocket = vi.fn((): Promise<SocketAnswer> => Promise.resolve({ kind: 'refused' }));

    const report = await withLiveRun(
      () =>
        reportWorldAudit(
          worldScan({ lifelineSockets: () => Promise.resolve([stray]), probeSocket }),
          () => undefined,
          registryDir
        ),
      damageOwnRecord
    );

    expect(probeSocket).not.toHaveBeenCalled();
    expect(auditExitCode(report.lines, report.unreadable)).toBe(1);
  });

  it('says so plainly when the world holds nothing of ours', async () => {
    const printed: string[] = [];

    const report = await reportWorldAudit(
      worldScan(),
      (message) => printed.push(message),
      registryDir
    );

    expect(printed).toEqual(['Nothing of this stack is running or left behind.']);
    expect(auditExitCode(report.lines, report.unreadable)).toBe(0);
  });

  it('prints a line per resource and a count of what nothing claims', async () => {
    const printed: string[] = [];

    const report = await reportWorldAudit(
      worldScan({
        containers: () => Promise.resolve(['hushbox-emulator-0']),
        buckets: () => Promise.resolve(['hushbox-scratch-ab12cd34ef-one']),
      }),
      (message) => printed.push(message),
      registryDir
    );

    expect(printed).toHaveLength(3);
    expect(printed[2]).toContain('2 resource(s) a human must act on');
    expect(auditExitCode(report.lines, report.unreadable)).toBe(1);
  });

  it('closes with no count of what nothing reclaims when every line says to leave it', async () => {
    const sentinel = portFor('idleDaemon', { slot: 3, mode: 'development' });
    const printed: string[] = [];

    const report = await withDaemonIdentity(sentinel, () =>
      reportWorldAudit(
        worldScan({ listeningPorts: () => Promise.resolve([sentinel]) }),
        (message) => printed.push(message),
        registryDir
      )
    );

    expect(printed).toHaveLength(1);
    expect(auditExitCode(report.lines, report.unreadable)).toBe(0);
  });

  it('asks nothing of a daemon whose identity record it caught mid-write', async () => {
    const sentinel = portFor('idleDaemon', { slot: 3, mode: 'development' });
    const printed: string[] = [];

    const report = await withDaemonIdentity(sentinel, async () => {
      await fs.truncate(daemonIdentityLockPath(sentinel, registryDir), 8);
      return reportWorldAudit(
        worldScan({ listeningPorts: () => Promise.resolve([sentinel]) }),
        (message) => printed.push(message),
        registryDir
      );
    });

    expect(auditExitCode(report.lines, report.unreadable)).toBe(0);
  });

  it('counts the unowned port beside the sentinel without counting the sentinel', async () => {
    const sentinel = portFor('idleDaemon', { slot: 3, mode: 'development' });
    const printed: string[] = [];

    const report = await withDaemonIdentity(sentinel, () =>
      reportWorldAudit(
        worldScan({
          listeningPorts: () =>
            Promise.resolve([sentinel, portFor('vite', { slot: 3, mode: 'development' })]),
        }),
        (message) => printed.push(message),
        registryDir
      )
    );

    expect(printed.at(-1)).toContain('1 resource(s) a human must act on');
    expect(auditExitCode(report.lines, report.unreadable)).toBe(1);
  });

  it('counts a sentinel port a daemon of another stack holds, like any other unowned one', async () => {
    const sentinel = portFor('idleDaemon', { slot: 3, mode: 'development' });
    const printed: string[] = [];

    const report = await withDaemonIdentity(
      sentinel,
      () =>
        reportWorldAudit(
          worldScan({ listeningPorts: () => Promise.resolve([sentinel]) }),
          (message) => printed.push(message),
          registryDir
        ),
      formatDaemonIdentity(daemonIdentity({ composeProject: 'hushbox-someone-else' }))
    );

    expect(printed.at(-1)).toContain('1 resource(s) a human must act on');
    expect(auditExitCode(report.lines, report.unreadable)).toBe(1);
  });

  it('counts a sentinel port nothing identified itself on, like any other unowned one', async () => {
    const sentinel = portFor('idleDaemon', { slot: 3, mode: 'development' });
    const printed: string[] = [];

    const report = await reportWorldAudit(
      worldScan({ listeningPorts: () => Promise.resolve([sentinel]) }),
      (message) => printed.push(message),
      registryDir
    );

    expect(printed.at(-1)).toContain('1 resource(s) a human must act on');
    expect(auditExitCode(report.lines, report.unreadable)).toBe(1);
  });

  it('promises no file to fix for resources whose missing claim is nobody’s defect', async () => {
    const printed: string[] = [];

    await reportWorldAudit(
      worldScan({ containers: () => Promise.resolve(['hushbox-emulator-0']) }),
      (message) => printed.push(message),
      registryDir
    );

    expect(printed.at(-1)).toContain('1 resource(s) a human must act on');
    expect(printed.at(-1)).not.toContain('names the file');
  });

  it('names the class it could not reach rather than pretending it was clean', async () => {
    const printed: string[] = [];

    const report = await reportWorldAudit(
      worldScan({ buckets: () => Promise.reject(new Error('connection refused')) }),
      (message) => printed.push(message),
      registryDir
    );

    expect(printed[0]).toBe('could not classify buckets: connection refused');
    expect(auditExitCode(report.lines, report.unreadable)).toBe(1);
  });

  it('names the run whose record it could not read, rather than certifying it clean', async () => {
    const printed: string[] = [];

    const runId = await registerRun(init(), async () => {
      const runDir = process.env[RUN_CLAIM_ENV] ?? '';
      const record = path.join(runDir, 'run.json');
      const written: unknown = JSON.parse(await fs.readFile(record, 'utf8'));
      await fs.writeFile(
        record,
        JSON.stringify({ ...(written as object), mode: 'a-mode-this-checkout-has-never-heard-of' })
      );
      const report = await reportWorldAudit(
        worldScan(),
        (message) => printed.push(message),
        registryDir
      );
      expect(auditExitCode(report.lines, report.unreadable)).toBe(1);
      return path.basename(runDir);
    });

    expect(printed.join('\n')).toContain(runId);
  });

  it('reports a class that failed with something that is not an Error', async () => {
    const printed: string[] = [];

    await reportWorldAudit(
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a rejection this module did not author can be anything
      worldScan({ containers: () => Promise.reject('docker exited 125') }),
      (message) => printed.push(message),
      registryDir
    );

    expect(printed[0]).toBe('could not classify containers: docker exited 125');
  });
});

describe('what a report line says about a lane and an unallocated port', () => {
  it('names the lane of a service that binds more than one', async () => {
    const lane = portFor('emulatorAdb', { slot: 3, mode: 'development', lane: 1 });

    const lines = await classify(emptyWorld({ listeningPorts: listening(lane) }));

    expect(lines[0]?.detail).toContain('lane 1');
  });

  it('leaves a port outside the allocation undescribed rather than guessing', async () => {
    const lines = await classify(emptyWorld({ listeningPorts: listening(5432) }));

    expect(lines[0]).toMatchObject({ kind: 'port', id: '5432', detail: undefined });
    expect(formatAuditLine(lines[0]!)).toContain('port 5432 —');
  });

  it('tells the reader to leave the idle-killer’s sentinel rather than to claim it', async () => {
    const sentinel = portFor('idleDaemon', { slot: 3, mode: 'development' });

    const lines = await classify(
      emptyWorld({
        listeningPorts: listening(sentinel),
        daemonPorts: [{ port: sentinel, identity: { kind: 'this-stack' } }],
      })
    );

    expect(formatAuditLine(lines[0]!)).toContain('claiming it would have the next reclaimer');
  });

  it('still tells the reader what to do about any other unowned port, blaming no file', async () => {
    const vite = portFor('vite', { slot: 3, mode: 'development' });

    const lines = await classify(emptyWorld({ listeningPorts: listening(vite) }));

    const rendered = formatAuditLine(lines[0]!);
    expect(rendered).toContain('remove it by hand');
    expect(rendered).not.toContain('long-lived.ts');
  });

  it('tells the reader what removes a purge aside nothing claims', async () => {
    const lines = await classify(emptyWorld({ asides: ['test-results.purge-0'] }));

    expect(formatAuditLine(lines[0]!)).toContain('reclaimed rather than reported');
  });

  it('names the run that still owns an aside', async () => {
    let rendered = '';
    await withLiveRun(
      async () => {
        const runId = currentRunId()!;
        const lines = await classify(emptyWorld({ asides: [`test-results.purge-${runId}.0`] }));
        rendered = formatAuditLine(lines[0]!);
      },
      () => Promise.resolve()
    );

    expect(rendered).toContain('nothing to do');
  });

  it('names what reclaims a snapshot whose serve is over', async () => {
    const lines = await classify(
      emptyWorld({ snapshots: [{ id: 'web-dist-1', held: false, holder: null }] })
    );

    expect(formatAuditLine(lines[0]!)).toContain('pnpm e2e');
  });
});

describe('the owner half of a line, against its repair half', () => {
  it('reports a claim that was released rather than a spawner defect', async () => {
    const lines = await classify(
      emptyWorld({ snapshots: [{ id: 'web-dist-1', held: false, holder: null }] })
    );

    const rendered = formatAuditLine(lines[0]!);
    expect(rendered).toContain('owned-expired — the claim names no holder');
    expect(rendered).not.toContain('spawner defect');
  });

  it('calls the idle-killer’s sentinel unclaimed by design, which is what its repair says', async () => {
    const sentinel = portFor('idleDaemon', { slot: 3, mode: 'development' });

    const lines = await classify(
      emptyWorld({
        listeningPorts: listening(sentinel),
        daemonPorts: [{ port: sentinel, identity: { kind: 'this-stack' } }],
      })
    );

    const rendered = formatAuditLine(lines[0]!);

    expect(rendered).toContain('unclaimed by design');
    expect(rendered).not.toContain('spawner defect');
  });

  it('blames no file for a purge aside, whose absent claim its own class calls no defect', async () => {
    const lines = await classify(emptyWorld({ asides: ['test-results.purge-0'] }));

    const rendered = formatAuditLine(lines[0]!);

    expect(rendered).toContain('unclaimed by design');
    expect(rendered).not.toContain('spawner defect');
  });

  it('blames no file for a stranded wrangler store, which no claiming file could have left', async () => {
    const lines = await classify(
      emptyWorld({ wranglerStores: [path.join('apps', 'api', '.wrangler', 'state', 'v3')] })
    );

    const rendered = formatAuditLine(lines[0]!);

    expect(rendered).not.toContain('spawner defect');
    expect(rendered).not.toContain('wrangler-dev');
  });
});

describe('a snapshot root that cannot be read at all', () => {
  it('surfaces the failure instead of reporting no snapshots', async () => {
    // A file where the snapshot directory should be: reading it is neither a
    // missing directory nor a list of snapshots.
    const world = await withScratchRamHost(async (ramHost) => {
      const snapshots = snapshotsDir(repoRoot, ramHost);
      await fs.mkdir(path.dirname(snapshots), { recursive: true });
      await fs.writeFile(snapshots, 'not a directory');

      return scanWorld({
        repoRoot,
        ramHost,
        stack: auditedStack(),
        containers: () => Promise.resolve([]),
        containerAges: NO_AGE_SOURCE,
        stuckContainers: () => Promise.resolve([]),
        databases: () => Promise.resolve([]),
        buckets: () => Promise.resolve([]),
        listeningPorts: () => Promise.resolve([]),
        listenerAge: NO_AGE_SOURCE,
        lifelineSockets: () => Promise.resolve([]),
        composeProjects: () => Promise.resolve(noProjects()),
      });
    });

    expect(world.unreadable[0]).toContain('snapshots:');
  });
});

describe('what is on the idle daemon’s sentinel port', () => {
  const sentinel = portFor('idleDaemon', { slot: 3, mode: 'development' });

  function scan(listening: readonly number[], stack: AuditedStack = auditedStack()): WorldScanDeps {
    return {
      repoRoot,
      ramHost: scratchRamHost(),
      stack,
      containers: () => Promise.resolve([]),
      containerAges: NO_AGE_SOURCE,
      stuckContainers: () => Promise.resolve([]),
      databases: () => Promise.resolve([]),
      buckets: () => Promise.resolve([]),
      listeningPorts: () => Promise.resolve([...listening]),
      listenerAge: NO_AGE_SOURCE,
      lifelineSockets: () => Promise.resolve([]),
      composeProjects: () => Promise.resolve(noProjects()),
    };
  }

  /** What the pass read off the one sentinel port the world under test holds. */
  async function readSentinel(
    stack: AuditedStack = auditedStack(),
    holder?: string
  ): Promise<DaemonIdentity> {
    const world = await (holder === undefined
      ? scanWorld(scan([sentinel], stack), registryDir)
      : withDaemonIdentity(
          sentinel,
          () => scanWorld(scan([sentinel], stack), registryDir),
          holder
        ));
    return world.daemonPorts[0]!.identity;
  }

  it('is this stack’s daemon when the claim names this project, this checkout and this slot', async () => {
    const identity = await readSentinel(auditedStack(), formatDaemonIdentity(daemonIdentity()));

    expect(identity).toEqual({ kind: 'this-stack' });
  });

  it('is another stack’s daemon when the claim names a compose project this stack is not', async () => {
    const identity = await readSentinel(
      auditedStack(),
      formatDaemonIdentity(daemonIdentity({ composeProject: 'hushbox-someone-else' }))
    );

    expect(identity).toMatchObject({ kind: 'other-stack' });
  });

  it('names the project a daemon of another stack would tear down', async () => {
    const identity = await readSentinel(
      auditedStack(),
      formatDaemonIdentity(daemonIdentity({ composeProject: 'hushbox-someone-else' }))
    );

    expect(identity).toMatchObject({
      differences: [expect.stringContaining('hushbox-someone-else')],
    });
  });

  it('is another stack’s daemon when the claim names a checkout this pass is not auditing', async () => {
    const identity = await readSentinel(
      auditedStack(),
      formatDaemonIdentity(daemonIdentity({ repoRoot: path.join(repoRoot, 'elsewhere') }))
    );

    expect(identity).toMatchObject({ kind: 'other-stack' });
  });

  it('is another stack’s daemon when it watches a slot other than the one its port names', async () => {
    // The lock is keyed on the port and the daemon is told its slot, so a
    // daemon can hold this port's identity while polling another slot's claims.
    const identity = await readSentinel(
      auditedStack(),
      formatDaemonIdentity(daemonIdentity({ slot: 9 }))
    );

    expect(identity).toMatchObject({
      kind: 'other-stack',
      differences: [expect.stringContaining('slot 9')],
    });
  });

  it('reads the checkout through whatever spelling either side names it by', async () => {
    const link = path.join(repoRoot, 'checkout-link');
    await fs.symlink(repoRoot, link);

    const identity = await readSentinel(
      auditedStack({ checkout: link }),
      formatDaemonIdentity(daemonIdentity())
    );

    expect(identity).toEqual({ kind: 'this-stack' });
  });

  it('places a daemon nowhere at all when the pass was told no project of its own', async () => {
    const identity = await readSentinel(
      auditedStack({ composeProject: undefined }),
      formatDaemonIdentity(daemonIdentity())
    );

    expect(identity).toMatchObject({ kind: 'uncompared' });
  });

  it('is another stack’s daemon on a difference it did establish, whatever it could not compare', async () => {
    const identity = await readSentinel(
      auditedStack({ composeProject: undefined }),
      formatDaemonIdentity(daemonIdentity({ repoRoot: path.join(repoRoot, 'elsewhere') }))
    );

    expect(identity).toMatchObject({ kind: 'other-stack' });
  });

  it('states nothing yet when the record was still going in as the pass read it', async () => {
    // A read of a file being grown comes back clamped to the size the kernel
    // sampled, and that size lags the pages the write has already put there, so
    // the window holds the beginning of the record and not the newline that
    // ends it. Truncating the file under the claim that holds it puts the pass
    // in front of exactly those bytes.
    const identity = await withDaemonIdentity(sentinel, async () => {
      await fs.truncate(daemonIdentityLockPath(sentinel, registryDir), 8);
      const world = await scanWorld(scan([sentinel]), registryDir);
      return world.daemonPorts[0]!.identity;
    });

    expect(identity).toEqual({ kind: 'publishing' });
  });

  it('states nothing when the holder of the claim writes prose rather than a record', async () => {
    // What every daemon built before a daemon stated its stack holds.
    const identity = await readSentinel(
      auditedStack(),
      'idle daemon for slot 3 on port 13003 (pid 4242)'
    );

    expect(identity).toEqual({ kind: 'unstated' });
  });

  it('identifies nothing when no claim on that port is held', async () => {
    expect(await readSentinel()).toEqual({ kind: 'unidentified' });
  });

  it('identifies nothing on the strength of a lock file a dead daemon left behind', async () => {
    // The primitive never unlinks a lock file, so a daemon that has exited
    // leaves its own name on disk. Reading that as identity would let every
    // daemon that ever ran vouch for whatever binds the port next.
    await withDaemonIdentity(sentinel, () => Promise.resolve());
    await expect(
      fs.readFile(daemonIdentityLockPath(sentinel, registryDir), 'utf8')
    ).resolves.toContain(PROJECT);

    expect(await readSentinel()).toEqual({ kind: 'unidentified' });
  });

  it('asks nothing of a port no daemon binds, whatever holds a claim of that name', async () => {
    const vite = portFor('vite', { slot: 3, mode: 'development' });

    const world = await scanWorld(scan([vite]), registryDir);

    expect(world.daemonPorts).toEqual([]);
  });

  it('asks nothing about identity for a port the daemon does not bind', async () => {
    const vite = portFor('vite', { slot: 3, mode: 'development' });

    const lines = await classify(emptyWorld({ listeningPorts: listening(vite) }));

    expect(lines[0]?.daemonIdentity).toBeUndefined();
  });

  /** A world whose one listener is the sentinel, read as `identity`. */
  function sentinelWorld(identity: DaemonIdentity): WorldReading {
    return emptyWorld({
      listeningPorts: listening(sentinel),
      daemonPorts: [{ port: sentinel, identity }],
    });
  }

  it('leaves this stack’s own daemon out of what a human must act on', async () => {
    const lines = await classify(sentinelWorld({ kind: 'this-stack' }));

    expect(lines[0]?.daemonIdentity).toEqual({ kind: 'this-stack' });
    expect(auditExitCode(lines, [])).toBe(0);
  });

  /**
   * The daemon outlives every run by design, so it is the one listener here
   * that is legitimately older than anything: a boundary that reached it would
   * end the process that reclaims on everyone's behalf.
   */
  it('leaves this stack’s own daemon alone however long it has been up', async () => {
    const lines = await classify(
      emptyWorld({
        listeningPorts: [
          { port: sentinel, age: { kind: 'known', elapsedMs: UNOWNED_RECLAIM_AFTER_MS * 10 } },
        ],
        daemonPorts: [{ port: sentinel, identity: { kind: 'this-stack' } }],
      })
    );

    expect(formatAuditLine(lines[0]!)).toContain('leave it');
    expect(auditExitCode(lines, [])).toBe(0);
  });

  it('reports a daemon that would tear down a compose project this stack is not', async () => {
    const lines = await classify(
      sentinelWorld({
        kind: 'other-stack',
        stated: daemonIdentity({ composeProject: 'hushbox-someone-else' }),
        differences: ['it would tear down compose project `hushbox-someone-else`'],
      })
    );

    expect(auditExitCode(lines, [])).toBe(1);
  });

  it('names on the line what a daemon of another stack disagrees with', async () => {
    const lines = await classify(
      sentinelWorld({
        kind: 'other-stack',
        stated: daemonIdentity({ composeProject: 'hushbox-someone-else' }),
        differences: ['it would tear down compose project `hushbox-someone-else`'],
      })
    );

    expect(formatAuditLine(lines[0]!)).toContain('hushbox-someone-else');
  });

  it('tells the reader to find out which stack a foreign daemon belongs to before ending it', async () => {
    const lines = await classify(
      sentinelWorld({
        kind: 'other-stack',
        stated: daemonIdentity({ slot: 9 }),
        differences: ['it watches slot 9'],
      })
    );

    const rendered = formatAuditLine(lines[0]!);

    expect(rendered).toContain('find out which stack it belongs to before ending it');
    expect(rendered).not.toContain('leave it —');
  });

  /** What a pass with no project of its own reads off a daemon that has one. */
  function uncomparedWorld(): WorldReading {
    return sentinelWorld({
      kind: 'uncompared',
      stated: daemonIdentity({ composeProject: 'hushbox-someone-else' }),
      reason:
        'it would tear down compose project `hushbox-someone-else`, and this pass was told ' +
        'no project of its own to compare that with',
    });
  }

  it('does not call a daemon another stack’s when it compared it against no stack at all', async () => {
    const lines = await classify(uncomparedWorld());

    const rendered = formatAuditLine(lines[0]!);

    expect(rendered).toContain('a daemon whose stack this pass could not compare');
    expect(rendered).not.toContain('of another stack');
  });

  it('names on the line the project a daemon it could not place would tear down', async () => {
    const lines = await classify(uncomparedWorld());

    expect(formatAuditLine(lines[0]!)).toContain('hushbox-someone-else');
  });

  it('reports a daemon it could not place rather than exempting it', async () => {
    expect(auditExitCode(await classify(uncomparedWorld()), [])).toBe(1);
  });

  it('reports a daemon that holds the claim and says nothing about which stack it is', async () => {
    const lines = await classify(sentinelWorld({ kind: 'unstated' }));

    expect(formatAuditLine(lines[0]!)).toContain('says nothing about which stack');
    expect(auditExitCode(lines, [])).toBe(1);
  });

  it('reports whatever holds the port without proving it is the daemon', async () => {
    const lines = await classify(sentinelWorld({ kind: 'unidentified' }));

    expect(auditExitCode(lines, [])).toBe(1);
  });

  it('tells the reader to find out what an unidentified holder is before ending it', async () => {
    const lines = await classify(sentinelWorld({ kind: 'unidentified' }));

    const rendered = formatAuditLine(lines[0]!);

    expect(rendered).toContain('identified itself');
    expect(rendered).toContain('find out what it is before ending it');
    expect(rendered).not.toContain('leave it —');
  });

  it('blames no spawner file for an unidentified holder it cannot attribute', async () => {
    const lines = await classify(sentinelWorld({ kind: 'unidentified' }));

    expect(formatAuditLine(lines[0]!)).not.toContain('spawner defect');
  });
});

describe('classifying a process group a run recorded', () => {
  /**
   * Scans with a probe and a platform the case decides, so no real process has
   * to exist and no host decides which branch these cases take. These are the
   * POSIX side of the branch `uncoveredGroups` selects on; passing the platform
   * in proves that side is chosen, never that any operating system behaves as
   * assumed.
   */
  function scan(
    alive: readonly number[],
    overrides: Partial<WorldScanDeps> = {}
  ): Promise<WorldReading> {
    return scanWorld(
      {
        repoRoot,
        ramHost: scratchRamHost(),
        stack: auditedStack(),
        containers: () => Promise.resolve([]),
        containerAges: NO_AGE_SOURCE,
        stuckContainers: () => Promise.resolve([]),
        databases: () => Promise.resolve([]),
        buckets: () => Promise.resolve([]),
        listeningPorts: () => Promise.resolve([]),
        listenerAge: NO_AGE_SOURCE,
        lifelineSockets: () => Promise.resolve([]),
        composeProjects: () => Promise.resolve(noProjects()),
        platform: 'linux',
        groupIsAlive: (pgid) => alive.includes(pgid),
        ...overrides,
      },
      registryDir
    );
  }

  it('reports a group still running whose run has let go of its claim as owned-expired', async () => {
    await leaveExpiredClaim(() => addSpawnedProcess({ pid: 4321, pgid: 4321 }));

    const lines = auditWorld(await scan([4321]), await readOwnership(registryDir));

    expect(lines).toEqual([
      expect.objectContaining({
        kind: 'process-group',
        id: '4321',
        state: 'owned-expired',
        owner: expect.stringContaining('pnpm dev'),
      }),
    ]);
  });

  it('reports a group whose run still holds its claim as owned-live', async () => {
    const world = await withLiveRun(
      () => scan([4321]),
      () => addSpawnedProcess({ pid: 4321, pgid: 4321 })
    );

    expect(auditWorld(world, await readOwnership(registryDir))).toEqual([
      expect.objectContaining({ kind: 'process-group', state: 'owned-live' }),
    ]);
  });

  it('says nothing about a recorded group that has gone', async () => {
    await leaveExpiredClaim(() => addSpawnedProcess({ pid: 4321, pgid: 4321 }));

    const world = await scan([]);

    expect(world.processGroups).toEqual([]);
  });

  it('attributes a group two runs recorded to the live one, because an id is reusable', async () => {
    await leaveExpiredClaim(() => addSpawnedProcess({ pid: 4321, pgid: 4321 }));

    const world = await withLiveRun(
      () => scan([4321]),
      () => addSpawnedProcess({ pid: 4321, pgid: 4321 }),
      { command: 'pnpm e2e' }
    );

    expect(world.processGroups).toEqual([
      { pgid: 4321, runLive: true, owner: expect.stringContaining('pnpm e2e') },
    ]);
  });

  it('says nothing about a record whose id, negated, addresses more than one tree', async () => {
    await leaveExpiredClaim(() => addSpawnedProcess({ pid: 1, pgid: 1 }));

    const world = await scan([1]);

    expect(world.processGroups).toEqual([]);
  });
});

describe('a platform where a recorded group id addresses no tree', () => {
  function scan(overrides: Partial<WorldScanDeps> = {}): Promise<WorldReading> {
    return scanWorld(
      {
        repoRoot,
        ramHost: scratchRamHost(),
        stack: auditedStack(),
        containers: () => Promise.resolve([]),
        containerAges: NO_AGE_SOURCE,
        stuckContainers: () => Promise.resolve([]),
        databases: () => Promise.resolve([]),
        buckets: () => Promise.resolve([]),
        listeningPorts: () => Promise.resolve([]),
        listenerAge: NO_AGE_SOURCE,
        lifelineSockets: () => Promise.resolve([]),
        composeProjects: () => Promise.resolve(noProjects()),
        platform: 'win32',
        groupIsAlive: () => true,
        ...overrides,
      },
      registryDir
    );
  }

  it('names every class it cannot reach here, rather than reporting nothing', async () => {
    await leaveExpiredClaim(() => addSpawnedProcess({ pid: 4321, pgid: 4321 }));

    const world = await scan();

    expect(world.processGroups).toEqual([]);
    expect(world.unreadable).toEqual([]);
    expect(world.uncovered).toEqual([
      expect.stringContaining('does not cover them on this platform'),
      expect.stringContaining('processes that left the group their run recorded'),
    ]);
  });

  it('stays silent about processes that left a group when no run is in the registry', async () => {
    const world = await scan();

    expect(world.strayGroups).toEqual([]);
    expect(world.uncovered).toEqual([]);
  });

  it('stays silent when no run recorded a group for it to resolve', async () => {
    const world = await scan();

    expect(world.uncovered).toEqual([]);
  });
});

describe('what the audit does to a process it reports', () => {
  /** A real detached child, so the pass probes a group that genuinely exists. */
  async function withRealGroup(body: (pgid: number) => Promise<void>): Promise<void> {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    const pgid = child.pid;
    if (pgid === undefined) throw new Error('the fixture child did not start');
    try {
      await body(pgid);
    } finally {
      process.kill(-pgid, 'SIGKILL');
    }
  }

  function scan(): WorldScanDeps {
    return {
      repoRoot,
      ramHost: scratchRamHost(),
      stack: auditedStack(),
      containers: () => Promise.resolve([]),
      containerAges: NO_AGE_SOURCE,
      stuckContainers: () => Promise.resolve([]),
      databases: () => Promise.resolve([]),
      buckets: () => Promise.resolve([]),
      listeningPorts: () => Promise.resolve([]),
      listenerAge: NO_AGE_SOURCE,
      lifelineSockets: () => Promise.resolve([]),
      composeProjects: () => Promise.resolve(noProjects()),
    };
  }

  it('finds a real orphaned tree and leaves it running', async () => {
    await withRealGroup(async (pgid) => {
      await leaveExpiredClaim(() => addSpawnedProcess({ pid: pgid, pgid }));

      const printed: string[] = [];
      const report = await reportWorldAudit(
        scan(),
        (message) => printed.push(message),
        registryDir
      );

      expect(report.lines).toEqual([
        expect.objectContaining({
          kind: 'process-group',
          id: String(pgid),
          state: 'owned-expired',
        }),
      ]);
      expect(printed[0]).toContain(`process-group ${String(pgid)}`);
      // Still there afterwards: the pass reports, and reporting is the whole of it.
      expect(() => process.kill(-pgid, 0)).not.toThrow();
    });
  });

  it('asks whether a group exists with the probe that delivers no signal', async () => {
    await withRealGroup(async (pgid) => {
      await leaveExpiredClaim(() => addSpawnedProcess({ pid: pgid, pgid }));
      // Calls through, so this watches the real pass rather than a stand-in
      // for it: what is asserted is every signal the pass actually sent.
      const sent = vi.spyOn(process, 'kill');

      try {
        await reportWorldAudit(scan(), () => undefined, registryDir);

        expect(sent.mock.calls.length).toBeGreaterThan(0);
        expect(sent.mock.calls.map((call) => call[1])).toEqual(sent.mock.calls.map(() => 0));
      } finally {
        sent.mockRestore();
      }
    });
  });
});

describe('the report line for a process group', () => {
  function orphan(overrides: Partial<ProcessGroupReading> = {}): WorldReading {
    return emptyWorld({
      processGroups: [{ pgid: 4321, runLive: false, owner: 'pnpm dev', ...overrides }],
    });
  }

  it('names the command that ends it, rather than asking a reader to', async () => {
    const lines = await classify(orphan());

    const rendered = formatAuditLine(lines[0]!);

    expect(rendered).toContain('`pnpm dev:clean`');
    expect(rendered).not.toContain('by hand');
  });

  it('states what licenses the ending rather than promising a reclaim the pass may spare', async () => {
    // The signal is gated on the kernel's own answer about whose the processes
    // in the group are, and every answer short of that leaves the tree running
    // — on this platform for a group that is not this checkout's, and on every
    // platform that cannot answer the question at all. A line promising the
    // reclaim is one such a reader finds false.
    const lines = await classify(orphan());

    const rendered = formatAuditLine(lines[0]!);

    expect(rendered).toContain('only where the kernel says the processes in it');
    expect(rendered).toContain('a platform that cannot answer');
    expect(rendered).not.toContain('reclaimed by');
  });

  it('asks nothing of the reader while the run that started the tree is still alive', async () => {
    const lines = await classify(orphan({ runLive: true }));

    const rendered = formatAuditLine(lines[0]!);

    expect(rendered).toContain('nothing to do — a live run owns it');
  });

  it('counts an orphaned tree among nothing, because the next command ends it', async () => {
    const lines = await classify(orphan());

    expect(auditExitCode(lines, [])).toBe(0);
  });

  it('counts nothing while the run that started the tree is still alive', async () => {
    const lines = await classify(orphan({ runLive: true }));

    expect(auditExitCode(lines, [])).toBe(0);
  });

  it('does not close by calling an orphaned tree unclaimed, which an expired claim names', async () => {
    await leaveExpiredClaim(() => addSpawnedProcess({ pid: 4321, pgid: 4321 }));
    const printed: string[] = [];

    await reportWorldAudit(
      {
        repoRoot,
        ramHost: scratchRamHost(),
        stack: auditedStack(),
        containers: () => Promise.resolve([]),
        containerAges: NO_AGE_SOURCE,
        stuckContainers: () => Promise.resolve([]),
        databases: () => Promise.resolve([]),
        buckets: () => Promise.resolve([]),
        listeningPorts: () => Promise.resolve([]),
        listenerAge: NO_AGE_SOURCE,
        lifelineSockets: () => Promise.resolve([]),
        composeProjects: () => Promise.resolve(noProjects()),
        // The case's choice, not the host's: its group is a fabricated id no
        // process backs, so nothing in it argues for one platform or the other.
        platform: 'linux',
        groupIsAlive: () => true,
      },
      (message) => printed.push(message),
      registryDir
    );

    expect(printed.at(-1)).toContain('process-group 4321 — owned-expired');
    expect(printed.at(-1)).not.toContain('no claim');
    // Nothing was left for a person: the count line is printed only where a
    // pageable line exists, and an expired claim's tree is not one.
    expect(printed.some((message) => message.includes('resource(s)'))).toBe(false);
  });
});

describe('the report line for a process group a run never recorded', () => {
  /** One group holding a finished run's processes that the run's record does not name. */
  function stray(overrides: Partial<StrayGroupReading> = {}): WorldReading {
    return emptyWorld({
      strayGroups: [
        {
          pgid: 5150,
          members: [5150, 5151, 5152],
          origin: 'departed',
          owner: 'pnpm dev',
          ...overrides,
        },
      ],
    });
  }

  it('names the group and how many of the run’s processes are in it', async () => {
    const lines = await classify(stray());

    expect(lines).toEqual([
      expect.objectContaining({ kind: 'stray-group', id: '5150', state: 'owned-expired' }),
    ]);
    expect(formatAuditLine(lines[0]!)).toContain('3 processes');
  });

  it('lists the ids of the run’s own processes, where the group was made above the run', async () => {
    // The repair for this origin is one action per process rather than one on
    // the group, so the line carries the processes: the reader's route to them
    // through the group is a route through their own shell's members.
    const lines = await classify(stray({ origin: 'never-recorded', members: [4444, 5555] }));

    expect(formatAuditLine(lines[0]!)).toContain('4444 5555');
  });

  it('carries no ids on a group one of the run’s own made, which is ended as one tree', async () => {
    const lines = await classify(stray({ origin: 'departed', members: [4444, 5555] }));

    const rendered = formatAuditLine(lines[0]!);

    expect(rendered).toContain('2 processes');
    expect(rendered).not.toContain('4444');
  });

  it('says a process left the tree its run recorded, where one of the run’s own made the group', async () => {
    const lines = await classify(stray());

    const rendered = formatAuditLine(lines[0]!);

    expect(rendered).toContain('left the group');
    expect(rendered).not.toContain('made above');
  });

  it('says the group was made above the run, where nothing of the run made it', async () => {
    const lines = await classify(stray({ origin: 'never-recorded' }));

    const rendered = formatAuditLine(lines[0]!);

    expect(rendered).toContain('made above');
    expect(rendered).not.toContain('left the group');
  });

  it('warns that a group made above the run is led by the shell the audit is running in', async () => {
    // The canonical case of this origin: a run started from a shell, whose
    // plain non-detached child outlives it, is left in the shell's own group.
    const lines = await classify(stray({ origin: 'never-recorded' }));

    expect(formatAuditLine(lines[0]!)).toContain('shell');
  });

  it('sends the repair at the run’s own processes rather than at the group, where the group was made above the run', async () => {
    const lines = await classify(stray({ origin: 'never-recorded' }));

    const rendered = formatAuditLine(lines[0]!);

    expect(rendered).toContain('their own ids');
    expect(rendered).not.toContain('end the tree');
  });

  it('tells a reader meeting a group made above the run again why it is still named', async () => {
    // Reclaiming an expired run's recorded group leaves the run record, so this
    // line returns on every pass until the processes it counts are gone.
    const lines = await classify(stray({ origin: 'never-recorded' }));

    expect(formatAuditLine(lines[0]!)).toContain('every later pass');
  });

  it('names no holder rather than printing nothing, where the line carries no owner', () => {
    const rendered = formatAuditLine({
      kind: 'stray-group',
      id: '5150',
      state: 'owned-expired',
      owner: undefined,
      detail: undefined,
      daemonIdentity: undefined,
      projectStanding: undefined,
      socketAnswer: undefined,
      storeAnswer: undefined,
      unreclaimed: undefined,
      namedRun: undefined,
      runStanding: undefined,
      groupOrigin: 'departed',
      age: undefined,
    });

    expect(rendered).toContain('the claim names no holder');
  });

  it('says which of the two it is could not be established, where the group has lost its leader', async () => {
    const lines = await classify(stray({ origin: 'unestablished' }));

    expect(formatAuditLine(lines[0]!)).toContain('could not be established');
  });

  it('asks a human to act on a tree that left the record of a run that has gone', async () => {
    const lines = await classify(stray());

    expect(auditExitCode(lines, [])).toBe(1);
  });

  it('asks a human to act on processes left in a group nothing ever recorded', async () => {
    const lines = await classify(stray({ origin: 'never-recorded' }));

    expect(auditExitCode(lines, [])).toBe(1);
  });

  it('asks a human to act where which failure it is could not be established', async () => {
    // Neither answer is available and both are repaired by hand, so the pass
    // that cannot say which asks for the same thing rather than for nothing.
    const lines = await classify(stray({ origin: 'unestablished' }));

    expect(auditExitCode(lines, [])).toBe(1);
  });
});

describe('the census of processes outside every group their run recorded', () => {
  /** Leaves an expired claim behind, and answers the directory recording it. */
  async function expiredRun(
    record: () => Promise<void> = () => Promise.resolve()
  ): Promise<string> {
    let runDir = '';
    await registerRun(init(), async () => {
      runDir = process.env[RUN_CLAIM_ENV] ?? '';
      await record();
      throw new Error('the run was killed');
    }).catch(() => undefined);
    return runDir;
  }

  /** One pass over a machine whose live processes are exactly `processes`. */
  function censusOf(processes: readonly ProcessReading[]): Promise<WorldReading> {
    return scanWorld(
      worldScan({ processes: () => Promise.resolve({ kind: 'read', processes }) }),
      registryDir
    );
  }

  it('calls a group led by one of the run’s own processes a departure', async () => {
    const runDir = await expiredRun();

    const world = await censusOf([{ pid: 900, pgid: 900, runDir }]);

    expect(world.strayGroups).toEqual([
      expect.objectContaining({ pgid: 900, members: [900], origin: 'departed' }),
    ]);
  });

  it('calls a group led by something that is not the run’s never recorded', async () => {
    const runDir = await expiredRun();

    const world = await censusOf([
      { pid: 700, pgid: 500, runDir },
      { pid: 500, pgid: 500, runDir: undefined },
    ]);

    expect(world.strayGroups).toEqual([
      expect.objectContaining({ pgid: 500, members: [700], origin: 'never-recorded' }),
    ]);
  });

  it('establishes neither where the group has lost the process that made it', async () => {
    const runDir = await expiredRun();

    const world = await censusOf([{ pid: 700, pgid: 500, runDir }]);

    expect(world.strayGroups).toEqual([
      expect.objectContaining({ pgid: 500, origin: 'unestablished' }),
    ]);
  });

  it('counts every process of the run in one group as that one group', async () => {
    const runDir = await expiredRun();

    const world = await censusOf([
      { pid: 900, pgid: 900, runDir },
      { pid: 901, pgid: 900, runDir },
      { pid: 902, pgid: 900, runDir },
    ]);

    expect(world.strayGroups).toEqual([
      expect.objectContaining({ pgid: 900, members: [900, 901, 902] }),
    ]);
  });

  it('names the run’s processes in a group by id, ascending, whatever order the machine listed them', async () => {
    const runDir = await expiredRun();

    const world = await censusOf([
      { pid: 901, pgid: 500, runDir },
      { pid: 700, pgid: 500, runDir },
      { pid: 900, pgid: 500, runDir },
    ]);

    expect(world.strayGroups).toEqual([expect.objectContaining({ members: [700, 900, 901] })]);
  });

  it('says nothing about a group the run’s own record names', async () => {
    const runDir = await expiredRun(() => addSpawnedProcess({ pid: 900, pgid: 900 }));

    const world = await censusOf([{ pid: 900, pgid: 900, runDir }]);

    expect(world.strayGroups).toEqual([]);
  });

  it('says nothing about a run that still holds its claim', async () => {
    // A detached child exists before its group id can be known, so a live run
    // is routinely part-way through recording the group this would report.
    const world = await withLiveRun(
      () => censusOf([{ pid: 900, pgid: 900, runDir: process.env[RUN_CLAIM_ENV] ?? '' }]),
      () => Promise.resolve()
    );

    expect(world.strayGroups).toEqual([]);
  });

  it('reports the census it could not take as a class it failed to reach', async () => {
    await expiredRun();

    const world = await scanWorld(
      worldScan({ processes: () => Promise.reject(new Error('the process filesystem went away')) }),
      registryDir
    );

    expect(world.strayGroups).toEqual([]);
    expect(world.unreadable).toEqual([expect.stringContaining('the process filesystem went away')]);
  });

  it('says nothing about a process whose environment names no run of ours', async () => {
    await expiredRun();

    const world = await censusOf([{ pid: 900, pgid: 900, runDir: undefined }]);

    expect(world.strayGroups).toEqual([]);
  });
});

describe('classifying a running compose project', () => {
  const PROJECT = composeProjectName(7);

  /** One running compose project, as a pass reads it off the machine. */
  function running(
    projectName: string,
    workingDir: string,
    commonDir: string | null = CLONE.commonDir
  ): ProjectOwnership {
    return { project: { projectName, workingDir }, commonDir };
  }

  /** The compose reading of a machine running `ownerships` and nothing else. */
  function projectsRunning(
    ownerships: readonly ProjectOwnership[],
    overrides: Partial<ComposeProjectWorld> = {}
  ): ComposeProjectWorld {
    return { ...noProjects(), ownerships, activeWorktreePaths: [CLONE.checkout], ...overrides };
  }

  /** The slot registry as it reads once `checkout` has claimed `slot`. */
  function holding(checkout: string, slot: number): (candidate: string) => number | null {
    return (candidate) => (candidate === checkout ? slot : null);
  }

  /** Classifies a machine on which `ownerships` are the running projects. */
  function classifyProjects(
    ownerships: readonly ProjectOwnership[],
    overrides: Partial<ComposeProjectWorld> = {},
    hold: () => Promise<void> = () => Promise.resolve()
  ): Promise<AuditLine[]> {
    return classify(emptyWorld({ composeProjects: projectsRunning(ownerships, overrides) }), hold);
  }

  /** The stack the checkout is running now: its slot names the project. */
  const CURRENT = { slotOfWorktree: holding(CLONE.checkout, 7) };

  /** The owner half of a line whose ownership a pass could not establish. */
  const UNESTABLISHED_OWNER =
    "ownership unestablished — a live run's record could not be read, so a claim on this may exist and be unreadable";

  it('reports one a live run claims as owned-live', async () => {
    const lines = await withLiveRun(
      () => classifyProjects([running(PROJECT, CLONE.checkout)], CURRENT),
      () => addResource({ kind: 'compose-project', id: PROJECT })
    );

    expect(lines).toEqual([
      expect.objectContaining({
        kind: 'compose-project',
        id: PROJECT,
        state: 'owned-live',
        owner: expect.stringContaining('pnpm dev'),
      }),
    ]);
  });

  it('asks nothing of one a live run claims', async () => {
    const lines = await withLiveRun(
      () => classifyProjects([running(PROJECT, CLONE.checkout)], CURRENT),
      () => addResource({ kind: 'compose-project', id: PROJECT })
    );

    expect(formatAuditLine(lines[0]!)).toContain('nothing to do');
    expect(auditExitCode(lines, [])).toBe(0);
  });

  /** The project line a live run holds, classified against the standing it is given. */
  async function projectHeldBy(standing: RunRootReading['standing']): Promise<AuditLine> {
    return withLiveRun(
      async () => {
        const lines = await classify(
          emptyWorld({
            composeProjects: projectsRunning([running(PROJECT, CLONE.checkout)], CURRENT),
            runRoots: [{ runId: currentRunId() ?? '', standing }],
          })
        );
        return lines[0]!;
      },
      () => addResource({ kind: 'compose-project', id: PROJECT })
    );
  }

  it('reports one a decapitated run claims as something a human must act on', async () => {
    const line = await projectHeldBy('decapitated');

    expect(formatAuditLine(line)).toContain('left behind');
    expect(auditExitCode([line], [])).toBe(1);
  });

  it('asks for the tree rather than a teardown of the stack a decapitated run claims', async () => {
    const rendered = formatAuditLine(await projectHeldBy('decapitated'));

    expect(rendered).toContain('end the tree by hand');
    expect(rendered).not.toContain('docker compose -p');
  });

  it('names what reclaims one whose checkout the worktree listing no longer holds', async () => {
    await leaveExpiredClaim(() => addResource({ kind: 'compose-project', id: PROJECT }));

    const lines = await classifyProjects([running(PROJECT, CLONE.stranded)]);

    expect(lines[0]).toMatchObject({ state: 'owned-expired' });
    expect(formatAuditLine(lines[0]!)).toContain('pnpm docker:cleanup');
  });

  it('reclaims one no claim ever named on the same evidence, its checkout being gone', async () => {
    const lines = await classifyProjects([running(PROJECT, CLONE.stranded)]);

    expect(lines[0]).toMatchObject({ state: 'unowned' });
    expect(formatAuditLine(lines[0]!)).toContain('pnpm docker:cleanup');
  });

  it('leaves the stack a live checkout runs, though the run that brought it up has ended', async () => {
    await leaveExpiredClaim(() => addResource({ kind: 'compose-project', id: PROJECT }));

    const lines = await classifyProjects([running(PROJECT, CLONE.checkout)], CURRENT);

    expect(formatAuditLine(lines[0]!)).toContain('leave it');
    expect(auditExitCode(lines, [])).toBe(0);
  });

  it('pages about no healthy stack whose bring-up predates any recording of a project', async () => {
    const lines = await classifyProjects([running(PROJECT, CLONE.checkout)], CURRENT);

    expect(lines[0]).toMatchObject({ state: 'unowned' });
    expect(auditExitCode(lines, [])).toBe(0);
  });

  it('accounts for a project no claim names rather than blaming a file', async () => {
    const lines = await classifyProjects([running(PROJECT, CLONE.checkout)], CURRENT);

    const rendered = formatAuditLine(lines[0]!);
    expect(rendered).toContain('no claim names it');
    expect(rendered).not.toContain('spawner defect');
    expect(rendered).not.toContain('.ts');
  });

  it('reports the project a live checkout no longer runs under, and removes nothing', async () => {
    const lines = await classifyProjects([running(PROJECT, CLONE.checkout)], {
      slotOfWorktree: holding(CLONE.checkout, 3),
    });

    expect(formatAuditLine(lines[0]!)).toContain(`docker compose -p ${PROJECT} down`);
    expect(auditExitCode(lines, [])).toBe(1);
  });

  it('says a directory could not be resolved rather than that it is another clone’s', async () => {
    const lines = await classifyProjects([running(PROJECT, CLONE.stranded, null)]);

    const rendered = formatAuditLine(lines[0]!);
    expect(rendered).toContain('could not resolve');
    expect(rendered).not.toContain('a different clone');
    expect(auditExitCode(lines, [])).toBe(1);
  });

  it('leaves a different clone’s stack alone, and asks nothing of it', async () => {
    const lines = await classifyProjects([
      running(PROJECT, CLONE.stranded, CLONE.siblingCommonDir),
    ]);

    expect(formatAuditLine(lines[0]!)).toContain('a different clone');
    expect(auditExitCode(lines, [])).toBe(0);
  });

  it('says a different clone’s stack is that, without saying how that was established', async () => {
    // Placed there by its own label, with a recorded directory that resolves
    // nowhere at all: a line saying that directory resolves into another clone
    // states a resolution that never happened.
    const stamped: ProjectOwnership = {
      project: {
        projectName: PROJECT,
        workingDir: CLONE.stranded,
        cloneDir: CLONE.siblingCommonDir,
      },
      commonDir: CLONE.siblingCommonDir,
    };

    const lines = await classifyProjects([stamped]);

    expect(formatAuditLine(lines[0]!)).not.toContain('resolves into');
  });

  it('tears nothing down while a live run’s record could not be read', async () => {
    const lines = await withLiveRun(
      () => classifyProjects([running(PROJECT, CLONE.stranded)]),
      damageOwnRecord
    );

    expect(formatAuditLine(lines[0]!)).toBe(
      `compose-project ${PROJECT} (started in ${CLONE.stranded}) — unknown — ` +
        `${UNESTABLISHED_OWNER} — leave it and deal with the unreadable run record this ` +
        "pass names — a live run's record could not be read, so it counts as a run that may " +
        'be working against anything and no compose project is torn down on its behalf'
    );
    expect(auditExitCode(lines, [])).toBe(1);
  });

  it('states ownership unestablished on the project a live checkout no longer runs under', async () => {
    const lines = await withLiveRun(
      () =>
        classifyProjects([running(PROJECT, CLONE.checkout)], {
          slotOfWorktree: holding(CLONE.checkout, 3),
        }),
      damageOwnRecord
    );

    expect(formatAuditLine(lines[0]!)).toBe(
      `compose-project ${PROJECT} (started in ${CLONE.checkout}) — unknown — ` +
        `${UNESTABLISHED_OWNER} — the checkout it was started from is still there and now ` +
        'runs a different project, so nothing reclaims this one — end it with ' +
        `\`docker compose -p ${PROJECT} down\` once you have established that nothing is using it`
    );
  });

  it('states ownership unestablished on the project whose directory would not resolve', async () => {
    const lines = await withLiveRun(
      () => classifyProjects([running(PROJECT, CLONE.stranded, null)]),
      damageOwnRecord
    );

    expect(formatAuditLine(lines[0]!)).toBe(
      `compose-project ${PROJECT} (started in ${CLONE.stranded}) — unknown — ` +
        `${UNESTABLISHED_OWNER} — it carries no label naming its clone and git could not ` +
        'resolve the directory it was started from, so nothing here knows which clone it ' +
        'belongs to: that directory may have been deleted along with its checkout, or may ' +
        'never have been a checkout of this one, a directory that is gone is no evidence the ' +
        'stack it started is dead, and nothing stamps a label on a project already running — ' +
        `end it with \`docker compose -p ${PROJECT} down\` once you have established that ` +
        'nothing is using it'
    );
  });

  it('places two projects of one name by the directory each was started in', async () => {
    const lines = await classifyProjects(
      [running(PROJECT, CLONE.checkout), running(PROJECT, CLONE.stranded)],
      CURRENT
    );

    expect(lines.map((found) => found.projectStanding)).toEqual(['current', 'reclaimable']);
  });

  it('says which directory a project was started from, which its name does not', async () => {
    const lines = await classifyProjects([running(PROJECT, CLONE.stranded)]);

    expect(formatAuditLine(lines[0]!)).toContain(CLONE.stranded);
  });
});

describe('reading the compose projects running on this machine', () => {
  const sources = {
    checkout: CLONE.checkout,
    projects: () => Promise.resolve([{ projectName: 'hushbox-7', workingDir: CLONE.stranded }]),
    activeWorktreePaths: () => Promise.resolve([CLONE.checkout]),
    commonDirOf: (dir: string) =>
      Promise.resolve(dir === CLONE.stranded ? CLONE.siblingCommonDir : CLONE.commonDir),
    slotOfWorktree: () => holdingNothing,
  };

  const holdingNothing = (): null => null;

  it('resolves the repository each project’s recorded directory belongs to', async () => {
    const world = await readComposeProjectWorld(sources);

    expect(world.ownerships).toEqual([
      {
        project: { projectName: 'hushbox-7', workingDir: CLONE.stranded },
        commonDir: CLONE.siblingCommonDir,
      },
    ]);
    expect(world.repoCommonDir).toBe(CLONE.commonDir);
  });

  it('places a project by the clone it stamped, not by resolving its directory', async () => {
    const stamped = {
      projectName: 'hushbox-7',
      workingDir: CLONE.stranded,
      cloneDir: CLONE.commonDir,
    };

    const world = await readComposeProjectWorld({
      ...sources,
      projects: () => Promise.resolve([stamped]),
    });

    expect(world.ownerships).toEqual([{ project: stamped, commonDir: CLONE.commonDir }]);
  });

  it('refuses to place anything when the checkout is in no repository at all', async () => {
    await expect(
      readComposeProjectWorld({ ...sources, commonDirOf: () => Promise.resolve(null) })
    ).rejects.toThrow('not inside a git repository');
  });

  it('records the projects it could not list instead of failing the whole audit', async () => {
    const world = await scanWorld({
      repoRoot,
      ramHost: scratchRamHost(),
      stack: auditedStack(),
      containers: () => Promise.resolve([]),
      containerAges: NO_AGE_SOURCE,
      stuckContainers: () => Promise.resolve([]),
      databases: () => Promise.resolve([]),
      buckets: () => Promise.resolve([]),
      listeningPorts: () => Promise.resolve([]),
      listenerAge: NO_AGE_SOURCE,
      lifelineSockets: () => Promise.resolve([]),
      composeProjects: () => Promise.reject(new Error('docker is not running')),
    });

    expect(world.unreadable).toEqual(['compose projects: docker is not running']);
    expect(world.composeProjects.ownerships).toEqual([]);
  });
});

describe('the shape of the report', () => {
  /**
   * A pass over a world a live run owns three resources of, plus one nobody
   * claims. The unclaimed one is a staging database because the shape cases
   * need a line a human must act on, and that is the database family whose
   * unclaimed line still asks for one.
   */
  async function busyWorld(shape: AuditShape): Promise<string[]> {
    const printed: string[] = [];
    await withLiveRun(
      () =>
        reportWorldAudit(
          worldScan({
            containers: () => Promise.resolve(['hushbox-emulator-0', 'hushbox-emulator-1']),
            buckets: () => Promise.resolve(['hushbox-scratch-ab12cd34ef-one']),
            databases: () => Promise.resolve(['hb_stage_abc1234def567890']),
          }),
          (message) => printed.push(message),
          registryDir,
          shape
        ),
      async () => {
        await addResource({ kind: 'container', id: 'hushbox-emulator-0' });
        await addResource({ kind: 'container', id: 'hushbox-emulator-1' });
        await addResource({ kind: 'bucket', id: scratchBucketPrefix('ab12cd34ef') });
      }
    );
    return printed;
  }

  it('collapses what a live run owns into one line naming the run and what it holds', async () => {
    const printed = await busyWorld('what-must-be-done');

    const held = printed.filter((message) => message.includes('holds'));
    expect(held).toHaveLength(1);
    expect(held[0]).toContain('pnpm dev');
    expect(held[0]).toContain('container \u00D72');
    expect(held[0]).toContain('bucket \u00D71');
  });

  it('prints no line of its own for a resource nobody must act on', async () => {
    const printed = await busyWorld('what-must-be-done');

    expect(printed.join('\n')).not.toContain('nothing to do');
    expect(printed.join('\n')).not.toContain('hushbox-emulator-0 ');
  });

  it('keeps the whole line and its repair for anything a human must act on', async () => {
    const printed = await busyWorld('what-must-be-done');

    const page = printed.find((message) => message.startsWith('stage-database '));
    expect(page).toContain('hb_stage_abc1234def567890');
    expect(page).toContain('remove it by hand');
    expect(printed.at(-1)).toContain('1 resource(s) a human must act on');
  });

  it('prints a line per resource for the pass whose whole purpose is the classification', async () => {
    const printed = await busyWorld('every-line');

    expect(printed.filter((message) => message.includes('nothing to do'))).toHaveLength(3);
    expect(printed.filter((message) => message.startsWith('stage-database '))).toHaveLength(1);
  });

  it('reports a reclaim in both shapes, because something was acted on either way', async () => {
    await fs.mkdir(path.join(repoRoot, '.wrangler', 'state', 'v3'), { recursive: true });
    const printed: string[] = [];

    await reportWorldAudit(
      worldScan({ reclaimStrandedStores: (store) => removeWranglerStore(repoRoot, store) }),
      (message) => printed.push(message),
      registryDir,
      'what-must-be-done'
    );

    expect(printed.join('\n')).toContain('reclaimed the wrangler store');
  });
});
