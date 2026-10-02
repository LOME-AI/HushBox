import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type * as Fingerprint from '../cli/fingerprint.ts';

// Explicit-URL runtime import: wherever this module is loaded by Node's own
// loader rather than through a transform that rewrites specifiers, a `.js`
// specifier resolves literally and finds no such file next to
// `../cli/fingerprint.ts` — the constraint `packages/config/vitest.config.ts`
// states in full. Hashing is NOT reimplemented for the same reason it is not
// reimplemented anywhere else: two hashers over one source of truth drift.
const { composeFingerprint, fileFingerprint, treeFingerprint } = (await import(
  new URL('../cli/fingerprint.ts', import.meta.url).href
)) as typeof Fingerprint;

/**
 * Content-addressed vitest cache directories.
 *
 * Vite's prebundle-reuse test hashes `optimizeDeps.include`/`exclude`, `root`,
 * `resolve`, `assetsInclude`, plugin names and the lockfile — none of which
 * observes the SOURCE of a linked workspace package. Editing `packages/shared/src`
 * therefore changes no input to that hash, so vite keeps reusing a prebundle of
 * code that no longer exists and the suite reports the resulting assertion
 * failure in the exact language of a real defect. Naming the cache directory
 * after the sources' content is what removes that failure mode: a source edit
 * resolves to a directory vite has never seen, so there is nothing stale to reuse.
 *
 * Content, not mtime: a fresh CI clone stamps every file "now", so an mtime key
 * would cold-rebundle on every job, and mtime is itself a staleness source. The
 * warmth inside a generation is {@link slotCacheSegment}'s: a run holds a
 * numbered slot for its length and finds there what the last holder left, so
 * what content addressing is doing is keeping an edited source from ever
 * resolving to a name that could hold the prebundle of what it replaced.
 *
 * Naming, and the one directory a runner takes for itself. Claiming a slot or a
 * generation, sweeping the ones nothing holds, and releasing a slot's runner
 * markers all live in `cache-sweep.ts`, which reaches the claim registry: the
 * shared vitest config imports THIS module, so every package's typecheck
 * follows whatever it imports, and the registry's native locking package is
 * declared where only this package's own program can see it. That is why
 * {@link allocateRunnerCacheSegment} takes its directory with an exclusive
 * create rather than with a claim, and why the claim holder is what makes that
 * recoverable.
 */

/**
 * The packages the SSR dep optimizer prebundles. This is the single declaration:
 * `deps.optimizer.ssr.include` is derived from it (see `OPTIMIZER_INCLUDE`), so a
 * package cannot be opted into the prebundle without its source feeding the cache
 * key — which is exactly the stale-prebundle failure this module removes.
 */
export const OPTIMIZED_PACKAGES = ['db', 'shared', 'crypto'] as const;

/** `deps.optimizer.ssr.include`, as workspace specifiers. */
export const OPTIMIZER_INCLUDE: string[] = OPTIMIZED_PACKAGES.map((name) => `@hushbox/${name}`);

/**
 * Only `.vite-<16 hex>` is a cache generation. The strictness is the safety
 * property, not a style choice: `node_modules` also holds `.vite-temp` (vite's
 * config-loading directory, derived from the node_modules path and not from
 * `cacheDir`) and `.vite` (the dev server's own dep cache). A prefix match on
 * `.vite-` would delete the first and a glob on `.vite*` both.
 */
export const CACHE_DIR_NAME_PATTERN = /^\.vite-[\da-f]{16}$/;

/**
 * Digest of everything the SSR dep optimizer bundles: each optimized package's
 * `src` tree plus its `package.json` (entry points and exports change what gets
 * bundled without any `src` byte changing).
 */
export async function optimizedSourcesFingerprint(repoRoot: string): Promise<string> {
  const digests = await Promise.all(
    OPTIMIZED_PACKAGES.map(async (packageName) => {
      const packageRoot = path.join(repoRoot, 'packages', packageName);
      return [
        await fileFingerprint(path.join(packageRoot, 'package.json')),
        await treeFingerprint(path.join(packageRoot, 'src')),
      ];
    })
  );
  return composeFingerprint(digests.flat());
}

