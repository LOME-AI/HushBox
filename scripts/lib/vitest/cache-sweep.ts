import { realpathSync } from 'node:fs';
import { mkdir, readdir, rm, stat, utimes } from 'node:fs/promises';
import path from 'node:path';

import { canonicalPath } from '../canonical-path.js';
import { ClaimHeldError, HELD_CLAIMS_ENV, claim } from '../claims/claim.js';
import { readOwnership, recordOwnedResourceIfClaimed } from '../claims/ownership.js';
import { getWorkspacePaths } from '../cli/workspaces.js';
import {
  CACHE_DIR_NAME_PATTERN,
  RUN_CACHE_GENERATION_ENV,
  RUN_CACHE_SEGMENT_ENV,
  RUN_CACHE_SEGMENT_PATTERN,
  isRunnerMarker,
  cacheDirName,
  optimizedSourcesFingerprint,
  runCacheSegment,
  slotCacheSegment,
} from './vitest-cache.js';
import type { Ownership } from '../claims/ownership.js';

/**
 * Claiming and sweeping the content-addressed cache generations `vitest-cache.ts`
 * names. Split from that module rather than living in it, and the split is
 * load-bearing: the shared vitest config imports the naming half, so every
 * package's typecheck follows it, and the claim registry reaches the native
 * locking package whose declaration only this package's own program can see.
 * A module the config never imports may depend on the registry; the one it does
 * import may not.
 *
 * Two questions decide a generation's fate, and only the first is about
 * correctness. A generation a live run claimed is untouchable, because deleting
 * one is a run destroying another run's working set — the load error content
 * addressing exists to prevent. Liveness is the advisory lock on that run's
 * claim, a kernel fact the OS drops the instant the run dies however it dies,
 * with no clock in the answer. What survives that question is held by nobody,
 * and how long it is then kept is a retention choice over disposable data.
 */

/**
 * How long an unclaimed generation is kept. Retention, not a liveness test: it
 * is asked only about generations no live run holds, and what it keeps is the
 * namespace rather than a warm bundle — the bundles inside belong to individual
 * runs and go with them. Nothing about correctness rests on its size.
 *
 * It used to be the whole protection, and could not be. A generation directory's
 * own mtime stops advancing early in the run that stamped it, so age measures
 * when a run last STARTED on a generation and says nothing about whether that
 * run is still going; any run outliving this window — a watch session is bounded
 * by nothing — had its generation deleted out from under its optimizer.
 */
export const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * One spelling per directory, so a claim and a sweep agree on what they name: a
 * trailing separator or a `.` segment on either side would otherwise make the
 * same directory two ids.
 */
function generationId(cacheDir: string): string {
  return path.resolve(cacheDir);
}

/**
 * Every `node_modules` a project root of this run resolves its `cacheDir`
 * under: this process's working directory, the repository root, and every
 * workspace the manifest declares. Derived from that manifest rather than
 * listed, so a workspace added to it is claimed and swept with nothing here to
 * edit.
 *
 * The working directory is named on its own account rather than assumed to be
 * one of the workspaces: a run started outside them would otherwise resolve a
 * generation this module neither claims nor walks.
 *
 * Every root is canonicalised through the filesystem, not merely resolved. A
 * checkout reached through a symlink gives the same directory two absolute
 * spellings, and a claim recorded under one says nothing about a sweep walking
 * the other — the id is a string comparison. One spelling is also what lets the
 * working directory and the workspace naming it collapse to a single entry.
 */
export function cacheNodeModulesDirectories(repoRoot: string, projectRoot: string): string[] {
  const roots = [
    projectRoot,
    repoRoot,
    ...getWorkspacePaths(repoRoot).map((workspace) => path.join(repoRoot, workspace)),
  ];
  return [...new Set(roots.map((root) => path.join(realpathSync(root), 'node_modules')))];
}

/**
 * Stamps the generation this process resolves its own `cacheDir` to, creating
 * it if nothing has yet.
 *
 * Retention bookkeeping, not ownership: it makes the age gate measure time
 * since a run last used this generation rather than time since some run created
 * it, so a long-lived branch keeps one warm generation for days. Ownership is
 * the claim {@link claimAndPruneCacheDirectories} records, and that call has to
 * come first — creating a directory this run has not claimed is an orphan by
 * construction.
 */
