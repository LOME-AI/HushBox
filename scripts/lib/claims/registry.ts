import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { stagedWrite } from '../staged-write.js';
import { canonicalPath } from '../canonical-path.js';
import { STACK_MODES, type StackMode } from '../stack/port-plan.js';
import { claim, tryLock } from './claim.js';

/**
 * The registry of runs. One directory per pnpm invocation records what that
 * invocation owns; beside it sits the lock file the run holds for its whole
 * lifetime, and holding that lock is the entire liveness predicate.
 *
 * There is deliberately no central index. Every run writes only its own
 * directory, so nothing can be corrupted collectively, and losing the registry
 * makes every resource *unowned* — which is reported and never killed. The
 * failure direction is the argument for the shape.
 *
 * Two facts about the lock primitive govern everything here. Its file's bytes
 * are its own — it writes the holder description into them — so a run's record
 * is a sibling, never the lock file. And it never unlinks a lock file, because
 * unlinking one lets a waiter hold a deleted inode while the next acquirer
 * locks a fresh one. A released claim therefore leaves its lock file on disk
 * carrying the last holder's name, so state is asked of `tryLock` and is never
 * inferred from a file being present.
 *
 * The registry is machine-scoped rather than per-checkout: ports are a
 * machine-wide resource, so two clones sharing a per-clone registry would
 * silently claim the same slot. Temp is also local disk, which keeps file
 * locking reliable when a checkout sits on a network mount. Nothing clears
 * that directory and the platform is not relied on to empty temp, so the lock
 * files left behind accumulate without bound — accepted rather than an
 * oversight. The per-user subdirectory is what keeps the temp directory shared
 * between users on Linux from being a shared registry.
 */

/** Carries the run's directory to every process the run spawns. */
export const RUN_CLAIM_ENV = 'HB_RUN_CLAIM';

const HEADER_FILE = 'run.json';
const ENTRY_PREFIX = 'entry-';
const ENTRY_SUFFIX = '.json';

const RESOURCE_KINDS = [
  'port',
  'slot',
  'database',
  'bucket',
  'container',
  'compose-project',
  'directory',
  'socket',
] as const;

type ResourceKind = (typeof RESOURCE_KINDS)[number];

/** What a run owns, in the spelling whichever reclaimer drops it recognises. */
interface ResourceRef {
  readonly kind: ResourceKind;
  readonly id: string;
}

/**
 * A long-lived child. Both numbers are recorded because the two platforms
 * address a process tree differently, and because the run's own lock says
 * nothing about its children: a detached grandchild does not inherit the lock
 * descriptor, so killing the run leaves the child running against a claim that
 * already reads free.
 */
interface SpawnedProcess {
  readonly pid: number;
  readonly pgid: number;
}

export interface RunInit {
  /** How the run names itself to anyone reading or refused by its claim. */
  readonly command: string;
  readonly mode: StackMode;
  readonly slot: number;
  /**
   * The checkout this run belongs to, so the auditor can attribute a resource
   * to it. Supplied by the caller rather than resolved here: the registry is
   * machine-scoped and knows nothing about checkouts. Stored canonically
   * whatever spelling arrives, because every reclaimer that asks whether a
   * claim is this checkout's compares this value as a string and a checkout
   * reached through a symlink has two absolute spellings.
   */
  readonly gitCommonDir: string;
  /** Defaults to {@link claimsDir}. */
  readonly registryDir?: string;
}

interface RunClaim {
  readonly runId: string;
  readonly command: string;
  readonly mode: StackMode;
  readonly slot: number;
  readonly pid: number;
  readonly gitCommonDir: string;
  readonly spawned: readonly SpawnedProcess[];
  readonly resources: readonly ResourceRef[];
}

/** A claim whose run still holds its lock, or one whose run does not. */
type ClaimState = 'owned-live' | 'owned-expired';

interface EnumeratedClaim {
  readonly claim: RunClaim;
  readonly state: ClaimState;
}

/**
 * A run whose record could not be read. Its directory is there and its lock
 * answers, so the run is as present as any other; everything the record would
 * have said — the slot, the checkout, the resources, the children — is unknown
 * and stays unknown until a human looks.
 */
interface UnreadableClaim {
  /** The run directory's name, which is the whole of what identifies it. */
  readonly runId: string;
  /** From its lock, exactly as every other claim's state comes from its lock. */
  readonly state: ClaimState;
  /** Why the record could not be read, in the words a reader is shown. */
  readonly reason: string;
}