/** Directory name for a fingerprint; 64 bits is far past collision relevance here. */
export function cacheDirName(fingerprint: string): string {
  return `.vite-${fingerprint.slice(0, 16)}`;
}

/**
 * The two shapes a run's directory inside a generation takes, and nothing else:
 * a numbered slot the run holds under a claim, or the private directory of a
 * run that found every slot held. The strictness is the same safety property
 * {@link CACHE_DIR_NAME_PATTERN} states — a generation holds nothing else this
 * prune may remove, and a looser match would reach the runner's own children.
 */
export const RUN_CACHE_SEGMENT_PATTERN = /^run-(?:slot-\d+|[\da-f]{16})$/;

/**
 * The private segment one run's dependency bundles sit beneath when it found
 * every slot of the pool held, given the process deciding it — the claim
 * holder, which is what makes this the directory a claim can name before
 * anything exists in it.
 *
 * The generation directory is addressed by the content it bundles and the
 * lifted segment by the invocation shape, and neither separates two runs of the
 * SAME shape — which share every one of those directories. Observed rather than
 * reasoned: with two same-shape runs pointed at one directory, the arriving run
 * removed it and rebundled, and every test file the running one collected
 * during that gap died on a dependency bundle that was no longer there.
 *
 * The arriving run removes it whenever it judges the directory invalid, and the
 * runner's validity test covers the installed dependency state and the whole
 * resolved configuration — the plugin list included, which nothing here knows
 * before the runner builds it. So the trigger cannot be enumerated at the
 * moment this name is chosen, and a name that folded in the triggers anyone
 * happened to think of would leave the class open. What CAN be stated is that a
 * run touching only a directory no other run can reach removes the sharing
 * itself rather than the reasons for it.
 *
 * Exclusive access is what {@link slotCacheSegment} gets from a claim, and a
 * name that outlives the process is what makes the bundle under it reusable.
 * This one is what is left when no slot is free: it is private, because a
 * process id is, and it is cold, because nothing has ever written the directory
 * it names. A cold prebundle rather than a crash is the whole distinction, and
 * this is the case the pool cannot cover.
 *
 * A digest rather than the number itself, so the name is bounded, uniform with
 * the generation's, and carries no process detail into a path.
 *
 * A run may start more than one runner, so this is not where a runner's bundles
 * go: {@link runnerCacheSegment} names one runner's own directory inside this
 * one. This derivation is the mint, and a process may use it only for a
 * directory it then claims. What the runner itself reads goes through
 * {@link resolveRunnerCacheNames}.
 */
export function runCacheSegment(processId: number): string {
  return `run-${composeFingerprint([String(processId)]).slice(0, 16)}`;
}

/**
 * The numbered segment one run's dependency bundles sit beneath while it holds
 * that slot's claim.
 *
 * A name derived from the run's own identity cannot be warm: the next
 * invocation is a different process and resolves a directory nothing has ever
 * written. A slot is the opposite — it names a place rather than a run, so
 * sequential runs take slot zero and find the bundles the last holder left,
 * while concurrent runs take zero, one, two, each warm from its own history and
 * none of them sharing.
 *
 * Holding it under the claim is what makes reuse safe. The failure
 * {@link runCacheSegment} records is two live runs writing one directory; a run
 * that only ever touches a directory it holds exclusively cannot delete one
 * another run is reading, whatever the optimizer decides inside it. Nothing
 * waits, either: a run finding every slot held takes a private directory
 * instead of queueing for one.
 *
 * The two invocation shapes need no slot of their own. `liftedCacheDir` puts a
 * lifted project's bundles inside the package's own cache directory, so the
 * shapes address different directories beneath one slot and a slot handed from
 * one to the other costs neither its warmth.
 */
export function slotCacheSegment(slot: number): string {
  return `run-slot-${String(slot)}`;
}