export async function markCacheDirUsed(cacheDir: string, now: number): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
  const seconds = now / 1000;
  await utimes(cacheDir, seconds, seconds);
}

interface CacheGenerationSweep {
  /** Every `node_modules` to claim in and sweep; vitest resolves `cacheDir` per project root. */
  readonly nodeModulesDirectories: readonly string[];
  /** The generation this run is using — claimed everywhere, and never deleted. */
  readonly generationName: string;
  /**
   * The invocation directory this run is using inside that generation — claimed
   * everywhere, and never deleted. Two same-shape runs share the generation, so
   * this is the only thing separating their bundles.
   */
  readonly runSegment: string;
  readonly maxAgeMs: number;
  readonly now: number;
  /** The claim registry to read ownership from. Defaults to the machine-wide one. */
  readonly registryDir?: string | undefined;
}

/** Whether this generation may be deleted: unheld by any live run, and past the window. */
async function isDisposable(
  generation: string,
  options: CacheGenerationSweep,
  ownership: Ownership
): Promise<boolean> {
  if (ownership.stateOfResource('directory', generationId(generation)) === 'owned-live') {
    return false;
  }
  const lastUsed = await lastUsedAt(generation);
  return lastUsed !== undefined && options.now - lastUsed > options.maxAgeMs;
}

/**
 * Whether this invocation directory may be deleted.
 *
 * Unlike a generation, an invocation directory is one run's working set rather
 * than a warm store, so a run that has finished with one leaves nothing worth
 * keeping: an expired claim is the whole answer and the age gate is not asked.
 * The gate still decides directories NO claim names, which is what a runner
 * invoked outside the wrappers leaves — nothing can tell those from a live
 * one's, and age is the only reading left.
 *
 * The answer covers everything inside it. A run may start several runners and
 * each keeps a directory of its own in here, none of them claimed on its own
 * account, so an expired claim condemns the whole subtree and a live one
 * protects it.
 */
async function isDisposableInvocation(
  invocation: string,
  options: CacheGenerationSweep,
  ownership: Ownership
): Promise<boolean> {
  const state = ownership.stateOfResource('directory', generationId(invocation));
  if (state === 'owned-live') return false;
  if (state === 'owned-expired') return true;
  const lastUsed = await lastUsedAt(invocation);
  return lastUsed !== undefined && options.now - lastUsed > options.maxAgeMs;
}

/**
 * The invocation directories removed from one generation.
 *
 * This run's own is skipped by name as well as by claim, because a runner
 * invoked outside the wrappers holds no claim to be recognised by and would
 * otherwise delete the directory it is itself about to bundle into.
 *
 * It stops at this level and never walks into an invocation directory. The
 * runner directories inside one are the only cache directories nothing ever
 * claims — a runner derives its own name and starts bundling before any code of
 * ours runs in it — so judging one on its own account would find it unowned and
 * hand every live runner's working set to the age gate. The claim on the
 * directory holding them is what answers for them, which is why the claim is
 * taken one level out.
 */
async function sweepInvocations(
  generation: string,
  isCurrentGeneration: boolean,
  options: CacheGenerationSweep,
  ownership: Ownership
): Promise<string[]> {
  const removed: string[] = [];
  for (const name of await listNames(generation)) {
    if (!RUN_CACHE_SEGMENT_PATTERN.test(name)) continue;
    if (isCurrentGeneration && name === options.runSegment) continue;
    const invocation = path.join(generation, name);
    if (!(await isDisposableInvocation(invocation, options, ownership))) continue;
    await rm(invocation, { recursive: true, force: true });
    removed.push(invocation);
  }
  return removed;
}

/** The generations and invocation directories removed from one `node_modules`. */
async function sweep(
  nodeModules: string,
  options: CacheGenerationSweep,
  ownership: Ownership
): Promise<string[]> {
  const removed: string[] = [];
  for (const name of await listNames(nodeModules)) {
    if (!CACHE_DIR_NAME_PATTERN.test(name)) continue;
    const generation = path.join(nodeModules, name);
    const isCurrentGeneration = name === options.generationName;
    if (!isCurrentGeneration && (await isDisposable(generation, options, ownership))) {
      await rm(generation, { recursive: true, force: true });
      removed.push(generation);
      continue;
    }
    removed.push(...(await sweepInvocations(generation, isCurrentGeneration, options, ownership)));
  }
  return removed;
}