const resourceSchema = z.object({
  kind: z.enum(RESOURCE_KINDS),
  id: z.string().min(1),
});

const spawnedSchema = z.object({
  pid: z.number().int().positive(),
  pgid: z.number().int().positive(),
});

const headerSchema = z.object({
  runId: z.string().min(1),
  command: z.string().min(1),
  mode: z.enum(STACK_MODES),
  slot: z.number().int().nonnegative(),
  pid: z.number().int().positive(),
  gitCommonDir: z.string().min(1),
});

const entrySchema = z.discriminatedUnion('entry', [
  z.object({ entry: z.literal('resource'), resource: resourceSchema }),
  z.object({ entry: z.literal('process'), process: spawnedSchema }),
]);

type RunHeader = z.infer<typeof headerSchema>;
type ClaimEntry = z.infer<typeof entrySchema>;

/** Everything a filename may carry on every platform, and nothing else. */
function fileSafe(name: string): string {
  return name.replaceAll(/[^\w.-]/g, '-');
}

/** The machine-wide registry every checkout on this account shares. */
export function claimsDir(): string {
  return path.join(os.tmpdir(), `hushbox-claims-${fileSafe(os.userInfo().username)}`);
}

/** The lock whose holder is the run, beside — never inside — the run's record. */
export function lockPathFor(dir: string, runId: string): string {
  return path.join(dir, `${runId}.lock`);
}

/**
 * The shape {@link registerRun} mints a run id in, and so the shape a lock file
 * of its own has. The registry directory is shared with locks that are not
 * runs' — the idle daemon's, the test template's — and reading one of those as
 * a run would attribute resources to a run that never existed.
 */
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The run a lock file in the registry belongs to, or undefined for a lock file
 * this module never minted. The inverse of {@link lockPathFor}.
 */
function runLockId(entry: string): string | undefined {
  if (!entry.endsWith('.lock')) return undefined;
  const runId = entry.slice(0, -'.lock'.length);
  return RUN_ID_PATTERN.test(runId) ? runId : undefined;
}

/** Rename, so a reader never sees a record halfway written. */
async function writeRecord(target: string, value: RunHeader | ClaimEntry): Promise<void> {
  await stagedWrite(target, JSON.stringify(value));
}

/**
 * One entry file of a record, by the name {@link appendEntry} gives it. Both
 * halves are load-bearing: the staged write of an entry is named after the
 * entry it will become, so it carries the prefix too, and only the tail tells a
 * record apart from a write still in flight beside it.
 */
function isEntryRecord(file: string): boolean {
  return file.startsWith(ENTRY_PREFIX) && file.endsWith(ENTRY_SUFFIX);
}

/** Something a run must let go of, in the spelling of whoever created it. */
type RunRelease = () => void | Promise<void>;

const pendingReleases = new Set<RunRelease>();

/**
 * Registers a release to run while this run's record is still on disk.
 *
 * Ordering, not a second mechanism. A run's record is the only thing that says
 * who owns what it created, and a resource still standing once that record has
 * gone is *unowned* — the one state a reclaimer reports and never removes. A
 * resource released by a process-exit handler is therefore released strictly
 * too late: the removal below has already happened, so an invocation that
 * finished the way it meant to manufactures exactly the debris the reclaimers
 * exist to answer.
 *
 * The drop code stays in the module that created the resource, which is what
 * keeps one writer per resource; this only sequences it against the removal.
 */
export function releaseBeforeRecordDrops(release: RunRelease): void {
  pendingReleases.add(release);
}

async function releaseWhatThisRunCreated(): Promise<void> {
  const releases = [...pendingReleases];
  // Taken before any of them runs, so a release is never run twice and a run
  // that follows this one in the same process starts with its own set.
  pendingReleases.clear();
  for (const release of releases) await release();
}

/**
 * Runs `body` under a run this process inherited rather than started, releasing
 * what it registered before handing back to the process that owns the record.
 *
 * The release is the whole of what an adopting process does on its way out, and
 * it is not optional here. A resource such a process creates goes into its
 * parent's record, so the ordering it has to keep is against the *parent's*
 * removal of that record — and the parent is waiting on this process, so a
 * release run before this returns is a release run while the record naming what
 * it released is still on disk. The alternative was to refuse the registration
 * outright, on the reasoning that a descendant cannot own a release against a
 * run it did not start; it can, and it is the only thing that can, because it
 * is the process that created the resource and holds the handle to it.
 */