/**
 * Only `runner-<number>` is a runner's own directory, and the prune never asks
 * about one: it lives inside a run directory a claim names, and that claim
 * answers for everything beneath it.
 */
export const RUNNER_CACHE_SEGMENT_PATTERN = /^runner-\d+$/;

/**
 * The suffix on a runner marker. One spelling, so the allocator that writes a
 * marker and the release that recognises one cannot drift into naming two
 * different things.
 */
const RUNNER_MARKER_SUFFIX = '.taken';

/**
 * The marker one runner leaves beside the directory it took, so a sibling
 * starting at the same moment takes a different directory.
 */
export function runnerMarkerName(runnerSegment: string): string {
  return `${runnerSegment}${RUNNER_MARKER_SUFFIX}`;
}

/**
 * Whether this entry of a run's directory is a marker rather than a runner's
 * bundles. The suffix is the whole difference, and it is what keeps releasing
 * the markers from reaching a directory the next run is there to reuse.
 */
export function isRunnerMarker(name: string): boolean {
  return (
    name.endsWith(RUNNER_MARKER_SUFFIX) &&
    RUNNER_CACHE_SEGMENT_PATTERN.test(name.slice(0, -RUNNER_MARKER_SUFFIX.length))
  );
}

/**
 * The directory one runner's dependency bundles sit in, inside the run
 * directory its claim holder named, numbered from zero.
 *
 * Numbered rather than derived from the runner, and that is what makes the
 * directory reusable: a name carrying the runner's own identity is a directory
 * nothing has ever written, which is the whole cost the slot above it exists to
 * remove. Zero is what a run's first runner takes, so the bundles the last
 * holder of the slot left are the ones it finds.
 */
export function runnerCacheSegment(index: number): string {
  return `runner-${String(index)}`;
}

/**
 * The lowest directory in the claimed one this runner can have, taken by
 * creating a marker for it that nothing else can create.
 *
 * Numbers cannot simply be handed down: one claim holder may start several
 * runners at once — a mutation tool declaring a concurrency constructs one
 * runner per worker process — and a name reaching the environment reaches every
 * descendant. Observed rather than reasoned: four concurrent runners under one
 * handed-down name resolved one directory, and the first of them to finish
 * removed it while the other three were still bundling out of it. So the runner
 * takes its own number, and an exclusive create is what makes two arriving
 * together take two.
 *
 * A marker outlives the runner that made it, and nothing here asks whether that
 * runner is alive: the claim holder releases every marker in the directory as
 * it takes the slot, which is the one moment nothing can be running inside it.
 * A run killed mid-flight therefore costs its successor nothing, and no clock,
 * age or liveness inference enters the allocation.
 *
 * Answering the same runner twice with the same directory is what lets a runner
 * ask once where it loads its configuration and again where it stamps it: the
 * marker carries the asking process, and a marker that is already this
 * process's is this process's directory rather than a taken one.
 */
export function allocateRunnerCacheSegment(claimedDirectory: string, processId: number): string {
  mkdirSync(claimedDirectory, { recursive: true });
  const mine = String(processId);
  for (let index = 0; ; index += 1) {
    const segment = runnerCacheSegment(index);
    const marker = path.join(claimedDirectory, runnerMarkerName(segment));
    try {
      writeFileSync(marker, mine, { flag: 'wx' });
      return segment;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (markerHolder(marker) === mine) return segment;
    }
  }
}

/**
 * Who took the directory this marker names, or nothing where that cannot be
 * read. Unreadable counts as somebody else's: the question this answers is
 * whether the directory is already this process's, and a marker that cannot
 * say so is one to pass over.
 */
