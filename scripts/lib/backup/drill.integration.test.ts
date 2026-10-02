/**
 * The drill run for real: a dump of the running local stack, written into a
 * repository by the pinned rustic binary, restored out of it into a throwaway
 * Postgres and proved against its own manifest.
 *
 * The repository here is a plain directory rather than object storage. What the
 * drill exercises is the restore path and the comparison, neither of which can
 * tell what the repository is stored on; the object-storage backend is proved
 * by the run that writes to it.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { execa } from 'execa';
import { stringify } from 'smol-toml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { containersThisRunRecorded } from '../claims/owned-containers.js';
import { recordOwnedResource } from '../claims/ownership.js';
import { BACKUP_HOST, DUMP_LABEL, writeRusticConfig } from './config.js';
import { RESTORE_DIRECTORY_NAME, SCRATCH_CONTAINER_PREFIX, runRestoreDrill } from './drill.js';
import {
  DUMP_MANIFEST_FILE,
  DumpManifestSchema,
  POSTGRES_IMAGE,
  dumpDatabase,
} from './postgres.js';
import { ensureRustic } from './rustic-binary.js';
import type { RusticConfigFile } from './config.js';
import type { DumpManifest } from './postgres.js';

function requiredUrl(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`backup/drill integration: ${name} is required`);
  }
  return value;
}

const DRIVER_URL = requiredUrl('DATABASE_URL');
const DIRECT_URL = requiredUrl('MIGRATION_DATABASE_URL');

/** The direct endpoint, pointed at the per-worker database the driver holds. */
function directUrlForDriverDatabase(): string {
  const direct = new URL(DIRECT_URL);
  direct.pathname = new URL(DRIVER_URL).pathname;
  return direct.toString();
}

/**
 * Long enough for a cold `docker run`, a full dump, a restore and a load of the
 * seeded database.
 */
const DRILL_TIMEOUT_MS = 600_000;

/**
 * How long the daemon is given to finish a removal the drill already asked for.
 *
 * Chosen rather than derived, and it says so: nothing here has ever observed
 * this daemon finishing a removal, and the attempt count this replaces measured
 * its own sleeping rather than the daemon — the same number spending wildly
 * different amounts of waiting as the host gets busier. What fixes the figure is
 * its two ends. It stays orders above the seconds
 * {@link expectScratchContainerRemoved} records the window taking under load, so
 * a tail nobody has seen does not reach it; and it stays a fraction of
 * {@link DRILL_TIMEOUT_MS}, so a removal that never happens fails on that
 * function's own assertion rather than on the runner's clock.
 */
const CONTAINER_REMOVAL_BUDGET_MS = 60_000;

/**
 * How often the daemon is asked, which is why this wait is spelled here rather
 * than taken from the package's shared bounded wait: a probe that spawns a
 * process and calls an external daemon cannot ride a cadence fixed inside a
 * helper written for reads of our own machinery.
 *
 * Sized to what one probe costs, measured as this file issues it: 13 to 24 ms
 * on an idle host, and 55 to 79 ms under the load a package run puts on the
 * same machine. The shared helper sleeps 25 ms between probes, so at the loaded
 * end of that band the same wait taken from it would issue ten to thirteen
 * times as many daemon calls per removal, on a daemon whose containers every
 * other run on this host shares. A second leaves the daemon under a tenth of
 * each period at the loaded cost, and still answers within one probe of a
 * removal {@link expectScratchContainerRemoved} records as taking seconds.
 */
const REMOVAL_PROBE_CADENCE_MS = 1000;

/**
 * What a case that creates one scratch container, asks the daemon about it and
 * removes it may spend.
 *
 * Spelled because the runner's own default sits inside this subject's
 * distribution rather than above it. Over fourteen runs of that exact shape on
 * this host, with no package run loading it, the median round cost 370 ms and
 * the worst 12.4 seconds — a `docker create` of 5.8 and a `docker rm` of 6.6 in
 * the one round — against a default of 15 seconds, or 30 under coverage. A case
 * the runner ends there never reaches the removal in its `finally`, and the
 * container it created stands with no claim record naming it.
 *
 * Twice {@link CONTAINER_REMOVAL_BUDGET_MS}: the case spends that constant's
 * own subject — one removal at this daemon — at one end and a creation whose
 * worst is of the same order at the other, and the probes between them cost
 * tens of milliseconds against either end's seconds. Its two ends are that
 * constant's two. It stays an order above the worst round seen, so a tail
 * nobody has observed does not reach it; and it stays a fraction of
 * {@link DRILL_TIMEOUT_MS}, so a case with no drill in it does not report a
 * stalled daemon on a drill's clock.
 */