/**
 * Claims this run's generation under every `node_modules` given, then deletes
 * the generations no live run holds and no run has used within `maxAgeMs`.
 * Returns what it removed.
 *
 * Claiming and sweeping are one call because they have to read one list. A
 * consolidated run mints the same generation name under every project root, so
 * a claim covering only the directory this process resolves leaves every other
 * copy guarded by the age gate alone — and a concurrent run on another branch,
 * walking the same roots for a different fingerprint, deletes a working set out
 * from under a live optimizer. Two lists held in agreement by hand is that
 * failure; the one array below is what makes it unreachable.
 *
 * Claimed before anything creates the directories, because a claim naming a
 * directory nothing created is harmless while a directory nothing claimed is an
 * orphan by construction. A process holding no run claim records nothing and
 * leaves generations no sweep can attribute, which the age gate then treats
 * exactly as it treated every generation before claims existed.
 */
export async function claimAndPruneCacheDirectories(
  options: CacheGenerationSweep
): Promise<string[]> {
  for (const nodeModules of options.nodeModulesDirectories) {
    const generation = path.join(nodeModules, options.generationName);
    await recordOwnedResourceIfClaimed('directory', generationId(generation));
    await recordOwnedResourceIfClaimed(
      'directory',
      generationId(path.join(generation, options.runSegment))
    );
  }

  // One reading answers the whole sweep: re-reading between generations would
  // classify them against two different worlds.
  const ownership = await readOwnership(options.registryDir);

  // A live run whose record could not be read may be holding any of these, and
  // nothing in that record says which — so no generation here is one this pass
  // can tell from debris. Deleting them anyway is the harm the claim replaced
  // age to end: a run outliving the window losing its working set. The state
  // needs no corruption to arrive; a record a wider checkout wrote is invalid
  // to a narrower reader, so two checkouts of different ages produce it.
  if (ownership.unreadLiveRuns.length > 0) {
    const named = ownership.unreadLiveRuns.map((found) => found.runId).join(', ');
    console.warn(
      `Skipped sweeping cache generations: the record of live run ${named} could not be ` +
        'read, so no generation here can be told from one that run is using. Nothing was ' +
        "removed; sweep again once that run's directory has been dealt with."
    );
    return [];
  }

  const removed: string[] = [];
  for (const nodeModules of options.nodeModulesDirectories) {
    removed.push(...(await sweep(nodeModules, options, ownership)));
  }
  return removed;
}

/** What a process holding a run's claim needs to claim for the runner it starts. */
interface RunnerCacheClaim {
  readonly repoRoot: string;
  /** The directory the runner is started in; the runner resolves its cache path against it. */
  readonly projectRoot: string;
  /** The process minting the names, which is the one holding the run's claim. */
  readonly processId: number;
  /**
   * The environment the runner is started with. The minted names are written
   * into it, which is how the runner is told which directory was claimed for
   * it; a caller starting the runner with an inherited environment passes
   * `process.env`.
   */
  readonly env: Record<string, string | undefined>;
  readonly now: number;
  /** Defaults to the machine-wide registry; a test points it elsewhere. */
  readonly registryDir?: string | undefined;
  /** Defaults to {@link CACHE_SLOTS}; a test exhausts a smaller pool. */
  readonly slots?: number | undefined;
}