async function adoptRun<T>(body: () => Promise<T>): Promise<T> {
  const result = await body();
  await releaseWhatThisRunCreated();
  return result;
}

/**
 * Registers this invocation and holds its claim until `body` settles.
 *
 * A process that inherited a run adopts it instead of registering a second one:
 * one invocation is one run however many processes it wraps itself in, and the
 * parent's lock is what says the run is alive. An adopting process therefore
 * neither takes a lock nor removes the record when it exits; what it does do,
 * exactly as the process that started the run does, is release what it
 * registered.
 */
export async function registerRun<T>(init: RunInit, body: () => Promise<T>): Promise<T> {
  const inherited = process.env[RUN_CLAIM_ENV];
  if (inherited !== undefined && inherited !== '') return adoptRun(body);

  const dir = init.registryDir ?? claimsDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const runId = randomUUID();
  const runDir = path.join(dir, runId);
  const header: RunHeader = {
    runId,
    command: init.command,
    mode: init.mode,
    slot: init.slot,
    pid: process.pid,
    gitCommonDir: canonicalPath(init.gitCommonDir),
  };

  return claim(
    { name: init.command, lockPath: lockPathFor(dir, runId) },
    { onHeld: 'refuse', holder: init.command },
    async () => {
      await mkdir(runDir, { recursive: true });
      await writeRecord(path.join(runDir, HEADER_FILE), header);
      process.env[RUN_CLAIM_ENV] = runDir;
      try {
        const result = await body();
        // Released before the record naming it goes, never after: the removal
        // below is what would otherwise leave it unowned, and unowned is the
        // state nothing may touch. {@link releaseBeforeRecordDrops} says why.
        await releaseWhatThisRunCreated();
        // Removed only when the run ends the way it meant to. A run that threw
        // or was killed may have created something it never dropped, and its
        // record is the only thing that can tell the next run what to reclaim.
        await rm(runDir, { recursive: true, force: true });
        return result;
      } finally {
        process.env[RUN_CLAIM_ENV] = '';
      }
    }
  );
}

/**
 * `subject` is what the refusal below names, and it is passed in rather than
 * derived here so that a caller with no claim is told which thing it was about
 * to create unattributably. A refusal naming only the rule leaves whoever meets
 * it searching every recorder in the command for the one that fired.
 */
async function appendEntry(subject: string, entry: ClaimEntry): Promise<void> {
  const runDir = process.env[RUN_CLAIM_ENV];
  if (runDir === undefined || runDir === '') {
    throw new Error(
      `Nothing to record ${subject} against: this process holds no run claim. Wrap the ` +
        'invocation in `registerRun` before it creates anything, so what it ' +
        'creates can be reclaimed.'
    );
  }
  // A fresh filename per entry, so concurrent recorders never contend: there is
  // no record to read, modify and write back, and nothing to lose.
  await writeRecord(path.join(runDir, `${ENTRY_PREFIX}${randomUUID()}${ENTRY_SUFFIX}`), entry);
}

/** Records a resource this run owns. Claim before you create it. */
export async function addResource(resource: ResourceRef): Promise<void> {
  await appendEntry(`the ${resource.kind} \`${resource.id}\``, { entry: 'resource', resource });
}

/** Records a child whose tree a later run may have to reap. */
export async function addSpawnedProcess(spawned: SpawnedProcess): Promise<void> {
  await appendEntry(`process group ${String(spawned.pgid)}`, {
    entry: 'process',
    process: spawned,
  });
}

/**
 * Drops the entries of `runId`'s record that name `pgid`, and nothing else in
 * that record or any other.
 *
 * The inverse of {@link addSpawnedProcess}, and the one edit made to a record
 * by something other than the run that wrote it. A recorded group id stops
 * meaning what it meant the moment nothing is in the group: the kernel hands
 * the number to unrelated work, so an entry left behind is a number every later
 * pass re-examines and no later pass can ever act on correctly. Dropping the
 * entry is what keeps that population from growing without bound.
 *
 * **Only the one entry, never the record.** The same record is what the port,
 * socket, database, bucket and container reclaimers read to attribute what they
 * find; removing it would turn everything else that run owns from
 * *owned-expired*, which is culled, into *unowned*, which is reported and left
 * standing forever.
 *
 * **The caller establishes that no run is writing this record.** Every run
 * writes its own directory and no other, which is what makes the registry
 * uncorruptable collectively; this is reached only for the record of a run
 * whose lock has already answered that it is gone.
 *
 * An entry that cannot be read is left where it is: it names no group this
 * could match, and a reader that already reported it is the one that says so.
 *
 * The registry is named rather than defaulted, unlike every reader here: this
 * one removes something, and a caller that meant a registry of its own and got
 * the machine-wide one would edit the records of every checkout on the host.
 */
