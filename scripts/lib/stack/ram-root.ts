import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, readlink, statfs } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { canonicalPath } from '../canonical-path.js';
import { stagedWrite } from '../staged-write.js';
import { MIB, mebibytes, statfsType, tmpfsShortfall } from '../tmpfs.js';
import type { ReadStatfs } from '../tmpfs.js';

/**
 * Where an E2E run keeps the state it rebuilds every run and that a disk would
 * stall: a directory on a RAM filesystem, outside the repository.
 *
 * workerd commits every Durable Object write with an fsync on its only
 * JavaScript thread, and no setting reaches that, so on a contended disk the
 * whole Worker freezes for as long as the disk takes to flush. On tmpfs the
 * fsync returns at once. The preview server's reads of an evicted bundle stall
 * on the same disk. Outside the repository, no tool that syncs the checkout can
 * restore an earlier run's state into a root the bring-up just emptied.
 *
 * Linux only, and stated here as a rule rather than tried and fallen back from:
 * every other platform gets no root, and each caller keeps its disk location.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

/** The platform a root is resolved for, and the RAM filesystem directory roots are made in. */
export interface RamRootHost {
  readonly platform: NodeJS.Platform;
  readonly parent: string;
  /**
   * Reads the mount namespace this process resolves paths in. A host that
   * states none claims roots that record none, and reclaims none.
   */
  readonly mountNamespace?: () => Promise<string>;
}

export interface E2eRamPaths {
  readonly root: string;
  /** The E2E Worker's persist root. */
  readonly persist: string;
  /** The preview servers' bundle snapshots. */
  readonly snapshots: string;
  /** The temporary directory of the browsers the suite launches. */
  readonly browserTmp: string;
  /** Playwright's output directory. */
  readonly testResults: string;
}

/**
 * The mount namespace this process resolves paths in, as the kernel names it:
 * `mnt:[<inode>]`, one name for every process in the namespace.
 */
function processMountNamespace(): Promise<string> {
  return readlink(path.join(path.sep, 'proc', 'self', 'ns', 'mnt'));
}

/** Read at call time, so a test can stand this process on another platform. */
function liveHost(): RamRootHost {
  return {
    platform: process.platform,
    parent: path.join(path.sep, 'dev', 'shm'),
    mountNamespace: processMountNamespace,
  };
}

/** The mount namespace `host` resolves paths in, or none where it states none. */
export async function ramHostMountNamespace(
  host: RamRootHost = liveHost()
): Promise<string | undefined> {
  return host.mountNamespace?.();
}

/** How every root's name starts, which is what tells a root from anything else in the parent. */
const ROOT_NAME_PREFIX = 'hushbox-e2e-';

/**
 * Every checkout on a machine shares one RAM filesystem, so a root is named for
 * a digest of the checkout's one canonical path: two checkouts never share a
 * root, one checkout reached by two spellings never has two, and the name says
 * nothing about where the checkout is.
 */
function rootName(checkoutRoot: string): string {
  const digest = createHash('sha256').update(canonicalPath(checkoutRoot)).digest('hex');
  return `${ROOT_NAME_PREFIX}${digest.slice(0, 16)}`;
}

/** The stores of the RAM root at `root`. */
function storesOf(root: string): E2eRamPaths {
  return {
    root,
    persist: path.join(root, 'persist'),
    snapshots: path.join(root, 'snapshots'),
    browserTmp: path.join(root, 'browser-tmp'),
    testResults: path.join(root, 'test-results'),
  };
}

/** The E2E RAM paths of the checkout at `checkoutRoot`, or none off Linux. */
export function ramPathsFor(
  checkoutRoot: string,
  host: RamRootHost = liveHost()
): E2eRamPaths | undefined {
  if (host.platform !== 'linux') return undefined;
  return storesOf(path.join(host.parent, rootName(checkoutRoot)));
}

/** This checkout's E2E RAM paths, or none off Linux. */
export function e2eRamPaths(): E2eRamPaths | undefined {
  return ramPathsFor(REPO_ROOT);
}

/**
 * The file in a root naming the checkout it belongs to, by that checkout's
 * canonical path, and the mount namespace it was claimed in:
 * `{"checkout": "<path>", "mountNamespace": "mnt:[<inode>]"}`. It is what tells
 * a root whose checkout is gone from one still in use, without reading anything
 * else. The namespace is what that path was resolved in: two namespaces can
 * share one RAM filesystem, and a checkout path absent from one can be a live
 * checkout in the other.
 */
export const RAM_ROOT_OWNER_FILE = 'owner.json';