/**
 * Takes a slot of the cache pool, mints the names the runners started inside
 * `body` bundle beneath, claims those directories, prunes what nothing holds,
 * runs `body`, and gives the slot back on the way out.
 *
 * **A scope rather than two calls, because taking and giving back are one act
 * and the order between them is the whole mechanism.** This call cannot take
 * without giving back, and what it gives back is what it took; nothing is left
 * for its caller to remember, and no caller of it can put the two in the wrong
 * order. That is this call's own contract and not a property of the module:
 * recording a directory is {@link recordOwnedResourceIfClaimed}, which every reclaimer
 * here reaches on its own account, and `vitest-cache.ts`'s
 * `runnerCacheClaimRefusal` admits a runner on the two cache environment names
 * alone — so a process recording these two directories by hand records what
 * this records. What keeps that shape from being written is every runner start
 * here going through this call.
 *
 * The claim comes before the runner starts, and that is the whole point of it
 * being here rather than inside the runner. The dependency optimizer creates
 * the invocation directory and commits bundles into it while the runner builds
 * its project servers, before any code of ours runs in that process; a runner
 * claiming for itself therefore claims after the directory already holds files,
 * and one killed in between leaves a directory no claim names — reclaimable
 * only by the retention gate, which is a clock, and which by Global Constraint
 * is never what answers whether a resource is still in use. The claim holder
 * has no such ordering problem: it is running, it holds the claim, and nothing
 * has created anything yet.
 *
 * **A slot's directory is kept, and that is what a run finds warm.** What is
 * removed on the way out is the private directory a run takes when every slot
 * was held: nothing but the process that named it can ever resolve it again, so
 * standing it would be debris no claim names once the run's record goes — the
 * one state a reclaimer reports and never removes, leaving the retention clock.
 * A slot's directory is the opposite: the next run to hold that slot resolves
 * it deliberately, and what is inside is the prebundle it is there to reuse.
 * The removal that does run happens before this call returns, inside the run's
 * claim, whose record is dropped only once everything under it has finished —
 * so the directory is gone while the record still names it. A drop written in
 * the runner's own teardown could not do that: a runner killed mid-flight never
 * reaches a teardown, and this process is the one that watched it die.
 *
 * The generation is read from the sources here rather than passed in, so one
 * call is the whole act, and it is handed to the runner rather than left for it
 * to derive: a runner reading sources this process did not read — a mutation
 * run's, handed an instrumented copy of the tree — would otherwise address a
 * generation of its own and land beside the directory claimed here. A runner
 * started without the names this call mints is refused by the global setup
 * every runner passes through, unless no run claim encloses it, in which case it
 * derives its own names and is reclaimed the way anything unclaimed is.
 *
 * What this call names is the directory every runner started inside `body`
 * bundles beneath, not any one runner's own. A caller may start several at once
 * and cannot know how many; each takes a numbered directory of its own inside
 * this one, and releasing those numbers is an act of taking the slot rather
 * than of leaving it — see {@link releaseRunnerMarkers}.
 *
 * The generation stays: it outlives any one run, and the retention gate is what
 * decides when it goes. What that gate is still left holding is a runner
 * reached outside these wrappers, which records no claim for anything to drop.
 */
export async function withRunnerCacheClaim<T>(
  options: RunnerCacheClaim,
  body: () => Promise<T>
): Promise<T> {
  const generationName = cacheDirName(await optimizedSourcesFingerprint(options.repoRoot));
  const nodeModulesDirectories = cacheNodeModulesDirectories(options.repoRoot, options.projectRoot);
  return withCacheSlot(options, async (slot) => {
    const runSegment =
      slot === null ? runCacheSegment(options.processId) : slotCacheSegment(slot.number);
    options.env[RUN_CACHE_GENERATION_ENV] = generationName;
    options.env[RUN_CACHE_SEGMENT_ENV] = runSegment;
    await claimAndPruneCacheDirectories({
      nodeModulesDirectories,
      generationName,
      runSegment,
      maxAgeMs: CACHE_MAX_AGE_MS,
      now: options.now,
      registryDir: options.registryDir,
    });
    if (slot?.taken === true) {
      await releaseRunnerMarkers(
        path.join(realpathSync(options.repoRoot), 'node_modules', generationName, runSegment)
      );
    }
    try {
      return await body();
    } finally {
      if (slot === null) {
        for (const nodeModules of nodeModulesDirectories) {
          await rm(path.join(nodeModules, generationName, runSegment), {
            recursive: true,
            force: true,
          });
        }
      }
    }
  });
}

/**
 * How many numbered slots one checkout's pool holds.
 *
 * It bounds concurrency, not correctness: a run arriving when every slot is
 * held takes a private directory and pays a cold prebundle, so a number too
 * small costs warmth and a number too large costs disk. Four covers what this
 * checkout is observed to run — three runs held three slots at one instant
 * while this was measured, and several commands overlapping in one checkout is
 * the ordinary shape here. Disk is what stops it climbing: a slot holds one
 * prebundle of the optimized packages per workspace it is resolved under, and
 * one slot's directories across every workspace measured at 80 MB, which is
 * what each slot added costs again in every generation.
 */