export async function retireRecordedGroup(runId: string, pgid: number, dir: string): Promise<void> {
  const runDir = path.join(dir, runId);
  const files = await listRecord(runDir);
  if (files === null) return;
  for (const file of files) {
    if (!isEntryRecord(file)) continue;
    const entry = await readRecord(path.join(runDir, file), entrySchema);
    if (entry.kind !== 'read') continue;
    if (entry.value.entry !== 'process' || entry.value.process.pgid !== pgid) continue;
    // Force, because a record removed by the run that wrote it while this pass
    // was reading is the outcome this wanted rather than a failure.
    await rm(path.join(runDir, file), { force: true });
  }
}

/**
 * What one read of a record file made of it. The third answer is the one that
 * must never collapse into the second: a record that is not there was removed
 * by the run that wrote it, while one that is there and cannot be made sense of
 * says nothing at all about the run behind it — including whether that run is
 * using the slot something is about to tear down.
 */
type RecordReading<T> =
  | { readonly kind: 'read'; readonly value: T }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable'; readonly reason: string };

async function readRecord<T>(file: string, schema: z.ZodType<T>): Promise<RecordReading<T>> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    // The two ways a path names no record at all: nothing is there, or
    // something that is not a directory sits where a run's directory would be.
    // The registry is a directory in shared temp that any tool may drop a file
    // into, and a reader of one must expect an entry it did not write —
    // refusing on the first stray file would take every reclaimer and the world
    // audit down with it. A record that IS there and cannot be made sense of
    // takes the branch below instead, and one that cannot be read at all still
    // throws from here.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent' };
    throw error;
  }

  const decoded = parseJson(raw);
  if (decoded === undefined) return { kind: 'unreadable', reason: 'it is not JSON' };
  const parsed = schema.safeParse(decoded);
  if (!parsed.success) {
    return { kind: 'unreadable', reason: `this version does not recognise ${issuesOf(parsed)}` };
  }
  return { kind: 'read', value: parsed.data };
}