function markerHolder(marker: string): string | undefined {
  try {
    return readFileSync(marker, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Carry the claimed generation and run segment from the process holding the
 * run's claim to every runner it starts. Both, rather than the segment alone:
 * the generation is addressed by the content of the sources, and a runner
 * reading sources the claim holder did not read — a mutation run, whose runner
 * is handed an instrumented copy of the tree — derives a generation of its own
 * and lands beside the directory the claim named rather than in it.
 *
 * These two name the claimed directory, which several runners may share; a
 * runner's own bundles go in a {@link runnerCacheSegment} directory inside it,
 * taken by the runner itself and deliberately absent from this environment.
 */
export const RUN_CACHE_GENERATION_ENV = 'HB_VITEST_CACHE_GENERATION';
export const RUN_CACHE_SEGMENT_ENV = 'HB_VITEST_CACHE_SEGMENT';

/** The directory one runner bundles into, as its three levels. */
export interface RunnerCacheNames {
  readonly generationName: string;
  /** The claimed directory, shared by every runner the same claim holder starts. */
  readonly runSegment: string;
  /** This runner's own directory inside it, taken by it and shared with nothing. */
  readonly runnerSegment: string;
}

/** The claimed directory a runner bundles beneath, as its two levels. */
type ClaimedCacheNames = Omit<RunnerCacheNames, 'runnerSegment'>;

/**
 * The names a claim holder minted for the runners it starts, or nothing when it
 * minted none this reader can use.
 *
 * A name outside the shape the prune recognises counts as unminted: it would
 * address a directory outside the prune's reach, and reaching that prune is the
 * point of the whole path. Either name missing discards both, because the pair
 * addresses one directory and half a claimed address is no address.
 */
function mintedRunnerCacheNames(
  env: Readonly<Record<string, string | undefined>>
): ClaimedCacheNames | undefined {
  const generationName = env[RUN_CACHE_GENERATION_ENV];
  const runSegment = env[RUN_CACHE_SEGMENT_ENV];
  return generationName !== undefined &&
    runSegment !== undefined &&
    CACHE_DIR_NAME_PATTERN.test(generationName) &&
    RUN_CACHE_SEGMENT_PATTERN.test(runSegment)
    ? { generationName, runSegment }
    : undefined;
}

/**
 * The directory this runner bundles into: its own, inside the directory its
 * claim holder minted and recorded before starting it — or, for a runner
 * nothing claimed for, inside one derived here.
 *
 * The two answers for the outer two levels are two orders, and only one of them
 * is the order the claim mechanism rests on. The optimizer creates the
 * directory and commits bundles into it while the runner builds its project
 * servers, which is before any code of ours runs inside the runner; names
 * derived here therefore cannot be recorded until after the directory already
 * holds files, and a runner killed in between leaves a directory no claim
 * names. Minting them in the process that already holds the claim is what puts
 * the claim first, and the environment is how the runner is told which
 * directory was claimed for it.
 *
 * The innermost level is taken under a minted claim, and is the only level
 * taken rather than derived: carrying it would hand every runner under one
 * claim the same directory, and {@link allocateRunnerCacheSegment} records what
 * that did. Taking it is a create that cannot be raced rather than a
 * derivation, so it is numbered from zero and the same number comes back to the
 * same runner asking twice — which is what keeps the claimed directory reusable
 * instead of private to whichever process happened to bundle in it last.
 *
 * Deriving the outer two is the unclaimed shape — the runner reached directly
 * rather than through a command of this repository's — where there is no claim
 * to record against and the retention gate is the only reclaimer left. A runner
 * a run claim DOES enclose is a different case, and
 * {@link runnerCacheClaimRefusal} is where it is answered.
 *
 * The unclaimed shape derives the innermost level too, and the reason it can is
 * the reason it must. It can, because the run segment it sits in is derived
 * from the asking process, so no other runner ever addresses that directory and
 * there is nothing to arbitrate — the first number is free by construction.
 * It must, because taking a number means creating the directory the marker goes
 * in, here at the repository root, while the runner's `cacheDir` is relative and
 * resolves against each project's own root: for a project rooted anywhere else
 * that create leaves a directory holding a marker and no bundle, which nothing
 * but the retention gate would ever reclaim.
 */
export async function resolveRunnerCacheNames(
  env: Readonly<Record<string, string | undefined>>,
  processId: number,
  repoRoot: string
): Promise<RunnerCacheNames> {
  const claimed = mintedRunnerCacheNames(env);
  if (claimed === undefined) {
    return {
      generationName: cacheDirName(await optimizedSourcesFingerprint(repoRoot)),
      runSegment: runCacheSegment(processId),
      runnerSegment: runnerCacheSegment(0),
    };
  }
  return {
    ...claimed,
    runnerSegment: allocateRunnerCacheSegment(
      path.join(repoRoot, 'node_modules', claimed.generationName, claimed.runSegment),
      processId
    ),
  };
}

/**
 * Why a runner started inside a run that claimed no cache directory for it is
 * refused, or nothing when there is nothing to refuse.
 *
 * **This is the assertion that keeps claim-before-create from resting on every
 * future starter remembering to claim.** The commands here that spawn a runner
 * take the claim inline, ahead of the spawn; nothing about that arrangement
 * says a new one must, and the starter this repository cannot see is the one
 * that proves the point — a third-party tool constructing a runner in its own
 * process is reached by no spawn site here, so no sweep of this repository's
 * own spawn sites could ever enumerate them. Every runner passes through the
 * global setup that asks this, whatever started it, because the shared config
 * names that setup.
 *
 * A runner no run claim encloses is not refused: there is no claim for its
 * directory to be recorded against, so refusing would buy nothing the retention
 * gate is not already left holding, and running a runner directly stays a thing
 * a developer may do.
 */
export function runnerCacheClaimRefusal(
  env: Readonly<Record<string, string | undefined>>,
  runId: string | null
): string | undefined {
  if (runId === null || mintedRunnerCacheNames(env) !== undefined) return;
  return (
    'vitest-cache: this runner was started inside a run that claimed no cache directory for ' +
    'it, so the directory its dependency optimizer has already written into is one no claim ' +
    'names and only the retention gate could reclaim. The process that starts a runner runs it ' +
    'inside `withRunnerCacheClaim` from `scripts/lib/vitest/cache-sweep.ts`, which every command ' +
    'here that spawns a runner does. A command that reaches a runner some other way takes the ' +
    'same claim by running through `scripts/with-runner-cache-claim.ts`.'
  );
}

/**
 * The segment a lifted project's dependency bundles sit beneath.
 *
 * This repository invokes vitest two ways, and vite's prebundle-reuse test
 * hashes the plugin-NAME list: a package-rooted invocation registers a
 * standalone instance, the consolidated one lifts the same package into a
 * project instance, and the two produce different names. A relative `cacheDir`
 * resolves against the project's own root under both, so without this segment
 * both address one directory — and a mismatched hash makes vite delete the
 * dependency directory and rebundle, under whatever run is importing from it.
 * Partition rather than arbitration: the two shapes address different
 * directories, so nothing waits and neither can invalidate the other. The
 * generation is already addressed by the content it bundles; this addresses it
 * by the second thing that decides whether a bundle is valid.
 */
const LIFTED_CACHE_SEGMENT = 'lifted';

/**
 * Where a lifted project caches, given the directory its package's own config
 * declares. Inside that directory rather than beside it, so the generation stays
 * the outermost name and the sweep that removes a whole `.vite-<fingerprint>`
 * still reclaims both shapes at once.
 *
 * A package declaring no cache directory is refused rather than defaulted: the
 * default would be the one vite picks for the package-rooted shape too, which is
 * the collision this segment exists to remove.
 */
export function liftedCacheDir(packageCacheDir: string | undefined, packageDir: string): string {
  if (packageCacheDir === undefined || packageCacheDir === '') {
    throw new Error(
      `vitest-cache: ${packageDir} declares no cacheDir, so its lifted project would share one ` +
        `directory with the package-rooted invocation of the same package and each would delete ` +
        `the other's dependency bundle mid-run. Merge the shared vitest config, which declares one.`
    );
  }
  return path.join(packageCacheDir, LIFTED_CACHE_SEGMENT);
}