const CACHE_SLOTS = 4;

/**
 * Where the pool's claims live: beside the generations, in a directory no
 * generation pattern matches and no sweep walks. Never inside a slot's own
 * directory — a sweep that reclaims a killed run's slot would take the lock
 * file with it, and a claimer that opened that file before the removal would
 * hold a deleted inode while the next one creates and locks a fresh one.
 */
export const CACHE_SLOT_CLAIMS_DIR = '.vite-cache-slots';

/** The slot a run is bundling under, and whether this run is the one that took it. */
interface HeldCacheSlot {
  readonly number: number;
  /**
   * `false` where the claim was already held by a process this one was started
   * inside, whose runners may be bundling in the slot right now. It decides one
   * thing: releasing the markers is the act of taking a slot, and doing it
   * inside somebody else's hold would hand two live runners one directory.
   */
  readonly taken: boolean;
}

/** The claims this process was started holding, as the claim primitive spells them. */
function inheritedClaims(): Set<string> {
  const raw = process.env[HELD_CLAIMS_ENV];
  return new Set(raw === undefined || raw === '' ? [] : raw.split('\n'));
}

/** The file whose advisory lock is one slot of this checkout's pool. */
function cacheSlotLockPath(repoRoot: string, slot: number): string {
  return path.join(
    realpathSync(repoRoot),
    'node_modules',
    CACHE_SLOT_CLAIMS_DIR,
    `slot-${String(slot)}.lock`
  );
}

/**
 * Runs `body` holding the lowest free slot of the pool, or holding none at all
 * when every slot is held.
 *
 * Refusing and moving on rather than waiting: a run queueing for a warm
 * directory would be serialized behind a run that may take minutes, and the
 * private directory the last case falls through to is what this repository did
 * for every run before the pool existed. So the worst case here is the old
 * behaviour, and nothing waits on anything.
 *
 * A refusal of this slot is told from a refusal the body raised by the resource
 * the refusal names, which nothing outside this module spells. The body taking
 * claims of its own is ordinary, and treating one of those as this slot being
 * held would move the run to another slot and run its body twice.
 */
async function withCacheSlot<T>(
  options: RunnerCacheClaim,
  body: (slot: HeldCacheSlot | null) => Promise<T>
): Promise<T> {
  const inherited = inheritedClaims();
  const slots = options.slots ?? CACHE_SLOTS;
  for (let slot = 0; slot < slots; slot += 1) {
    const lockPath = cacheSlotLockPath(options.repoRoot, slot);
    const resource = { name: `vitest cache slot ${String(slot)}`, lockPath };
    const held: HeldCacheSlot = { number: slot, taken: !inherited.has(canonicalPath(lockPath)) };
    try {
      return await claim(
        resource,
        { onHeld: 'refuse', holder: `vitest runner (pid ${String(options.processId)})` },
        () => body(held)
      );
    } catch (error) {
      if (!(error instanceof ClaimHeldError) || error.resource !== resource.name) throw error;
    }
  }
  return body(null);
}

/**
 * Frees the runner directories inside a slot for the run now holding it.
 *
 * The markers are what keep two runners of ONE run out of one directory, and a
 * runner killed mid-flight leaves its own behind. Releasing them here is what
 * makes that recoverable without asking whether anything is alive: this process
 * holds the slot exclusively, so nothing can be bundling inside it, and the
 * next run's first runner takes the lowest directory again and finds the
 * bundles the last one left. Only the markers go — the directories they name
 * are the warmth.
 */
async function releaseRunnerMarkers(directory: string): Promise<void> {
  for (const name of await listNames(directory)) {
    if (isRunnerMarker(name)) await rm(path.join(directory, name), { force: true });
  }
}

/**
 * A workspace that has never been installed has no `node_modules`, and a
 * concurrent lane may delete a generation between the listing and the stat.
 * Both are ordinary outcomes; any other failure is a real one.
 */
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function listNames(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

async function lastUsedAt(dir: string): Promise<number | undefined> {
  try {
    const stats = await stat(dir);
    return stats.mtimeMs;
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
}