/** What a schema objected to, short enough to sit in a warning line. */
function issuesOf(parsed: z.ZodSafeParseError<unknown>): string {
  return parsed.error.issues
    .map((issue) =>
      issue.path.length === 0 ? issue.message : `${issue.path.join('.')}: ${issue.message}`
    )
    .join('; ');
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Says out loud that a run's record could not be read, naming the directory
 * whoever reads this has to go and look at.
 *
 * A pass that read one of these and said nothing would have certified the slot
 * empty and the run's resources unowned — the two answers that license
 * destroying what a live run is using. So the reading is stated, and the repair
 * is a human's: nothing here removes a record it cannot read.
 */
function reportUnreadableRecord(runDir: string, reason: string): void {
  console.warn(
    `Cannot read the claim record in ${runDir}: ${reason}. It counts as a run that may hold ` +
      'any slot and own anything, so nothing is reclaimed and no stack is torn down on its ' +
      'behalf. Remove the directory by hand once you have established that no run is using it.'
  );
}

/**
 * Says out loud that one entry of an otherwise readable record could not be
 * read. The run itself still reads, so its slot and its checkout are known; what
 * is not known is everything that entry recorded, which is why nothing may treat
 * the rest of the record as the whole of what the run owns.
 */
function reportUnreadableEntry(runDir: string, file: string, reason: string): void {
  console.warn(
    `Cannot read \`${file}\` in the claim record in ${runDir}: ${reason}. Whatever it ` +
      'recorded reads as owned by nobody, so it is reported rather than reclaimed.'
  );
}

/** The files of a run's record, or null if the record has gone. */
async function listRecord(runDir: string): Promise<string[] | null> {
  try {
    return await readdir(runDir);
  } catch (error) {
    // A record that goes while it is being read is no claim, exactly as a
    // record that was never there is: the run it described removed it.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** One entry of a record, or nothing where it has gone or could not be read. */
async function readEntry(runDir: string, file: string): Promise<ClaimEntry | undefined> {
  const entry = await readRecord(path.join(runDir, file), entrySchema);
  if (entry.kind === 'absent') return undefined;
  if (entry.kind === 'unreadable') {
    reportUnreadableEntry(runDir, file, entry.reason);
    return undefined;
  }
  return entry.value;
}

/** The resources and processes a run recorded, or null if its record has gone. */
async function readEntries(
  runDir: string
): Promise<{ resources: ResourceRef[]; spawned: SpawnedProcess[] } | null> {
  const files = await listRecord(runDir);
  if (files === null) return null;

  const resources: ResourceRef[] = [];
  const spawned: SpawnedProcess[] = [];
  for (const file of files) {
    if (!isEntryRecord(file)) continue;
    const entry = await readEntry(runDir, file);
    if (entry === undefined) continue;
    if (entry.entry === 'resource') resources.push(entry.resource);
    else spawned.push(entry.process);
  }
  return { resources, spawned };
}

/** A run directory read, in the three answers a run directory can give. */
type ClaimReading =
  | { readonly kind: 'claim'; readonly found: EnumeratedClaim }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable'; readonly found: UnreadableClaim };

async function readClaim(dir: string, runId: string): Promise<ClaimReading> {
  const runDir = path.join(dir, runId);
  const headerFile = path.join(runDir, HEADER_FILE);
  const header = await readRecord(headerFile, headerSchema);
  if (header.kind === 'absent') return { kind: 'absent' };
  if (header.kind === 'unreadable') {
    return readUnknownClaim(dir, runId, headerFile, header.reason);
  }

  const entries = await readEntries(runDir);
  if (entries === null) return { kind: 'absent' };

  const probe = await tryLock(lockPathFor(dir, runId));
  // {@link registerRun} removes the record inside the claim body and the
  // primitive releases the lock only after that body settles, so removal
  // strictly precedes release. A free lock therefore says a run that died when
  // its record is still there and a run that finished when the record has
  // gone, with no clock in either answer. Without this re-read, a run
  // finishing during the reads above is reported as owned-expired while still
  // naming ports and slots it has already dropped — addresses a successor run
  // may by then hold, and a reclaimer would drop them out from under it.
  const again = await readRecord(headerFile, headerSchema);
  if (!probe.held && again.kind === 'absent') return { kind: 'absent' };

  return {
    kind: 'claim',
    found: {
      claim: { ...header.value, ...entries },
      state: probe.held ? 'owned-live' : 'owned-expired',
    },
  };
}

/**
 * The run behind a record nothing could read, classified the way every other
 * claim is: by asking its lock. The record said nothing, so the lock is not
 * merely the best evidence of liveness available here — it is the only evidence
 * there ever was, and a damaged record takes none of it away.
 */
async function readUnknownClaim(
  dir: string,
  runId: string,
  headerFile: string,
  reason: string
): Promise<ClaimReading> {
  const probe = await tryLock(lockPathFor(dir, runId));
  // The same re-read, for the same reason as the readable path: a run that
  // finished while this pass was reading removed its record before it released
  // its lock, so a free lock over a record that has since gone names a run that
  // ended rather than one whose record is damaged.
  const again = await readRecord(headerFile, headerSchema);
  if (!probe.held && again.kind === 'absent') return { kind: 'absent' };

  reportUnreadableRecord(path.dirname(headerFile), reason);
  return {
    kind: 'unreadable',
    found: { runId, state: probe.held ? 'owned-live' : 'owned-expired', reason },
  };
}

/**
 * One reading of the whole registry: the records this pass read, and the run
 * directories it could not.
 *
 * The two are kept apart rather than merged or dropped because they license
 * different acts. A record that was read says which slot its run holds and what
 * it owns, so a reclaimer can act on it. One that could not be read says none of
 * that, and reading its silence as "no claim" is what turns a damaged file into
 * a destroyed stack — the run is alive, its lock says so, and everything it is
 * using looks free.
 */
interface RegistryReading {
  /** The claims whose records were read. */
  readonly claims: readonly EnumeratedClaim[];
  /** The runs whose records were not: present, and nothing more is known. */
  readonly unreadable: readonly UnreadableClaim[];
  /**
   * The runs this registry once held and no longer has a record for.
   *
   * {@link registerRun} removes a run's record on its way out and the lock
   * primitive never unlinks a lock file, so a run that ended the way it meant
   * to leaves its lock file and nothing else. That residue is the difference
   * between a resource **our** run minted and one no run ever claimed, and
   * without it the two are the same answer: a run whose child died while the
   * claim holder itself exited cleanly leaves a resource attributable to
   * nobody, which is the one state a reclaimer reports and never removes.
   *
   * These runs are over. A lock file exists from the instant the claim is
   * requested, while the record appears only once the claim is granted, so this
   * set also holds a run in the moment between the two — and such a run owns
   * nothing yet, because the environment variable that names a run to anything
   * creating a resource is written after its record. So no resource on disk can
   * carry the id of a run this set names prematurely, and reading the set costs
   * the directory listing that was taken anyway rather than a probe per lock
   * file, of which this machine-wide directory accumulates one per run forever.
   */
  readonly endedRuns: readonly string[];
}

export async function enumerateRegistry(dir: string = claimsDir()): Promise<RegistryReading> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { claims: [], unreadable: [], endedRuns: [] };
    }
    throw error;
  }

  // A lock file is not a claim: the primitive never unlinks one, so a released
  // claim leaves its lock behind carrying the last holder's name. It is still
  // evidence that a run of that name existed, which is the whole of what tells
  // its leftovers from a stranger's.
  const locked = new Set(entries.flatMap((name) => runLockId(name) ?? []));

  const claims: EnumeratedClaim[] = [];
  const unreadable: UnreadableClaim[] = [];
  const recorded = new Set<string>();
  for (const name of entries) {
    if (name.endsWith('.lock') || name.startsWith('.')) continue;
    const found = await readClaim(dir, name);
    if (found.kind === 'claim') {
      claims.push(found.found);
      recorded.add(found.found.claim.runId);
    } else if (found.kind === 'unreadable') {
      unreadable.push(found.found);
      recorded.add(found.found.runId);
    }
  }
  return {
    claims,
    unreadable,
    endedRuns: [...locked].filter((runId) => !recorded.has(runId)),
  };
}