const SPECIMEN_CASE_TIMEOUT_MS = CONTAINER_REMOVAL_BUDGET_MS * 2;

/**
 * What tearing the fixture down may spend: one recursive removal of the
 * directory the dump, the repository and every work directory live under, plus
 * the removal of the profile's own directory.
 *
 * Spelled because a teardown that inherits a budget nobody derived is a budget
 * in name only. What that budget buys is not obvious either: the runner does
 * not cancel the removal it stops waiting for, it abandons the wait, and the
 * removal runs on until the worker exits underneath it. So the number decides
 * how much of the tree is gone by then, and a removal long enough to be cut off
 * this way leaves the part it had not reached standing.
 *
 * Sized from this subject, measured rather than assumed, on copies of a real
 * fixture tree of this suite's own making — 4.9 MB across 112 files and 268
 * directories, the size sampled from a live run of this file. Idle, fourteen
 * removals cost a median of 4.6 ms and a worst of 5.0 ms. Under a full package
 * run, a hundred and twenty-six of them held that median and reached 10 ms at
 * the ninetieth percentile — and one round took 5.9 seconds, three orders above
 * its own median, the host having stalled the unlinks under somebody else's IO.
 *
 * That one round is what the budget is for; a median never needed one. A minute
 * is an order above it, so a stall of a kind nobody has seen yet still finishes
 * inside the budget, and it is a tenth of {@link DRILL_TIMEOUT_MS}, so a
 * removal blocked on something that never finishes is reported on the
 * teardown's own clock rather than a drill's. It lands on the same figure as
 * {@link CONTAINER_REMOVAL_BUDGET_MS} and is not taken from it: that constant
 * sizes a daemon finishing a removal, this one a filesystem finishing a walk,
 * and a measurement moving either leaves the other where it is.
 */
const FIXTURE_TEARDOWN_TIMEOUT_MS = 60_000;

/**
 * A repository on the filesystem, and the dump directory as its one source.
 * The production profile the renderer writes names object storage and carries
 * the source credentials; neither is what this test is proving.
 */
function localProfile(repositoryDir: string, dumpDir: string): string {
  return stringify({
    repository: { repository: repositoryDir },
    backup: {
      snapshots: [
        {
          sources: [dumpDir],
          host: BACKUP_HOST,
          label: DUMP_LABEL,
          'as-path': `/${DUMP_LABEL}`,
        },
      ],
    },
  });
}

/** Every scratch container on this machine, whoever started it. */
async function scratchContainers(): Promise<string[]> {
  const { stdout } = await execa('docker', [
    'ps',
    '--all',
    '--filter',
    `name=${SCRATCH_CONTAINER_PREFIX}`,
    '--format',
    '{{.Names}}',
  ]);
  return stdout.split('\n').filter((name) => name.trim() !== '');
}

/** Whether the daemon still lists the scratch container of that name. */
async function isStanding(name: string): Promise<boolean> {
  const present = await scratchContainers();
  return present.includes(name);
}

/**
 * That the drill just run claimed one scratch container and left it nowhere.
 *
 * `minted` is the name the drill told this caller it was about to create, and
 * it is the only handle there is on the container THIS invocation started. One
 * claim record serves a whole run and every process in it, so a check written
 * over the record's container entries is satisfied by any other file in the
 * run that claims one — and the vacuity that check exists to catch, a drill
 * that started no container at all, passes it.
 *
 * The claim is asserted alongside because it is what makes the container
 * anyone's but this file's to reclaim: one the record never named is one
 * nothing can attribute if the run dies still holding it.
 *
 * The wait is there because `docker rm --force` returns once removal is under
 * way: the daemon still lists a container it is tearing down, and under load
 * that window is seconds. It is bounded, and a drill that never asked for the
 * removal keeps its name listed for the whole of it and fails here.
 */
