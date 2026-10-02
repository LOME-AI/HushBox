/**
 * Reading the machine: the probes one pass runs over the filesystem, the
 * process table, the container runtime and the local stores.
 */

import { chmod, readFile, readdir, readlink, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { canonicalPath } from '../canonical-path.js';
import { snapshotLockPath, snapshotsDir } from '../bundling/bundle-snapshot.js';
import { DEFAULT_OUTPUT_DIR, e2eOutputDir, isPurgeDirectory } from '../../e2e-clean.js';
import { ramHostMountNamespace, ramPathsFor, ramRootOwner } from '../stack/ram-root.js';
import { RUN_CLAIM_ENV, enumerateClaims } from './registry.js';
import { tryLock } from './claim.js';
import { STACK_MODES, describePort } from '../stack/port-plan.js';
import { daemonIdentityLockPath, parseDaemonIdentity } from '../stack/idle-killer-daemon.js';
import { ownershipOf } from '../../docker-cleanup.js';
import {
  addressesOneTree,
  groupIsAlive,
  processGroupOf,
  readRecordedProcessGroups,
  recordedGroupAddressesATree,
} from '../spawn/long-lived.js';
import { BARRIER_MODE, STORE_BARRIER, WRITE_PERMISSIONS } from './world-verdicts.js';
import type { DaemonIdentityRecord } from '../stack/idle-killer-daemon.js';
import type {
  AuditedStack,
  DaemonIdentity,
  GroupOrigin,
  ContainerReading,
  ListenerReading,
  SentinelReading,
  ComposeProjectWorld,
  LifelineSocketReading,
  ProcessGroupReading,
  ProcessReading,
  RunRootReading,
  RunStanding,
  SnapshotProbe,
  StoreAnswer,
  StoreReclaimFailure,
  StrayGroupReading,
  WorldReading,
  WranglerStoreReading,
} from './world-reading.js';
import type { ResourceAge } from './resource-age.js';
import type { SocketAnswer } from '../spawn/long-lived.js';
import type { RamRootHost } from '../stack/ram-root.js';
import type { LabelledContainer, DockerComposeProject } from '../../docker-cleanup.js';

/**
 * What a pass states in place of a source for a class it has no way to date.
 *
 * Written out rather than left off, because absent and silent read the same
 * downstream: a pass holding no source and a source carrying no answer about
 * one resource both leave an age nothing established, and the boundary answers
 * no to both. A field that may be absent therefore cannot tell a pass that
 * cannot ask from a pass that forgot, and the pass that forgot reports every
 * container as something only a human can remove while every layer of it stays
 * individually consistent.
 */
export const NO_AGE_SOURCE = 'no age source';

/**
 * What a pass states in place of a way to list the containers a compose project
 * owns that docker is not running.
 *
 * The same shape {@link NO_AGE_SOURCE} names, at the scale of a whole class
 * rather than of one resource's age: a pass holding no listing and a machine
 * running every container it owns both leave nothing to report, so a field that
 * may be absent cannot tell a pass that cannot ask from a pass that forgot, and
 * the pass that forgot certifies the class clean. Stated, the pass reports the
 * class as one it does not cover.
 */
export const NO_STUCK_CONTAINER_SOURCE = 'no stuck container source';

export interface WorldScanDeps {
  readonly repoRoot: string;
  /** The stack this pass audits for, which only the idle daemon is checked against. */
  readonly stack: AuditedStack;
  /** Injected so the platform branch is testable off that platform. */
  readonly platform?: NodeJS.Platform;
  /** Injected so a pass can be driven without a real tree to probe. */
  readonly groupIsAlive?: (pgid: number) => boolean;
  /** Every container under our prefix that no compose project owns. */
  readonly containers: () => Promise<readonly string[]>;
  /**
   * How long each of those has stood, by name, or {@link NO_AGE_SOURCE} from a
   * pass with no way to ask. A name the answer does not carry is the second of
   * those for that one container: its age is unestablished, so the
   * classification stands where it stood before an age decided anything. That
   * is the safe direction — an age nothing established never licenses a
   * reclaim.
   */
  readonly containerAges: (() => Promise<ReadonlyMap<string, ResourceAge>>) | typeof NO_AGE_SOURCE;
  /**
   * Every container of this clone docker is not running, or
   * {@link NO_STUCK_CONTAINER_SOURCE} from a pass with no way to list them.
   * That second case covers none of the class rather than finding none of it,
   * and the pass says so where it reports what it does not cover.
   */
  readonly stuckContainers:
    | (() => Promise<readonly LabelledContainer[]>)
    | typeof NO_STUCK_CONTAINER_SOURCE;
  /**
   * Every per-run and staged-template database `pg_database` holds. Un-aged by
   * ruling rather than by omission, and the ruling is about this reading rather
   * than about the class: a name reaching here is classified on its claim and
   * nothing here asks how old it is. An age boundary does reach these names
   * elsewhere — the pre-registry debris path in
   * `scripts/lib/test-run/test-db-provision.ts` selects on the creation stamp a
   * database's comment carries — and this reading takes names only, so that
   * stamp never arrives.
   */
  readonly databases: () => Promise<readonly string[]>;
  /**
   * Every scratch bucket the endpoint holds. Un-aged by ruling rather than by
   * omission, and the ruling is the date itself: the listing carries a creation
   * date beside each name, `scripts/lib/test-run/scratch-bucket-reclaim.ts`
   * takes the name and drops the date, and that date is a server wall clock
   * rather than an elapsed time.
   */
  readonly buckets: () => Promise<readonly string[]>;
  /** The ports of this checkout's bands that something is listening on. */
  readonly listeningPorts: () => Promise<readonly number[]>;
  /**
   * How long one of those has been held, or {@link NO_AGE_SOURCE} from a pass
   * with no way to ask. That second case leaves every listener's age
   * unestablished — the classification then stands where it stood before an age
   * decided anything, which is the safe direction: an age nothing established
   * never licenses a reclaim.
   */
  readonly listenerAge: ((port: number) => Promise<ResourceAge>) | typeof NO_AGE_SOURCE;
  /**
   * Every live process, with the group it is in and the run its environment
   * names. Defaults to a real reading of the machine; injected so a case about
   * anything else is not also a case about whatever else is running while it
   * runs.
   */
  readonly processes?: (() => Promise<ProcessCensus>) | undefined;
  /** The socket files spawning processes left in the temporary directory. */
  readonly lifelineSockets: () => Promise<readonly string[]>;
  /**
   * Asks what is behind one of those files. Defaults to a real connect;
   * injected so a case can prove which files were asked about, which no answer
   * can be made to show.
   */
  readonly probeSocket?: (address: string) => Promise<SocketAnswer>;
  /** The running compose projects, and everything that places them. */
  readonly composeProjects: () => Promise<ComposeProjectWorld>;
  /**
   * Where the E2E RAM roots are, the machine's own RAM filesystem when not
   * given: this checkout's, holding its snapshots and the output directory the
   * purge asides sit beside, and every other checkout's, which a pass may
   * remove. Injected so a case plants all of those somewhere of its own.
   */
  readonly ramHost?: RamRootHost;
  /**
   * Removes one stranded store, answering with what stopped it. Absent
   * on a pass that may change nothing, which is the whole of what separates the
   * classification a reader asks for from the housekeeping a bring-up does.
   */
  readonly reclaimStrandedStores?: ((store: string) => Promise<string | undefined>) | undefined;
  /**
   * Asks whether anything is inside one store. Defaults to a real reading of
   * the machine's processes; injected so a case can drive a decision without
   * whatever else is running on the machine deciding it.
   */
  readonly probeStore?: ((store: string) => Promise<StoreAnswer>) | undefined;
}

/**
 * Reads a class, or records why it could not. A stack that is down leaves the
 * auditor unable to certify that class, which is a finding rather than a
 * failure: the classes that did answer still answer, and the verdict is
 * non-zero either way.
 */
async function readValue<T>(
  what: string,
  scan: () => Promise<T>,
  fallback: T,
  unreadable: string[]
): Promise<T> {
  try {
    return await scan();
  } catch (error) {
    unreadable.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
    return fallback;
  }
}

function read<T>(
  what: string,
  scan: () => Promise<readonly T[]>,
  unreadable: string[]
): Promise<readonly T[]> {
  return readValue(what, scan, [], unreadable);
}

/** The subdirectories of `dir`, or none when there is no such directory. */
async function directoryNames(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

/** Every snapshot directory, each probed by its own lock. */
async function scanSnapshots(
  repoRoot: string,
  ramHost: RamRootHost | undefined
): Promise<SnapshotProbe[]> {
  const probes: SnapshotProbe[] = [];
  // Directories only: a snapshot's claim file sits beside it in this same
  // directory, so not every entry here is a snapshot.
  for (const name of await directoryNames(snapshotsDir(repoRoot, ramHost))) {
    const probe = await tryLock(snapshotLockPath(repoRoot, name, ramHost));
    probes.push({ id: name, held: probe.held, holder: probe.holder });
  }
  return probes;
}

/**
 * Every wrangler local store this checkout holds. Given no `--persist-to`,
 * wrangler resolves `.wrangler/state` against the directory of the wrangler
 * config file it found, and against the working directory only when it found
 * none. The roots are therefore each directory under `apps/` — derived from
 * what `apps/` holds rather than listed, so an app added later is scanned
 * without this being edited — plus the checkout itself, which is where a
 * config-less invocation from the repository root lands. A config-less
 * invocation from anywhere else strands a store outside these roots, and this
 * scan will not see it.
 *
 * What a previous reclaim left standing is not among them: a barrier is the
 * mechanism rather than a resource, so naming one would put a line about a
 * working part of this design in front of a reader on every pass, and would
 * have each pass reclaim what the last one already left. The classifier and the
 * removal both read what this returns, so both are silent about it together.
 */
async function scanWranglerStores(repoRoot: string): Promise<string[]> {
  const roots = [''];
  for (const app of await directoryNames(path.join(repoRoot, 'apps'))) {
    roots.push(path.join('apps', app));
  }

  const stores: string[] = [];
  for (const root of roots) {
    const state = path.join(root, '.wrangler', 'state');
    for (const store of await directoryNames(path.join(repoRoot, state))) {
      if (await isStoreBarrier(path.join(repoRoot, state, store))) continue;
      stores.push(path.join(state, store));
    }
  }
  return stores;
}

/**
 * Whether a directory under a `.wrangler/state` is the barrier a reclaim left
 * rather than a store: empty, and writable by nobody.
 *
 * Both halves are asked because only the pair names what
 * {@link removeWranglerStore} leaves. A directory holding something is a store
 * whatever its permission says — passing over one would be the silent
 * accumulation the reclaim exists to end — and a directory nothing can write
 * cannot have gained contents since it was left, so a barrier answers to both.
 * Putting the write permission back is therefore all it takes to have the next
 * pass treat one as a store again.
 */
async function isStoreBarrier(directory: string): Promise<boolean> {
  const found = await stat(directory);
  if ((found.mode & WRITE_PERMISSIONS) !== 0) return false;
  const entries = await readdir(directory);
  return entries.length === 0;
}

/** Whether a directory stands at `target`. */
async function directoryStands(target: string): Promise<boolean> {
  try {
    const found = await stat(target);
    return found.isDirectory();
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

/**
 * Every E2E RAM root on the machine whose checkout is gone, as its absolute
 * path: the directories beside this checkout's own root whose owner file names
 * a checkout path no directory stands at any more. Every checkout on a machine
 * makes its root on the one RAM filesystem, so a deleted checkout's would
 * otherwise hold its state until the machine restarts.
 *
 * A root whose checkout stands is left out, whoever's it is, and so is a
 * directory with no owner file or a name no root has: nothing says whose that
 * is. So is a root claimed in another mount namespace, or one recording none:
 * a checkout path absent here can be a live checkout there, and the probe that
 * spares an occupied root may not see that namespace's processes. Off Linux
 * there is no root anywhere, so nothing is read.
 */
async function scanStrandedRamRoots(
  repoRoot: string,
  ramHost: RamRootHost | undefined
): Promise<string[]> {
  const own = ramPathsFor(repoRoot, ramHost);
  if (own === undefined) return [];
  const namespace = await ramHostMountNamespace(ramHost);
  const parent = path.dirname(own.root);
  const stranded: string[] = [];
  for (const name of await directoryNames(parent)) {
    const root = path.join(parent, name);
    const owner = await ramRootOwner(root);
    if (owner?.mountNamespace === undefined || owner.mountNamespace !== namespace) continue;
    if (await directoryStands(owner.checkout)) continue;
    stranded.push(root);
  }
  return stranded;
}

/**
 * Whether a store is an E2E RAM root rather than a store inside the checkout.
 * The scan names a store inside the checkout by its path relative to it, and a
 * RAM root, which lives outside every checkout, by its absolute path.
 */
export function isRamRootStore(store: string): boolean {
  return path.isAbsolute(store);
}

/**
 * The mount point a kernel that has one answers about open descriptors under.
 * Constructed rather than written out, so the one platform branch below is the
 * only thing deciding whether it is asked at all.
 */
const PROCESS_FILESYSTEM = path.join(path.sep, 'proc');

/** Whether a name under the process filesystem is a process rather than one of its other entries. */
function isProcessId(entry: string): boolean {
  return /^\d+$/.test(entry);
}

/** Whether `candidate` is `dir` itself or sits under it. */
function isInside(dir: string, candidate: string): boolean {
  const relative = path.relative(dir, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * What one path a process holds open points at, where that is a live path under
 * `root`, and nothing otherwise.
 *
 * The link is followed twice on purpose. Reading it gives the path, and a path
 * whose directory entry has since been unlinked reads back with a suffix the
 * kernel adds rather than as a name that resolves — so the answer to whether it
 * still names anything is taken from the file itself, whose link count a
 * removal takes to zero. Text after the path would be a guess about a
 * filename; a link count is the kernel's own answer, and it is the case this
 * whole reading turns on: a process holding descriptors into a directory tree
 * that was deleted out from under it is holding nothing that a removal here
 * could strand.
 */
async function heldPath(link: string, root: string): Promise<string | undefined> {
  try {
    const target = await readlink(link);
    if (!path.isAbsolute(target) || !isInside(root, target)) return undefined;
    const held = await stat(link);
    return held.nlink === 0 ? undefined : target;
  } catch {
    // The descriptor was closed, or the process exited, between the listing and
    // these reads. Either way it holds nothing now.
    return undefined;
  }
}

/**
 * Every link one process's entry offers: the file behind each descriptor it
 * holds, and the directory it is sitting in.
 */
async function processLinks(dir: string): Promise<string[]> {
  const links = [path.join(dir, 'cwd')];
  try {
    for (const descriptor of await readdir(path.join(dir, 'fd'))) {
      links.push(path.join(dir, 'fd', descriptor));
    }
  } catch {
    // A process that has exited, or one this reader may not inspect. Its
    // working directory is still worth following, and where that is refused too
    // the link read answers for it.
  }
  return links;
}

/** Every live path under `root` one process's entry accounts for. */
async function heldPathsUnder(dir: string, root: string): Promise<string[]> {
  const held: string[] = [];
  for (const link of await processLinks(dir)) {
    const target = await heldPath(link, root);
    if (target !== undefined) held.push(target);
  }
  return held;
}

/**
 * How long each listening port has been held, asked of the one thing that can
 * answer it. A pass with nothing to ask answers about none of them, which is
 * not the same as answering that they are young.
 */
async function readListenerAges(
  ports: readonly number[],
  ask: WorldScanDeps['listenerAge']
): Promise<ListenerReading[]> {
  const readings: ListenerReading[] = [];
  for (const port of ports) {
    readings.push({ port, age: ask === NO_AGE_SOURCE ? undefined : await ask(port) });
  }
  return readings;
}

/**
 * How long each listed container has stood, asked once of the one answer that
 * carries every creation time rather than container by container: a listener's
 * age comes off the single process holding that port, while a container's comes
 * out of a listing of them all, and asking per container would be one listing
 * per container.
 */
async function readContainerAges(
  names: readonly string[],
  ask: WorldScanDeps['containerAges']
): Promise<ContainerReading[]> {
  const ages = ask === NO_AGE_SOURCE ? undefined : await ask();
  return names.map((name) => ({ name, age: ages?.get(name) }));
}

/**
 * Every container a compose project owns that docker is not running, asked of
 * the one thing that can list them. A pass with nothing to ask covers none of
 * the class and says so, rather than answering that none stand: both answers
 * are the same empty list, so the note is the whole of what separates a machine
 * running all of its own from a pass that was never given a way to look.
 * Silence would certify the class clean, which is the reason
 * {@link uncoveredGroups} states for the class it covers.
 *
 * Nothing is paged about it. A class nothing offered this pass is a limit of
 * the report rather than something on the machine for a human to clear, and the
 * uncovered classes are carried apart from the unread ones for that reason.
 */
async function readStuckContainers(
  ask: WorldScanDeps['stuckContainers'],
  unreadable: string[],
  uncovered: string[]
): Promise<readonly LabelledContainer[]> {
  if (ask === NO_STUCK_CONTAINER_SOURCE) {
    uncovered.push(
      'containers a compose project owns that docker is not running: this report does not cover ' +
        'them here. This pass was given no way to list them, so nothing says whether any stand, ' +
        'and nothing is paged about it.'
    );
    return [];
  }
  return read('stuck containers', ask, unreadable);
}

/** Every live process a census read, or why the reading could not be taken at all. */
export type ProcessCensus =
  | { readonly kind: 'read'; readonly processes: readonly ProcessReading[] }
  | {
      readonly kind: 'unavailable';
      /** Why nothing could be read, in the words the note prints. */
      readonly reason: string;
    };

/** What a run's identity looks like in the environment the kernel keeps for a process. */
const RUN_IDENTITY_PREFIX = `${RUN_CLAIM_ENV}=`;

/**
 * The run record `pid`'s environment names, or nothing where it names none.
 *
 * Read off the live process rather than out of any record, which is the whole
 * point of it: a record says which groups a run accounted for, and this says
 * which run a process belongs to whatever group it has since moved into.
 *
 * Nothing where the environment could not be read, which is another user's
 * process or one that has gone — neither is a process of a run here, and a
 * caller counting a run's own leaves both out. The empty value is nothing too:
 * a run clears the variable rather than removing it, because a computed key
 * cannot be deleted, and an empty claim is no claim everywhere it is read.
 */
async function runIdentityOf(pid: number): Promise<string | undefined> {
  let held: string;
  try {
    held = await readFile(path.join(PROCESS_FILESYSTEM, String(pid), 'environ'), 'utf8');
  } catch {
    return undefined;
  }
  const named = held.split('\0').find((entry) => entry.startsWith(RUN_IDENTITY_PREFIX));
  const runDir = named?.slice(RUN_IDENTITY_PREFIX.length);
  return runDir === undefined || runDir === '' ? undefined : runDir;
}

/**
 * Every process the kernel has an entry for, with its group and the run its
 * environment names.
 *
 * Linux publishes a live process's environment as a file and the platforms this
 * also runs on do not, so this is the one reading here that has no answer
 * elsewhere — the same limit the reclaim's own attribution states in
 * `scripts/lib/spawn/long-lived.ts`, and it is said out loud rather than
 * returned as an empty reading, because a
 * census that found nothing and a census that could not look are opposite
 * answers.
 *
 * A failure to list the process filesystem on a platform that has one is not
 * this: it is a read that failed, and it is thrown so the pass records it among
 * the classes it could not reach rather than among the limits nobody can clear.
 */
async function censusProcesses(platform: NodeJS.Platform): Promise<ProcessCensus> {
  if (platform !== 'linux') {
    return {
      kind: 'unavailable',
      reason: 'this platform publishes no live process environment to read a run identity out of',
    };
  }
  const entries = await readdir(PROCESS_FILESYSTEM);
  const processes: ProcessReading[] = [];
  for (const entry of entries.filter((name) => isProcessId(name))) {
    const pid = Number(entry);
    const pgid = await processGroupOf(pid);
    // The process went between the listing and the read. One that is gone is in
    // no group, and a group is the whole of what this reading is about.
    /* v8 ignore next -- a process exiting between the listing and the read is normal churn */
    if (pgid === null) continue;
    processes.push({ pid, pgid, runDir: await runIdentityOf(pid) });
  }
  return { kind: 'read', processes };
}

/**
 * Which of the two failures a group no record names is, decided from its
 * leader: the process whose id the group carries.
 *
 * A leader carrying the run's identity is one of the run's own processes, and a
 * group's id is its maker's id — joining a group that already exists takes a
 * `setpgid` a process may make only for itself or its own child, and neither
 * regrouping here joins one. So a leader of ours made this group below the tree
 * the run recorded, which is a departure. A leader that is not ours never was
 * below the run, so the run's processes inherited the group rather than leaving
 * anything. A leader the kernel no longer describes answers neither.
 */
function groupOrigin(
  pgid: number,
  carriers: ReadonlySet<number>,
  live: ReadonlySet<number>
): GroupOrigin {
  if (carriers.has(pgid)) return 'departed';
  return live.has(pgid) ? 'never-recorded' : 'unestablished';
}

/**
 * The processes of each run the census found, keyed by the record's own
 * directory name — which is the run id, a uuid, so a name answers for one run
 * wherever the registry holding it sits.
 */
function processesByRun(processes: readonly ProcessReading[]): Map<string, ProcessReading[]> {
  const byRun = new Map<string, ProcessReading[]>();
  for (const found of processes) {
    if (found.runDir === undefined) continue;
    const runId = path.basename(found.runDir);
    byRun.set(runId, [...(byRun.get(runId) ?? []), found]);
  }
  return byRun;
}

/**
 * Which of `ours` sit in each group `recorded` does not name, by id.
 *
 * Ascending rather than in the order the machine listed them, on the ground
 * `heldByLiveRuns` in `scripts/lib/claims/world-audit.ts` states for its own ordering: two passes over one world
 * print the same line, and a reader can diff them.
 */
function membersOutsideTheRecord(
  ours: readonly ProcessReading[],
  recorded: ReadonlySet<number>
): Map<number, number[]> {
  const members = new Map<number, number[]>();
  for (const found of ours) {
    if (recorded.has(found.pgid)) continue;
    members.set(found.pgid, [...(members.get(found.pgid) ?? []), found.pid]);
  }
  for (const [pgid, pids] of members) {
    members.set(
      pgid,
      pids.toSorted((a, b) => a - b)
    );
  }
  return members;
}

/**
 * Every group holding a finished run's processes that the run's own record does
 * not name, one line's worth per group rather than per process: the group is
 * what a record would have named and what a repair addresses, and a tree of
 * forty processes is one thing to go and end.
 *
 * Classified per run rather than machine-wide, because a group is unrecorded
 * only relative to a record — the same id can be the recorded tree of one run
 * and a stray group holding another's processes, and collapsing the two would
 * report a run's own recorded tree as an escape.
 */
async function scanStrayGroups(
  processes: readonly ProcessReading[],
  registryDir: string | undefined
): Promise<StrayGroupReading[]> {
  const byRun = processesByRun(processes);
  if (byRun.size === 0) return [];
  const live = new Set(processes.map((found) => found.pid));

  const readings: StrayGroupReading[] = [];
  for (const found of await enumerateClaims(registryDir)) {
    // A run still holding its claim may be part-way through recording the very
    // group this would report. {@link StrayGroupReading} says why that case is
    // left alone rather than reported with a softer verdict.
    if (found.state === 'owned-live') continue;
    const ours = byRun.get(found.claim.runId);
    if (ours === undefined) continue;
    const recorded = new Set(found.claim.spawned.map((spawned) => spawned.pgid));
    const carriers = new Set(ours.map((process) => process.pid));
    for (const [pgid, members] of membersOutsideTheRecord(ours, recorded)) {
      readings.push({
        pgid,
        members,
        origin: groupOrigin(pgid, carriers, live),
        owner: claimName(found.claim),
      });
    }
  }
  return readings;
}

/** Every path under `root` some process holds open, or why the question could not be put. */
type OpenPaths =
  | { readonly kind: 'read'; readonly paths: ReadonlySet<string> }
  | { readonly kind: 'unknown'; readonly reason: string };

/**
 * Asks the operating system which paths under `root` processes are holding
 * open, through the one interface that answers it without a tool this
 * repository would have to install: the process filesystem, where every
 * process's descriptors and working directory are links a reader can follow.
 *
 * Where the platform has no such filesystem the question is not asked and
 * nothing is inferred from the silence — every store then reads `unknown`, and
 * unknown is spared.
 *
 * What this reading does not cover, and why it is still the ground a removal
 * stands on: a process whose descriptors this reader may not list is one whose
 * credentials it may not inspect — another user's, or one that dropped
 * privileges — and none of those is a tool of this repository or a wrangler a
 * developer ran, which run as the user whose checkout this is. That is the same
 * premise `RECLAIMED_STORE` in `scripts/lib/claims/world-verdicts.ts` already stands on: a store sits inside this
 * checkout, so no other user's process is inside it. An E2E RAM root is the
 * one store the premise does not reach, because another user's checkout makes
 * its root on the same RAM filesystem: a process of theirs inside it goes
 * unlisted, and the removal then fails on the permission their directory
 * carries, which puts the root in front of a human rather than taking it.
 */
async function openPathsUnder(root: string, platform: NodeJS.Platform): Promise<OpenPaths> {
  if (platform !== 'linux') {
    return { kind: 'unknown', reason: 'this platform has no process filesystem to ask' };
  }
  let entries: readonly string[];
  try {
    entries = await readdir(PROCESS_FILESYSTEM);
  } catch (error) {
    return { kind: 'unknown', reason: error instanceof Error ? error.message : String(error) };
  }
  const paths = new Set<string>();
  for (const entry of entries.filter((name) => isProcessId(name))) {
    for (const held of await heldPathsUnder(path.join(PROCESS_FILESYSTEM, entry), root)) {
      paths.add(held);
    }
  }
  return { kind: 'read', paths };
}

/** The question one pass puts about a store: the caller's, or a real reading of the machine. */
export function storeQuestion(deps: WorldScanDeps): (store: string) => Promise<StoreAnswer> {
  return deps.probeStore ?? storeProbe(deps.repoRoot, deps.platform ?? process.platform);
}

/**
 * The question this pass puts about each store, asked of the machine once per
 * tree however many stores it is put about: one reading of every process serves
 * every store inside the checkout, a RAM root outside it takes a reading of its
 * own, and a pass that finds no stranded store takes no reading at all.
 */
export function storeProbe(
  repoRoot: string,
  platform: NodeJS.Platform
): (store: string) => Promise<StoreAnswer> {
  const readings = new Map<string, Promise<OpenPaths>>();
  return async (store): Promise<StoreAnswer> => {
    const directory = path.resolve(repoRoot, store);
    const tree = isInside(repoRoot, directory) ? repoRoot : directory;
    const reading = readings.get(tree) ?? openPathsUnder(tree, platform);
    readings.set(tree, reading);
    const open = await reading;
    if (open.kind === 'unknown') return { kind: 'unknown', reason: open.reason };
    const inside = [...open.paths].some((held) => isInside(directory, held));
    return { kind: inside ? 'occupied' : 'vacant' };
  };
}

/**
 * Empties one stranded store and leaves the emptied directory standing with no
 * write permission, answering with what stopped it rather than raising: a
 * bring-up must not fail because a directory it was tidying would not go, and
 * the answer is what puts the store back in front of a human.
 *
 * The directory is emptied rather than removed, and that is the whole of
 * {@link STORE_BARRIER}: a path this leaves free is a path the next write that
 * names no persist target fills again, and there is no way here to enumerate
 * the spellings of such a write. It never blinks out of existence either, so no
 * write can land in a fresh writable store between the emptying and the
 * barrier.
 *
 * Every failure therefore leaves the store standing with what it held, which is
 * what the line about one this could not deal with says. The permission is set
 * after the emptying because the emptying needs it: a directory nothing can
 * write is one nothing can remove an entry from.
 *
 * An E2E RAM root is removed whole instead, and `RECLAIMED_RAM_ROOT` in
 * `scripts/lib/claims/world-verdicts.ts` states why the barrier does not reach
 * it. A root already gone is taken as removed, since every checkout's bring-up
 * sweeps the one RAM filesystem and two can reach one root together.
 *
 * The drop lives beside the scan that enumerates the stores and the predicate
 * that calls one stranded, so nothing here can empty a path the classifier
 * would not have named.
 */
export async function removeWranglerStore(
  repoRoot: string,
  store: string
): Promise<string | undefined> {
  try {
    if (isRamRootStore(store)) {
      await rm(store, { recursive: true, force: true });
      return undefined;
    }
    const directory = path.join(repoRoot, store);
    await emptyStoreDirectory(directory);
    await chmod(directory, BARRIER_MODE);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Removes everything a wrangler store holds and leaves the directory itself
 * standing. Raises what stopped it, a directory that is not there included.
 */
export async function emptyStoreDirectory(directory: string): Promise<void> {
  for (const entry of await readdir(directory)) {
    await rm(path.join(directory, entry), { recursive: true, force: true });
  }
}

/** What one pass made of the stores it found: what stands, what went, what would not. */
interface StoreSweep {
  readonly standing: readonly string[];
  readonly reclaimed: readonly string[];
  readonly unreclaimed: readonly StoreReclaimFailure[];
  /** What the machine said about each stranded store, whether or not one was removed. */
  readonly answers: readonly WranglerStoreReading[];
}

/**
 * Decides the fate of every stranded store, and empties the ones a pass that
 * was given something to empty with may.
 *
 * The question goes to the machine on every pass, the dry run included, and
 * that is deliberate: a dry run promising a removal its own real pass would not
 * make teaches a reader to stop trusting the dry run. A pass given nothing to
 * remove with still changes nothing, which is what makes it a classification
 * rather than a cleaning.
 *
 * So a stranded store meets one of four ends and no fifth — something is inside
 * it and it is spared, the question could not be put and it is spared, it is
 * emptied and reported, or it would not empty and is put in front of a human —
 * and no pass leaves one standing without saying why.
 */
export async function sweepStores(
  stores: readonly string[],
  reclaim: ((store: string) => Promise<string | undefined>) | undefined,
  probe: (store: string) => Promise<StoreAnswer>
): Promise<StoreSweep> {
  const standing: string[] = [];
  const reclaimed: string[] = [];
  const unreclaimed: StoreReclaimFailure[] = [];
  const answers: WranglerStoreReading[] = [];
  for (const store of stores) {
    if (!isStrandedStore(store)) {
      standing.push(store);
      continue;
    }
    const answer = await probe(store);
    answers.push({ store, answer });
    if (answer.kind !== 'vacant' || reclaim === undefined) {
      standing.push(store);
      continue;
    }
    const reason = await reclaim(store);
    if (reason === undefined) {
      reclaimed.push(store);
      continue;
    }
    standing.push(store);
    unreclaimed.push({ store, reason });
  }
  return { standing, reclaimed, unreclaimed, answers };
}

/**
 * The recorded groups in the shape a line is built from. The reading itself,
 * and the rule that decides which run a group two of them recorded belongs to,
 * are the reclaim's — one enumeration serves the report and the removal, so
 * neither can say a tree is an orphan while the other leaves it alone.
 */
async function readRecordedGroups(registryDir: string | undefined): Promise<ProcessGroupReading[]> {
  const recorded = await readRecordedProcessGroups(registryDir);
  return recorded.map((group) => ({
    pgid: group.pgid,
    runLive: group.runLive,
    owner: claimName(group.claim),
  }));
}

/**
 * What this report does not cover on `platform`, or nothing where it covers
 * everything. Which platforms a recorded id addresses a tree on, and what that
 * premise stands on, are stated at `recordedGroupAddressesATree` in
 * `scripts/lib/spawn/long-lived.ts`; where it says a recorded id addresses
 * none, this class has no mechanism to read rather than a read that failed.
 *
 * It says so rather than passing over the records in silence: a pass that says
 * nothing about a record it read has certified that record clean, which is
 * exactly what it has not done. It pages about none of it, because a limit the
 * platform imposes is nothing a human can go and clear; a class that had a
 * mechanism and failed to read still pages, which is why this is decided from
 * the platform and never from a caught error. Nothing to cover says nothing at
 * all, so this is silent where no run recorded a group.
 */
function uncoveredGroups(
  platform: NodeJS.Platform,
  recorded: readonly ProcessGroupReading[]
): string | undefined {
  if (recordedGroupAddressesATree(platform) || recorded.length === 0) return undefined;
  return (
    'process groups: this report does not cover them on this platform. No recorded id ' +
    `addresses a process group here, so the ${String(recorded.length)} recorded neither show ` +
    'a tree that outlived its run nor rule one out, and nothing is paged about it.'
  );
}

/**
 * What a pass reads where the census itself failed. Nothing was established
 * about any process, so no group can be called stray — and the failure is
 * carried as a class the pass could not reach rather than as an empty answer.
 */
const NOTHING_CENSUSED: ProcessCensus = {
  kind: 'unavailable',
  reason: 'the census did not run',
};

/**
 * What this report does not cover where no live process's environment can be
 * read. It says so rather than passing over the runs in silence, for the reason
 * {@link uncoveredGroups} gives: a pass that says nothing about a class it
 * could not read has certified that class clean, which is exactly what it has
 * not done. It pages about none of it, because a class nothing offered this
 * pass is nothing a human can go and clear.
 */
async function uncoveredStrays(
  reason: string,
  registryDir: string | undefined
): Promise<string | undefined> {
  // Nothing to cover says nothing at all: with no run in the registry there is
  // no process whose group could have been left, so there is no silence here to
  // account for. Read only on a platform that cannot census, which is not one
  // this repository ever reaches on the path that can.
  const claims = await enumerateClaims(registryDir);
  if (claims.length === 0) return undefined;
  return (
    'processes that left the group their run recorded: this report does not cover them here. ' +
    `${reason}, so nothing says which run a process belongs to once it is outside every ` +
    'recorded group, and nothing is paged about it.'
  );
}

/**
 * Where the run that took a claim stands, asked of the kernel about the process
 * the claim records.
 *
 * The process group is the whole discriminator and it is asked twice: once for
 * the group the claim's own process is in, and once for the process leading
 * that group. A leader the kernel has no entry for is a group that has lost the
 * process which made it, which is what a killed run leaves behind and what no
 * other reading here separates from a healthy run — the claim's lock is held
 * either way, and the recorded process is alive either way.
 *
 * Which platforms publish a process group at all is
 * {@link recordedGroupAddressesATree}'s statement, imported rather than spelled
 * again; where it says none, and wherever the kernel would not describe a
 * process, the answer is that nothing was established.
 */
async function runRootStanding(pid: number, platform: NodeJS.Platform): Promise<RunStanding> {
  if (!recordedGroupAddressesATree(platform)) return 'unestablished';
  const pgid = await processGroupOf(pid);
  if (pgid === null) return 'unestablished';
  // The leader's own line, asked for as the group it is in: a process the
  // kernel describes is there, and one it does not is gone.
  return (await processGroupOf(pgid)) === null ? 'decapitated' : 'rooted';
}

/** Every live run in the registry, with where its own process stands. */
async function readRunRoots(
  platform: NodeJS.Platform,
  registryDir: string | undefined
): Promise<RunRootReading[]> {
  const roots: RunRootReading[] = [];
  for (const found of await enumerateClaims(registryDir)) {
    if (found.state !== 'owned-live') continue;
    roots.push({
      runId: found.claim.runId,
      standing: await runRootStanding(found.claim.pid, platform),
    });
  }
  return roots;
}

/**
 * Every purge aside beside Playwright's output directory, wherever an E2E run
 * of the checkout at `repoRoot` resolves that to: `scripts/e2e-clean.ts` mints
 * an aside by renaming the output directory, and a rename stays in its parent,
 * so on Linux the asides sit in the E2E RAM root rather than in the repository.
 */
async function scanAsides(repoRoot: string, ramHost: RamRootHost | undefined): Promise<string[]> {
  const names = await directoryNames(path.dirname(e2eOutputDir(ramHost, repoRoot)));
  return names.filter((name) => isPurgeDirectory(DEFAULT_OUTPUT_DIR, name));
}

/**
 * What comparing a daemon's statement with this stack produced: disagreements
 * it established, and the one field the pass may have had nothing to compare
 * against. Both empty is the only reading that lets the sentinel be exempted —
 * the exemption is granted on agreement, never on the absence of a
 * disagreement — but a comparison that could not be made is not a disagreement
 * either, and the two are kept apart so the line can say which it has.
 */
interface IdentityComparison {
  /** What it disagrees with this stack about, in the words the line prints. */
  readonly differences: readonly string[];
  /** Why the daemon could not be placed at all, when it could not. */
  readonly uncompared: string | undefined;
}

function compareIdentity(
  stated: DaemonIdentityRecord,
  stack: AuditedStack,
  slot: number
): IdentityComparison {
  const differences: string[] = [];
  let uncompared: string | undefined;
  if (stack.composeProject === undefined) {
    uncompared =
      `it would tear down compose project \`${stated.composeProject}\`, and this pass was ` +
      'told no project of its own to compare that with';
  } else if (stated.composeProject !== stack.composeProject) {
    differences.push(
      `it would tear down compose project \`${stated.composeProject}\`, not this stack's ` +
        `\`${stack.composeProject}\``
    );
  }
  // Canonical on both sides, because this is a string comparison over a
  // directory and a checkout reached through a symlink has two spellings.
  if (canonicalPath(stated.repoRoot) !== canonicalPath(stack.checkout)) {
    differences.push(`it was launched from \`${stated.repoRoot}\`, not this checkout`);
  }
  if (stated.slot !== slot) {
    differences.push(
      `it watches slot ${String(stated.slot)}, and this port belongs to slot ${String(slot)}`
    );
  }
  return { differences, uncompared };
}

/**
 * What the holder of one sentinel port proved. The claim is held for exactly as
 * long as its holder holds that port, and the holder is asked through `tryLock`
 * rather than through the lock file being present: the primitive never unlinks
 * one, so every daemon that has ever run has left its name on disk.
 */
async function readSentinel(
  port: number,
  slot: number,
  stack: AuditedStack,
  registryDir: string | undefined
): Promise<DaemonIdentity> {
  const probe = await tryLock(daemonIdentityLockPath(port, registryDir));
  if (!probe.held) return { kind: 'unidentified' };
  // Before the parse, because the fragment of a record parses to nothing and
  // would be reported as a daemon that states nothing — a page about a live
  // daemon whose record the next read gets whole.
  if (probe.holderPending === true) return { kind: 'publishing' };
  const stated = parseDaemonIdentity(probe.holder);
  if (stated === undefined) return { kind: 'unstated' };
  const { differences, uncompared } = compareIdentity(stated, stack, slot);
  // A difference the pass established outranks one it could not make: a daemon
  // launched from another checkout is another stack's whether or not this pass
  // could also have compared its project.
  if (differences.length > 0) return { kind: 'other-stack', stated, differences };
  if (uncompared !== undefined) return { kind: 'uncompared', stated, reason: uncompared };
  return { kind: 'this-stack' };
}

/** Every listening sentinel port, with what its holder proved about itself. */
async function scanDaemonPorts(
  listeningPorts: readonly number[],
  stack: AuditedStack,
  registryDir: string | undefined
): Promise<SentinelReading[]> {
  const readings: SentinelReading[] = [];
  for (const port of listeningPorts) {
    const slot = sentinelSlot(port);
    if (slot === undefined) continue;
    readings.push({ port, identity: await readSentinel(port, slot, stack, registryDir) });
  }
  return readings;
}

/**
 * What a pass places compose projects against when it could not read them. The
 * repository it compares against is empty rather than absent, which no real
 * reading can be: the reader below refuses instead of answering with one, so
 * this is only ever paired with an empty project list.
 */
const NO_COMPOSE_PROJECTS: ComposeProjectWorld = {
  ownerships: [],
  activeWorktreePaths: [],
  repoCommonDir: '',
  slotOfWorktree: () => null,
};

/** Where one pass reads the compose projects and everything that places them. */
interface ComposeProjectSources {
  /** The checkout being audited, whose clone every project is placed against. */
  readonly checkout: string;
  /** Every running compose project of this repository. */
  readonly projects: () => Promise<readonly DockerComposeProject[]>;
  /** Every checkout `git worktree list` names. */
  readonly activeWorktreePaths: () => Promise<readonly string[]>;
  /** The git common directory a path sits in, or nothing where none does. */
  readonly commonDirOf: (directory: string) => Promise<string | null>;
  /** Which slot each checkout holds, from the machine-wide slot registry. */
  readonly slotOfWorktree: () => ComposeProjectWorld['slotOfWorktree'];
}

/**
 * One reading of the running compose projects: the projects themselves, the
 * repository each was started in, and the two records that say which of those
 * directories are still checkouts of this clone.
 *
 * A checkout that sits in no repository at all refuses the whole class rather
 * than answering: every question the triage asks is asked against this clone,
 * so a pass that does not know which clone it is in cannot place a single
 * project, and reporting them all as another clone's would be a confident wrong
 * answer about every stack on the machine.
 */
export async function readComposeProjectWorld(
  sources: ComposeProjectSources
): Promise<ComposeProjectWorld> {
  const repoCommonDir = await sources.commonDirOf(sources.checkout);
  if (repoCommonDir === null) {
    throw new Error(`${sources.checkout} is not inside a git repository`);
  }
  const projects = await sources.projects();
  return {
    ownerships: await Promise.all(
      projects.map((project) => ownershipOf(project, sources.commonDirOf))
    ),
    activeWorktreePaths: await sources.activeWorktreePaths(),
    repoCommonDir,
    slotOfWorktree: sources.slotOfWorktree(),
  };
}

/**
 * The socket files, in the shape a line is built from. Nothing is asked of the
 * kernel here: the registry has not been read yet, so which of these a claim
 * places is not yet known, and asking would connect to a live spawner's
 * address on the way to finding out that its claim already settled it.
 */
async function readLifelineSockets(
  deps: WorldScanDeps,
  unreadable: string[]
): Promise<LifelineSocketReading[]> {
  const found = await read('lifeline sockets', deps.lifelineSockets, unreadable);
  return found.map((address) => ({ address, answer: undefined }));
}

/**
 * One reading of every class. Every class but one is read off the machine
 * before the registry is consulted at all; the process class is read out of the
 * registry, because a running tree carries nothing that says whose it was and
 * the record of the run that started it is the only thing that does.
 */
export async function scanWorld(deps: WorldScanDeps, registryDir?: string): Promise<WorldReading> {
  const unreadable: string[] = [];
  const uncovered: string[] = [];
  const containers = await read('containers', deps.containers, unreadable);
  const stuckContainers = await readStuckContainers(deps.stuckContainers, unreadable, uncovered);
  const databases = await read('databases', deps.databases, unreadable);
  const buckets = await read('buckets', deps.buckets, unreadable);
  const listeningPorts = await read('ports', deps.listeningPorts, unreadable);
  const recordedGroups = await read(
    'recorded process groups',
    () => readRecordedGroups(registryDir),
    unreadable
  );
  const uncoveredNote = uncoveredGroups(deps.platform ?? process.platform, recordedGroups);
  if (uncoveredNote !== undefined) uncovered.push(uncoveredNote);
  const census = await readValue(
    'live processes',
    deps.processes ?? (() => censusProcesses(deps.platform ?? process.platform)),
    NOTHING_CENSUSED,
    unreadable
  );
  const uncoveredCensus =
    census.kind === 'unavailable' ? await uncoveredStrays(census.reason, registryDir) : undefined;
  if (uncoveredCensus !== undefined) uncovered.push(uncoveredCensus);
  const isAlive = deps.groupIsAlive ?? groupIsAlive;
  return {
    // Both of these fall back to the class without its ages rather than to
    // nothing: the listing answered, and a failure to say how old each one is
    // is a failure of the age question alone. Dropping the resources with it
    // would turn an unanswered age into a machine on which nothing stands.
    containers: await readValue(
      'how long the containers have stood',
      () => readContainerAges(containers, deps.containerAges),
      containers.map((name) => ({ name, age: undefined })),
      unreadable
    ),
    stuckContainers,
    databases,
    buckets,
    listeningPorts: await readValue(
      'how long the listeners have stood',
      () => readListenerAges(listeningPorts, deps.listenerAge),
      listeningPorts.map((port) => ({ port, age: undefined })),
      unreadable
    ),
    runRoots: await read(
      'run roots',
      () => readRunRoots(deps.platform ?? process.platform, registryDir),
      unreadable
    ),
    processGroups:
      uncoveredNote === undefined
        ? recordedGroups.filter((group) => addressesOneTree(group.pgid) && isAlive(group.pgid))
        : [],
    strayGroups:
      census.kind === 'read'
        ? await read(
            'stray process groups',
            () => scanStrayGroups(census.processes, registryDir),
            unreadable
          )
        : [],
    daemonPorts: await read(
      'idle daemon identity',
      () => scanDaemonPorts(listeningPorts, deps.stack, registryDir),
      unreadable
    ),
    snapshots: await read(
      'snapshots',
      () => scanSnapshots(deps.repoRoot, deps.ramHost),
      unreadable
    ),
    asides: await read('purge asides', () => scanAsides(deps.repoRoot, deps.ramHost), unreadable),
    lifelineSockets: await readLifelineSockets(deps, unreadable),
    wranglerStores: [
      ...(await read('wrangler-state stores', () => scanWranglerStores(deps.repoRoot), unreadable)),
      ...(await read(
        'E2E RAM roots',
        () => scanStrandedRamRoots(deps.repoRoot, deps.ramHost),
        unreadable
      )),
    ],
    // Both empty here and filled by `reportWorldAudit` in `scripts/lib/claims/world-audit.ts`: the question about
    // what is inside a store is put only to the stores that pass is about to
    // decide the fate of, and a removal is decided after that answer.
    unreclaimedStores: [],
    storeAnswers: [],
    composeProjects: await readValue(
      'compose projects',
      deps.composeProjects,
      NO_COMPOSE_PROJECTS,
      unreadable
    ),
    unreadable,
    uncovered,
  };
}

type ClaimRecord = Awaited<ReturnType<typeof enumerateClaims>>[number]['claim'];

/** How a claim names itself on a report line, with the checkout that made it. */
export function claimName(claim: ClaimRecord): string {
  return `${claim.command} (pid ${String(claim.pid)}, slot ${String(claim.slot)}, ${claim.mode}, ${claim.gitCommonDir})`;
}

/** The slot whose sentinel `port` is, or nothing when no daemon binds it. */
export function sentinelSlot(port: number): number | undefined {
  const described = describePort(port);
  return described?.service === 'idleDaemon' ? described.slot : undefined;
}

/**
 * Whether a store belongs to no stack mode. The classifier and the removal read
 * this one predicate rather than each spelling the rule, because a report that
 * calls a store reclaimable while the removal reads the same world and takes a
 * different one is worse than no report — the same reason the compose triage is
 * imported here rather than restated.
 *
 * An E2E RAM root belongs to a checkout rather than to a stack mode, and the
 * scan lists one only once that checkout is gone, so every one it lists is
 * stranded.
 */
export function isStrandedStore(store: string): boolean {
  if (isRamRootStore(store)) return true;
  const modes: readonly string[] = STACK_MODES;
  return !modes.includes(path.basename(store));
}