/**
 * The live runs among the records a reading could not read.
 *
 * One spelling, imported by every reader of it, because each is deciding
 * whether something may be destroyed. Filters over the same field, held in
 * agreement by hand, are the shape `docs/CODE-RULES.md` §One Implementation,
 * Shared forbids, and a drift between them would license a destruction rather
 * than merely disagree.
 *
 * Liveness is the lock here as everywhere: `state` is `tryLock`'s answer, and
 * an expired unread record names a run that is gone.
 */
export function unreadLiveRuns(reading: RegistryReading): UnreadableClaim[] {
  return reading.unreadable.filter((found) => found.state === 'owned-live');
}

/**
 * Every claim in the registry whose record could be read, each classified by
 * asking its lock. A run directory is what makes a claim; a lock file left
 * behind by a released one is not a claim and is not reported.
 *
 * A run whose record could not be read is *not* among these, and a caller that
 * decides whether something may be destroyed reads {@link enumerateRegistry}
 * instead: this list is what was read, never what is there.
 *
 * Attributing a resource to one of these claims is `readOwnership` in
 * `scripts/lib/claims/ownership.ts`, which indexes a single enumeration and
 * answers a whole pass from it. There is deliberately no second answer here: two
 * spellings of "which claim owns this, live wins" decide whether a resource is
 * destroyed, so drift between them would be a destructive disagreement.
 */
export async function enumerateClaims(dir: string = claimsDir()): Promise<EnumeratedClaim[]> {
  const reading = await enumerateRegistry(dir);
  return [...reading.claims];
}

/** What the registry can say about one slot, in the two answers it has. */
interface SlotLiveness {
  /** The live runs that recorded this slot. */
  readonly claimed: readonly RunClaim[];
  /**
   * The live runs whose records could not be read. A record that says nothing
   * says nothing about its slot either, so nothing rules one of these off this
   * slot — which is why they are reported beside the claims rather than counted
   * among them or left out of the answer.
   */
  readonly unknown: readonly UnreadableClaim[];
}

/**
 * Whether anything is using `slot`, across every checkout on this machine.
 *
 * Both halves have to be read before a slot is called free: a caller that reads
 * `claimed` alone and finds it empty has concluded the slot is idle from a pass
 * that may have failed to read the very run holding it.
 *
 * This is the only slot-scoped reading there is, and a projection handing back
 * `claimed` on its own used to sit beside it. Nothing stopped a caller reaching
 * for that one and reading its silence as an empty slot — both stack guards
 * did — so it is gone rather than documented: a caller that ignores `unknown`
 * now has to name the field it is dropping.
 */
export async function readSlotLiveness(
  slot: number,
  dir: string = claimsDir()
): Promise<SlotLiveness> {
  const reading = await enumerateRegistry(dir);
  return {
    claimed: reading.claims
      .filter((found) => found.state === 'owned-live' && found.claim.slot === slot)
      .map((found) => found.claim),
    unknown: unreadLiveRuns(reading),
  };
}