const OWNER_FILE_SCHEMA = z.object({
  checkout: z.string(),
  mountNamespace: z.string().optional(),
});

/** What a root's owner file records. */
interface RamRootOwner {
  /** The canonical path of the checkout the root belongs to. */
  readonly checkout: string;
  /** The mount namespace the root was claimed in, where its claimer recorded one. */
  readonly mountNamespace: string | undefined;
}

// Every caller that reads a root's filesystem already imports these names from here.
export { TMPFS_MAGIC } from '../tmpfs.js';
export type { ReadStatfs } from '../tmpfs.js';

/** `st_blocks` counts 512-byte units whatever the filesystem's own block size. */
const STAT_BLOCK_BYTES = 512n;

/** What `read` yields, or nothing where the path it reads is not there. */
async function unlessMissing<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * The paths of the files under `directory`, or none where it does not exist.
 * Each directory is listed on its own, so one that vanishes after its parent
 * was listed is left out and the rest are still found: a recursive listing
 * rejects as a whole when any directory inside it vanishes mid-walk.
 */
async function filesUnder(directory: string): Promise<string[]> {
  const entries = (await unlessMissing(() => readdir(directory, { withFileTypes: true }))) ?? [];
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(directory, entry.name));
  for (const entry of entries.filter((listed) => listed.isDirectory())) {
    files.push(...(await filesUnder(path.join(directory, entry.name))));
  }
  return files;
}

/**
 * The space the files under `directories` occupy: allocated blocks rather than
 * apparent sizes, and each inode once however many of its links the directories
 * hold, since that is what emptying them returns to the filesystem's free count.
 * A file also linked from outside them is still counted, though emptying them
 * leaves it allocated. Stats are read as bigints because an inode number can
 * exceed what a double holds exactly, and two inodes must never share a key.
 * A file or directory that vanishes during the walk is left out, since the
 * sampler walks a root while the run deletes its own output.
 */
async function bytesUnder(directories: readonly string[]): Promise<number> {
  const counted = new Set<string>();
  let total = 0n;
  for (const directory of directories) {
    for (const file of await filesUnder(directory)) {
      const stats = await unlessMissing(() => lstat(file, { bigint: true }));
      if (stats === undefined) continue;
      const inode = `${String(stats.dev)}:${String(stats.ino)}`;
      if (counted.has(inode)) continue;
      counted.add(inode);
      total += stats.blocks * STAT_BLOCK_BYTES;
    }
  }
  return Number(total);
}

/** The space everything under the RAM root at `root` occupies, counted as the capacity check counts it. */
export async function ramRootUsedBytes(root: string): Promise<number> {
  return bytesUnder([root]);
}

/**
 * The space a root's stores that a run empties before writing to them (the
 * persist root, the browsers' temporary directory and the test output) occupy,
 * which emptying them gives the next run back. Counting it as free holds only
 * while each of those stores is emptied at a run's start.
 */
async function emptiedAtStart(root: string): Promise<number> {
  const stores = storesOf(root);
  return bytesUnder([stores.persist, stores.browserTmp, stores.testResults]);
}

/**
 * Refuses a root whose filesystem is not tmpfs, or has less free space than
 * `requiredBytes` once what its stores emptied at a run's start hold is added.
 * A root on disk would bring back the stalls it exists to remove, and a tmpfs
 * that fills mid-run fails whichever write comes next.
 */
export async function assertRamRootCapacity(
  root: string,
  requiredBytes: number,
  readStatfs: ReadStatfs = statfs
): Promise<void> {
  const reading = await readStatfs(root);
  const emptiedBytes = await emptiedAtStart(root);
  const shortfall = tmpfsShortfall(reading, requiredBytes, emptiedBytes);
  if (shortfall === undefined) return;

  const { isTmpfs, freeBytes } = shortfall;
  const found = isTmpfs
    ? `is tmpfs with ${mebibytes(freeBytes)} free and ${mebibytes(emptiedBytes)} in the ` +
      `stores a run starts by emptying`
    : `is not tmpfs (statfs type ${statfsType(reading.type)}), ` +
      `with ${mebibytes(freeBytes)} free`;
  const fix = isTmpfs
    ? `Raise the shared-memory size (for a container, its shm size) so it has ${mebibytes(requiredBytes)} free`
    : `Mount a tmpfs at ${path.dirname(root)} (for a container, give it a shared-memory size of at least ${mebibytes(requiredBytes)})`;
  throw new Error(
    `The E2E RAM root needs ${mebibytes(requiredBytes)} free on a tmpfs, and the filesystem ` +
      `holding ${root} ${found}. ${fix}, and re-run.`
  );
}