async function expectScratchContainerRemoved(minted: readonly string[]): Promise<void> {
  const [name, ...rest] = minted;
  if (name === undefined) {
    throw new Error('backup/drill integration: the drill named no scratch container');
  }
  expect(rest).toEqual([]);
  await expect(containersThisRunRecorded()).resolves.toContain(name);

  const deadline = Date.now() + CONTAINER_REMOVAL_BUDGET_MS;
  while (Date.now() < deadline) {
    if (!(await isStanding(name))) return;
    await delay(REMOVAL_PROBE_CADENCE_MS);
  }
  expect(await scratchContainers()).not.toContain(name);
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * The releases for what a fixture setup has created, run newest first.
 *
 * A registry rather than a teardown written over the setup's variables,
 * because such a teardown is answerable only for a setup that reached them:
 * it reaches for the value the setup assigns last, throws on it when the setup
 * stopped short, and removes nothing the setup did create. Here every release
 * is registered the moment its resource exists, so a setup that throws part
 * way leaves exactly what it made to be given back and nothing it never made
 * to be reached for.
 */
interface FixtureReclaim {
  /** Registers one release, to run before everything registered before it. */
  readonly own: (release: () => Promise<void> | void) => void;
  /**
   * Runs every registered release, newest first. One that throws does not stop
   * the rest, and the failures are reported together: a release silently
   * skipped is the leak this exists to close.
   */
  readonly releaseAll: () => Promise<void>;
}

function createFixtureReclaim(): FixtureReclaim {
  const releases: (() => Promise<void> | void)[] = [];
  return {
    own: (release) => {
      releases.push(release);
    },
    releaseAll: async () => {
      const failures: unknown[] = [];
      for (const release of releases.splice(0).toReversed()) {
        try {
          await release();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, 'backup/drill integration: the fixture teardown failed');
      }
    },
  };
}

/** What the drill cases read, once the setup has built all of it. */
interface DrillFixture {
  readonly root: string;
  readonly dumpDir: string;
  readonly rusticPath: string;
  readonly config: RusticConfigFile;
  readonly manifest: DumpManifest;
}

interface DrillFixtureOptions {
  /** Where the dump is taken from, and the session its counts are read under. */
  readonly databaseUrl: string;
  readonly snapshotUrl: string;
  readonly reclaim: FixtureReclaim;
  /**
   * The temporary root, reported as it is created. Like the drill's own
   * container callback, it is the only handle a caller has on what this
   * invocation made when the step after it throws.
   */
  readonly onRoot?: ((root: string) => void) | undefined;
}

/**
 * Builds the fixture, registering each piece's release with `reclaim` as that
 * piece comes into existence.
 */
async function setUpDrillFixture(options: DrillFixtureOptions): Promise<DrillFixture> {
  const { databaseUrl, snapshotUrl, reclaim, onRoot } = options;

  const root = await mkdtemp(path.join(os.tmpdir(), 'hb-drill-'));
  reclaim.own(() => rm(root, { recursive: true, force: true }));
  onRoot?.(root);

  const dumpDir = path.join(root, 'dump');
  const manifest = await dumpDatabase({
    databaseUrl,
    snapshotUrl,
    outDir: dumpDir,
    image: POSTGRES_IMAGE,
  });

  const rusticPath = await ensureRustic();
  const repositoryDir = path.join(root, 'repository');
  await mkdir(repositoryDir, { recursive: true, mode: 0o700 });
  const config = await writeRusticConfig(localProfile(repositoryDir, dumpDir));
  reclaim.own(() => config.cleanup());

  // The drill reads the repository password from its own environment and
  // never takes it as an argument, so the test puts one there.
  const previous = process.env['RUSTIC_PASSWORD'];
  reclaim.own(() => {
    if (previous === undefined) delete process.env['RUSTIC_PASSWORD'];
    else process.env['RUSTIC_PASSWORD'] = previous;
  });
  process.env['RUSTIC_PASSWORD'] = randomBytes(16).toString('hex');

  return { root, dumpDir, rusticPath, config, manifest };
}

describe('runRestoreDrill against a repository holding a real dump', () => {
  const reclaim = createFixtureReclaim();
  let root: string;
  let dumpDir: string;
  let rusticPath: string;
  let config: RusticConfigFile;
  let manifest: DumpManifest;

  async function backup(): Promise<void> {
    await execa(rusticPath, ['--use-profile', config.path, 'backup']);
  }

  beforeAll(async () => {
    ({ root, dumpDir, rusticPath, config, manifest } = await setUpDrillFixture({
      databaseUrl: directUrlForDriverDatabase(),
      snapshotUrl: DRIVER_URL,
      reclaim,
    }));

    await execa(rusticPath, ['--use-profile', config.path, 'init']);
    await backup();
  }, DRILL_TIMEOUT_MS);

  afterAll(() => reclaim.releaseAll(), FIXTURE_TEARDOWN_TIMEOUT_MS);

  it(
    'proves every table the dump recorded and leaves nothing behind',
    async () => {
      const workDir = await mkdtemp(path.join(root, 'work-'));
      const minted: string[] = [];

      const result = await runRestoreDrill({
        rusticPath,
        configPath: config.path,
        image: POSTGRES_IMAGE,
        workDir,
        onScratchContainer: (name) => {
          minted.push(name);
        },
      });

      expect(result.passed).toBe(true);
      expect(result.mismatches).toEqual([]);
      expect(result.tablesChecked).toBe(Object.keys(manifest.tables).length);
      expect(result.tablesChecked).toBeGreaterThan(0);
      await expectScratchContainerRemoved(minted);
      await expect(exists(path.join(workDir, RESTORE_DIRECTORY_NAME))).resolves.toBe(false);
    },
    DRILL_TIMEOUT_MS
  );

  it(
    'reports a restore that failed by its status and prints nothing the binary wrote',
    async () => {
      // The repository is named after something that must not reach the failure
      // channel; rustic names it in its own output, which is what makes the
      // absence assertion below a real one.
      const marker = 'no-repository-here';
      const workDir = await mkdtemp(path.join(root, 'work-'));
      const absent = await writeRusticConfig(localProfile(path.join(root, marker), dumpDir));

      try {
        const direct = await execa(
          rusticPath,
          [
            '--use-profile',
            absent.path,
            'restore',
            `latest:/${DUMP_LABEL}`,
            path.join(workDir, 'x'),
          ],
          { reject: false }
        );
        expect(direct.exitCode).not.toBe(0);
        expect(`${direct.stderr}${direct.stdout}`).toContain(marker);

        const thrown: unknown = await runRestoreDrill({
          rusticPath,
          configPath: absent.path,
          image: POSTGRES_IMAGE,
          workDir,
        }).catch((error: unknown) => error);

        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toMatch(/^runRestoreDrill: rustic restore exited \d+$/);
        expect((thrown as Error).message).not.toContain(marker);
        await expect(exists(path.join(workDir, RESTORE_DIRECTORY_NAME))).resolves.toBe(false);
      } finally {
        await absent.cleanup();
      }
    },
    DRILL_TIMEOUT_MS
  );

  it(
    'reports a scratch server that could not be started, and leaves nothing behind',
    async () => {
      const workDir = await mkdtemp(path.join(root, 'work-'));
      const minted: string[] = [];

      const thrown: unknown = await runRestoreDrill({
        rusticPath,
        configPath: config.path,
        image: 'Not A Reference',
        workDir,
        onScratchContainer: (name) => {
          minted.push(name);
        },
      }).catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toMatch(/^runRestoreDrill: the scratch server exited \d+$/);
      await expectScratchContainerRemoved(minted);
      await expect(exists(path.join(workDir, RESTORE_DIRECTORY_NAME))).resolves.toBe(false);
    },
    DRILL_TIMEOUT_MS
  );

  it(
    'fails, names the table, and still leaves nothing behind when a count is wrong',
    async () => {
      const manifestPath = path.join(dumpDir, DUMP_MANIFEST_FILE);
      const original = await readFile(manifestPath, 'utf8');
      const parsed = DumpManifestSchema.parse(JSON.parse(original));
      const [entry] = Object.entries(parsed.tables).toSorted(([a], [b]) => a.localeCompare(b));
      if (entry === undefined) throw new Error('backup/drill integration: the dump has no table');
      const [table, count] = entry;
      const workDir = await mkdtemp(path.join(root, 'work-'));
      const minted: string[] = [];

      try {
        await writeFile(
          manifestPath,
          JSON.stringify({
            ...parsed,
            tables: { ...parsed.tables, [table]: count + 1 },
          })
        );
        await backup();

        await expect(
          runRestoreDrill({
            rusticPath,
            configPath: config.path,
            image: POSTGRES_IMAGE,
            workDir,
            onScratchContainer: (name) => {
              minted.push(name);
            },
          })
        ).rejects.toThrow(new RegExp(`'${table}'`));
        await expectScratchContainerRemoved(minted);
        await expect(exists(path.join(workDir, RESTORE_DIRECTORY_NAME))).resolves.toBe(false);
      } finally {
        await writeFile(manifestPath, original);
        await backup();
      }
    },
    DRILL_TIMEOUT_MS
  );
});

/**
 * The standing check the assertions above rest on, against the live daemon and
 * in both directions. Without the first, "the drill's container is gone" holds
 * for a check that can see nothing at all; without the second, a sibling run
 * mid-drill, or one that died leaving its container behind, answers it.
 *
 * Each specimen is claimed, created and removed here — the same three steps in
 * the same order the drill itself takes, so nothing in this file reaches for a
 * container it did not start. The claim is what a bound cannot buy: a case
 * ended by a signal or a crash rather than by the runner's clock never reaches
 * its removal, and the container it leaves is reclaimed by the next run only
 * because a record names the run that made it.
 */
describe('the scratch container a drill is answerable for', () => {
  /** A scratch container of this run's, made without running the drill. */
  function scratchName(): string {
    return `${SCRATCH_CONTAINER_PREFIX}${randomBytes(6).toString('hex')}`;
  }

  it(
    'reports a standing container under the name it was created with',
    async () => {
      const name = scratchName();
      await recordOwnedResource('container', name);
      await execa('docker', ['create', '--name', name, POSTGRES_IMAGE]);

      try {
        await expect(containersThisRunRecorded()).resolves.toContain(name);
        await expect(isStanding(name)).resolves.toBe(true);
      } finally {
        await execa('docker', ['rm', '--force', '--volumes', name]);
      }
    },
    SPECIMEN_CASE_TIMEOUT_MS
  );

  it(
    'answers for the named container alone while another one stands',
    async () => {
      const other = scratchName();
      await recordOwnedResource('container', other);
      await execa('docker', ['create', '--name', other, POSTGRES_IMAGE]);

      try {
        // The listing reaches it; only the name keeps it out of the answer.
        await expect(containersThisRunRecorded()).resolves.toContain(other);
        await expect(scratchContainers()).resolves.toContain(other);
        await expect(isStanding(scratchName())).resolves.toBe(false);
      } finally {
        await execa('docker', ['rm', '--force', '--volumes', other]);
      }
    },
    SPECIMEN_CASE_TIMEOUT_MS
  );
});

/**
 * The fixture's teardown driven where no drill reaches it: a setup that threw.
 *
 * The case a teardown exists for is the setup that did not finish, and it is
 * the case a teardown reading the setup's own variables fails at. The failure
 * is injected as a database URL nothing serves, so the dump fails at its first
 * connection and leaves the fixture in exactly that state — a temporary root,
 * and no profile written yet for the teardown to reach for.
 */
describe('the drill fixture teardown when its setup does not finish', () => {
  /** Loopback, at a privileged port no unprivileged process can be serving. */
  const UNSERVED_DATABASE_URL = 'postgresql://nobody:nobody@127.0.0.1:1/nothing';

  /** Drives a setup to throw at its dump, and hands back the root it had made. */
  async function rootOfAFailedSetup(reclaim: FixtureReclaim): Promise<string> {
    let created: string | undefined;
    await expect(
      setUpDrillFixture({
        databaseUrl: UNSERVED_DATABASE_URL,
        snapshotUrl: UNSERVED_DATABASE_URL,
        reclaim,
        onRoot: (root) => {
          created = root;
        },
      })
    ).rejects.toThrow();

    if (created === undefined) {
      throw new Error('backup/drill integration: the setup made no temporary root');
    }
    await expect(exists(created)).resolves.toBe(true);
    return created;
  }

  it('removes the temporary root, and reaches for no profile that was never written', async () => {
    const reclaim = createFixtureReclaim();
    const root = await rootOfAFailedSetup(reclaim);

    await expect(reclaim.releaseAll()).resolves.toBeUndefined();
    await expect(exists(root)).resolves.toBe(false);
  });

  it('removes the temporary root even when a release registered after it fails', async () => {
    const reclaim = createFixtureReclaim();
    const root = await rootOfAFailedSetup(reclaim);
    reclaim.own(() => {
      throw new Error('backup/drill integration: a release that fails');
    });

    await expect(reclaim.releaseAll()).rejects.toThrow(AggregateError);
    await expect(exists(root)).resolves.toBe(false);
  });
});