/** What a root's owner file records, or nothing where the root has no owner file yet. */
async function recordedOwner(root: string): Promise<RamRootOwner | undefined> {
  const file = path.join(root, RAM_ROOT_OWNER_FILE);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const unnamed =
    `The E2E RAM root's owner file ${file} does not name a checkout, so nothing says whose ` +
    `state ${root} holds. Remove ${root} once no E2E run is using it, and re-run.`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(unnamed, { cause: error });
  }
  const owner = OWNER_FILE_SCHEMA.safeParse(parsed);
  if (!owner.success) throw new Error(unnamed, { cause: owner.error });
  return { checkout: owner.data.checkout, mountNamespace: owner.data.mountNamespace };
}

/**
 * What the owner file of the directory at `root` records, or nothing where that
 * directory is no E2E RAM root: a name {@link ramPathsFor} never makes, or a
 * root with no owner file. A directory not named like a root is never opened,
 * so nothing else the RAM filesystem holds is read.
 */
export async function ramRootOwner(root: string): Promise<RamRootOwner | undefined> {
  if (!path.basename(root).startsWith(ROOT_NAME_PREFIX)) return undefined;
  return recordedOwner(root);
}

/**
 * Makes the root its checkout's, or refuses one another checkout owns. The
 * owner file is written on every claim, so a root claimed before its owner
 * file recorded a mount namespace records the claimer's from the next claim
 * on. It lands whole, so a reader of the RAM filesystem never meets it empty
 * or part-written.
 */
async function claimRoot(root: string, checkout: string, host: RamRootHost): Promise<void> {
  await mkdir(root, { recursive: true });
  const owner = await recordedOwner(root);
  if (owner !== undefined && owner.checkout !== checkout) {
    throw new Error(
      `The E2E RAM root ${root} belongs to the checkout at ${owner.checkout}, not to this one ` +
        `at ${checkout}: the two paths digest to one root name. Remove ${root} once no E2E ` +
        `run of ${owner.checkout} is using it, and re-run.`
    );
  }
  const record: z.infer<typeof OWNER_FILE_SCHEMA> = {
    checkout,
    mountNamespace: await ramHostMountNamespace(host),
  };
  await stagedWrite(path.join(root, RAM_ROOT_OWNER_FILE), `${JSON.stringify(record)}\n`);
}

export interface RamRootDeps {
  readonly host?: RamRootHost;
  readonly statfs?: ReadStatfs;
}

/**
 * Makes the checkout's RAM root ready for an E2E run needing `requiredBytes`,
 * or refuses: the root is created and its owner file written, and a root
 * another checkout owns, or one too small or not in RAM, is refused. Off Linux
 * it makes nothing and yields no root.
 */
export async function prepareRamRoot(
  checkoutRoot: string,
  requiredBytes: number,
  deps: RamRootDeps = {}
): Promise<E2eRamPaths | undefined> {
  const host = deps.host ?? liveHost();
  const paths = ramPathsFor(checkoutRoot, host);
  if (paths === undefined) return undefined;
  await claimRoot(paths.root, canonicalPath(checkoutRoot), host);
  await assertRamRootCapacity(paths.root, requiredBytes, deps.statfs);
  return paths;
}

/**
 * The Worker's persist root and the preview's bundle snapshots together: about
 * 95 MB of seeded model weights, about 140 MB of snapshots, and headroom for
 * the Durable Object databases a run creates.
 */
const WORKER_STATE_ALLOWANCE_BYTES = 256 * MIB;

/** One Playwright worker's browsers' temporary files: about 0.7 GB at twelve workers. */
const BROWSER_TMP_ALLOWANCE_PER_WORKER_BYTES = 64 * MIB;

/** Playwright's `test-results/`: the output directory where a run's tests keep their artifacts. */
const TEST_RESULTS_ALLOWANCE_BYTES = 512 * MIB;

/**
 * The free space an E2E run of `workerCount` Playwright workers needs in its RAM
 * root: 1.5 GiB at twelve workers, 1,216 MiB at seven. The allowances are
 * estimates, and a run's measured peak is what revises them.
 */
export function ramRootRequiredBytes(workerCount: number): number {
  return (
    WORKER_STATE_ALLOWANCE_BYTES +
    BROWSER_TMP_ALLOWANCE_PER_WORKER_BYTES * workerCount +
    TEST_RESULTS_ALLOWANCE_BYTES
  );
}
