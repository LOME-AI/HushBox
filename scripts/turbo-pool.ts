import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { execa, type Options as ExecaOptions } from 'execa';

import { ARGUMENT_SEPARATOR } from './lib/cli/argument-separator.js';
import { isMainModule } from './lib/cli/is-main.js';
import { runMain } from './lib/cli/run-main.js';
import { asElectedCacheWriter } from './lib/turbo/cache-writer.js';
import { LINT_TOOL_ARGS } from './lib/lint-tool-args.js';
import { machineFingerprint, performanceCoreCount } from './lib/pool/machine.js';
import {
  ledgerPath,
  readLedger,
  writeLedger,
  type LedgerEntry,
  type PoolLedger,
} from './lib/pool/ledger.js';
import { sampleOnInterval } from './lib/pool/interval-sampler.js';
import { foldTreePeak, type TreePeak } from './lib/pool/tree-peak.js';
import {
  PLANNING_MEMORY_FRACTION,
  memoryBudgetKb,
  sampleAttributedTreePssKb,
  type AttributedTreePssKb,
} from './lib/pool/memory.js';
import {
  derivationBasis,
  deriveConcurrency,
  scheduleOrder,
  type PoolTaskEstimate,
  type RunObservation,
} from './lib/pool/schedule.js';
import { parseTaskRuns } from './lib/pool/turbo-dry-run.js';

/**
 * Duration-ordered pool of per-package turbo invocations, for tasks whose
 * per-package executions are independent single processes (lint, typecheck).
 * turbo stays the cache authority — every spawn is a normal filtered
 * `turbo <task>` run that hashes and caches itself — while this wrapper owns
 * whatever turbo leaves undecided about those invocations, including the
 * arguments the tool behind the task is run with: turbo hashes those into its
 * cache key, so every read of that cache has to be taken under the same ones.
 *
 * Concurrency comes from what previous runs measured, never from a coefficient:
 * each run records the wall of every package it ran, the peak its whole tree
 * reached, what it held outside its lanes, and how many lanes were live at the
 * sample that reached that peak — the width the run is filed at. How many lanes
 * that buys is {@link deriveConcurrency}'s to decide — a memory projection can
 * take the count below what the work shape alone would ask for — and the line
 * this module logs before it opens the pool names the count, the limit that set
 * it in {@link derivationBasis}'s words, and the figure the projection checked
 * the count against, or that nothing examined it at all.
 *
 * CLI: `turbo-pool <task> [--force] [--no-record] [-- <args forwarded to the tool>]`.
 * Flags are recognized wherever they appear — pnpm re-inserts `--` before user
 * args, so position carries no meaning; every other flag forwards to the tool.
 * `--continue` is accepted and dropped: independent invocations always continue.
 * `--no-record` reads the ledger without writing it, for runs like `lint:fix`
 * whose shape is not the shape the ledger describes.
 */

export interface PoolArgs {
  readonly task: string;
  readonly force: boolean;
  /** False for a run whose timings must not teach the ledger. */
  readonly record: boolean;
  readonly forwarded: readonly string[];
}

/** Flags the pool answers itself; everything else belongs to the tool. */
const OWN_FLAGS = new Set([ARGUMENT_SEPARATOR, '--force', '--no-record', '--continue']);

export function parsePoolArgs(argv: readonly string[]): PoolArgs {
  let task: string | undefined;
  const forwarded: string[] = [];
  // A bare token is the task until one has been found; after that it belongs to
  // the flag it follows, because a forwarded flag may take a value
  // (`--format summary`). Reading it as a second task instead is what made
  // `lint:summary` unrunnable.
  let previousWasForwardedFlag = false;
  for (const argument of argv) {
    if (OWN_FLAGS.has(argument)) continue;
    if (argument.startsWith('-')) {
      forwarded.push(argument);
      previousWasForwardedFlag = true;
      continue;
    }
    if (task === undefined) {
      task = argument;
    } else if (previousWasForwardedFlag) {
      forwarded.push(argument);
    } else {
      throw new Error(`Unexpected second positional argument: "${argument}"`);
    }
    previousWasForwardedFlag = false;
  }
  if (task === undefined) throw new Error('A turbo task name is required, e.g. "lint"');
  return {
    task,
    force: argv.includes('--force'),
    record: !argv.includes('--no-record'),
    forwarded,
  };
}

export interface PoolEntry {
  readonly package: string;
  readonly dir: string;
}

export interface PoolResult {
  readonly package: string;
  /**
   * The code the command exited with, or undefined where it reported none — a
   * child killed by a signal exits with no code at all, and the process runner
   * hands back a result that carries no such figure. Kept undefined rather than
   * stood in for, because any number here would be a code nothing reported and
   * would read as an ordinary failure of the tool.
   */
  readonly exitCode: number | undefined;
  readonly wallMs: number;
}

type TaskRunner = (entry: PoolEntry) => Promise<{ exitCode: number | undefined }>;

/** Run entries in exactly the given order, at most `concurrency` at a time. */
export async function runPool(
  ordered: readonly PoolEntry[],
  concurrency: number,
  runTask: TaskRunner,
  now: () => number
): Promise<PoolResult[]> {
  const results: PoolResult[] = [];
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < ordered.length) {
      const entry = ordered[cursor];
      cursor += 1;
      /* v8 ignore next -- the cursor is bounded by the array it indexes */
      if (!entry) break;
      const startedAt = now();
      const outcome = await runTask(entry);
      results.push({ ...outcome, package: entry.package, wallMs: now() - startedAt });
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, ordered.length)) }, () =>
    worker()
  );
  await Promise.all(workers);
  return results;
}

/**
 * How often the pool's own process tree is measured. A sample is expensive:
 * each process's proportional set size costs the kernel a walk of that
 * process's whole VMA list, so one sample over a package test run's tree costs
 * tens of milliseconds, and a quarter second or more over the stretch where
 * that tree is at its largest — a hundred processes or so.
 *
 * A quarter second is kept regardless, because the peak this exists to catch
 * is a spike rather than a plateau: traced across such a run, the tree stood
 * within one percent of its peak for one sample out of a few hundred, and
 * re-deriving that run's peak from every fourth sample of the trace gave up as
 * much as five percent of it, depending where the samples fell. Understating
 * the peak is the direction that hurts, because the concurrency cap reads it
 * and a low reading plans a run that does not fit.
 *
 * What gives instead is the blocking. The sampler issues its reads together
 * and off the main thread, which more than halves the window a single sample
 * spends adding up a tree that keeps moving under it, and leaves this process
 * free to drain the children it is waiting on while a sample is outstanding.
 */
export const PSS_SAMPLE_INTERVAL_MS = 250;

export interface PoolPeakRecorder {
  /** A lane has opened under this pid: count it and read it until it leaves. */
  readonly enter: (pid: number) => void;
  readonly leave: (pid: number) => void;
  /**
   * Take one sample and fold it in, returning the tree's total for that same
   * sample — the shape {@link sampleOnInterval} drives, so the split and the
   * whole-tree peak come out of one reading rather than two.
   */
  readonly sample: (treeRootPid: number) => Promise<number | undefined>;
  /** Stop folding and report what the samples reached. */
  readonly stop: () => TreePeak;
}

/**
 * Reads the tree over the lanes this pool has open, and folds every reading
 * through {@link foldTreePeak} — the same fold the vitest launchers' recorder
 * uses, so a row filed here and a row filed there mean one thing.
 *
 * What this owns is the enumeration: the lanes are the pids the pool has been
 * told about and not yet told to drop, which the vitest side cannot use because
 * its workers are a runner's children rather than its own spawns.
 */
export function createPoolPeakRecorder(
  sample: (treeRootPid: number, rootPids: readonly number[]) => Promise<AttributedTreePssKb>
): PoolPeakRecorder {
  const live = new Set<number>();
  const peak = foldTreePeak();
  return {
    enter: (pid) => {
      live.add(pid);
    },
    leave: (pid) => {
      live.delete(pid);
    },
    sample: async (treeRootPid) => {
      // The roots are fixed before the reading is asked for, so the reading and
      // the count of lanes it is taken over describe the same moment — which is
      // what lets the width be read off the sample rather than measured again.
      const charged = [...live];
      return peak.fold(await sample(treeRootPid, charged), charged);
    },
    stop: () => peak.stop(),
  };
}

export interface PoolExecResult {
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

export type PoolChild = Promise<PoolExecResult> & { readonly pid?: number };

/** What a spawned process reports, out of the wider shape execa resolves to. */
interface SpawnedResult {
  readonly exitCode?: number | undefined;
  readonly stdout?: unknown;
  readonly stderr?: unknown;
}

/** A spawned process, seen through only the members the pool reads. */
export interface SpawnedProcess extends PromiseLike<SpawnedResult> {
  readonly pid?: number | undefined;
}

/**
 * The pool's view of a spawned process. Output is carried only where it was
 * captured as text: an inherited stream resolves to no string, and the
 * dry-run pass is the only caller that reads one.
 */
export function toPoolChild(child: SpawnedProcess): PoolChild {
  const settled = settleSpawned(child);
  return child.pid === undefined ? settled : Object.assign(settled, { pid: child.pid });
}

async function settleSpawned(child: SpawnedProcess): Promise<PoolExecResult> {
  const result = await child;
  return {
    ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
    ...(typeof result.stdout === 'string' ? { stdout: result.stdout } : {}),
    ...(typeof result.stderr === 'string' ? { stderr: result.stderr } : {}),
  };
}

export interface PoolExecOptions {
  readonly cwd: string;
  readonly stdio: 'inherit' | 'pipe';
  readonly reject: false;
}

export interface PoolDeps {
  readonly argv: readonly string[];
  readonly repoRoot: string;
  /** Identity of this machine; its recordings are kept apart from any other's. */
  readonly fingerprint: string;
  readonly exec: (file: string, args: readonly string[], options: PoolExecOptions) => PoolChild;
  readonly maxConcurrency: number;
  readonly memoryBudgetKb: number | undefined;
  readonly sampleAttributedPss: (
    treeRootPid: number,
    rootPids: readonly number[]
  ) => Promise<AttributedTreePssKb>;
  /** The pool's own pid: the root of the tree whose peak is measured. */
  readonly selfPid: number;
  readonly now: () => number;
  readonly log: (line: string) => void;
}

/**
 * Tool arguments a task always carries, whatever the caller passed. Their reason,
 * and why the lint entry is shared rather than written here, is in the module it
 * comes from. A reporting run that builds its own task-runner invocation reaches
 * ESLint without them, so its exit code turns on the rules the shared config
 * carries at error severity alone: a warn-level rule reports there and fails
 * nothing.
 */
const TASK_TOOL_DEFAULTS: Readonly<Record<string, readonly string[]>> = {
  lint: LINT_TOOL_ARGS,
};

/** Everything the tool itself receives: the task's own defaults, then the caller's. */
function toolArgs(args: PoolArgs): string[] {
  const forwarded = [...(TASK_TOOL_DEFAULTS[args.task] ?? []), ...args.forwarded];
  return forwarded.length > 0 ? [ARGUMENT_SEPARATOR, ...forwarded] : [];
}

function taskArgs(args: PoolArgs, filter?: string): string[] {
  return [
    args.task,
    ...(filter === undefined ? [] : [`--filter=${filter}`]),
    ...(args.force ? ['--force'] : []),
    ...toolArgs(args),
  ];
}

/**
 * What this run measured, as the one run file it lands: a wall for every task
 * that finished cleanly.
 *
 * Only this run's own rows, because the record is assembled by folding the runs
 * in the store rather than by any run rewriting it.
 */
function measuredLedger(results: readonly PoolResult[], observation: RunObservation): PoolLedger {
  const tasks: Record<string, LedgerEntry> = {};
  for (const result of results) {
    // A task that did not exit cleanly did not measure anything: a wall cut
    // short by a lint error, a crash or a kill is the duration of an abandoned
    // run, not of the work. It never reaches the record, rather than being
    // recorded and recognized later — and nothing is lost by leaving it out,
    // because the build tool caches no failure, so the task runs again and
    // records then.
    if (result.exitCode !== 0) continue;
    tasks[result.package] = { wallsMs: [Math.round(result.wallMs)] };
  }
  return { tasks, runs: [observation] };
}

/** The shape of a finished run, as the next derivation reads it. */
function observe(
  results: readonly PoolResult[],
  concurrency: number,
  makespanMs: number,
  memory: {
    readonly peakRssKb: number | undefined;
    readonly fixedRssKb: number | undefined;
    readonly lanesAtPeak: number | undefined;
  }
): RunObservation {
  const taskCount = results.length;
  let sumWallMs = 0;
  let longestWallMs = 0;
  for (const result of results) {
    sumWallMs += result.wallMs;
    if (result.wallMs > longestWallMs) longestWallMs = result.wallMs;
  }
  return {
    concurrency,
    taskCount,
    sumWallMs: Math.round(sumWallMs),
    longestWallMs: Math.round(longestWallMs),
    makespanMs: Math.round(makespanMs),
    ...(memory.peakRssKb === undefined ? {} : { peakRssKb: Math.round(memory.peakRssKb) }),
    ...(memory.fixedRssKb === undefined ? {} : { fixedRssKb: Math.round(memory.fixedRssKb) }),
    // A peak read with no lane live states no width rather than a zero: it is
    // evidence about no width, and the ladder files it at none.
    ...(memory.lanesAtPeak === undefined || memory.lanesAtPeak < 1
      ? {}
      : { lanesAtPeak: memory.lanesAtPeak }),
  };
}

interface PoolPlan {
  readonly all: ReadonlyMap<string, string>;
  readonly toRun: ReadonlyMap<string, string>;
}

async function planRuns(deps: PoolDeps, args: PoolArgs): Promise<PoolPlan | number> {
  // The tool arguments belong in the plan as well as in the spawns: turbo hashes
  // them, so a plan taken without them reports cache hits for entries a different
  // command produced, and the pool then skips packages the tool never saw under
  // the arguments this run is using.
  const dryRun = await deps.exec('turbo', [args.task, '--dry-run=json', ...toolArgs(args)], {
    cwd: deps.repoRoot,
    stdio: 'pipe',
    reject: false,
  });
  if (dryRun.exitCode !== 0) {
    /* v8 ignore next -- a failed spawn always carries stderr */
    deps.log(dryRun.stderr ?? '');
    /* v8 ignore next -- a failed spawn always carries an exit code */
    return dryRun.exitCode ?? 1;
  }
  /* v8 ignore next -- a successful dry run always has output */
  const all = parseTaskRuns(dryRun.stdout ?? '', deps.repoRoot, args.task, {
    includeCacheHits: true,
  });
  const toRun = args.force
    ? all
    : parseTaskRuns(dryRun.stdout ?? '', deps.repoRoot, args.task, {
        includeCacheHits: false,
      });
  return { all, toRun };
}

/**
 * What the memory record says about the count, for the launch line: the figure
 * the projection priced the count at, which is the figure its budget was
 * compared against. A count a projection admitted and a count nothing examined
 * are different claims, and only the figure makes the first one actionable.
 *
 * Taken off the derivation rather than read back off the ladder here. The
 * projection prices a count between two widths on the line joining them, so
 * there is frequently no width whose own figure this is, and a second reading
 * that went looking for one would name a width that did not supply it. Said as
 * a projection for the same reason: nothing on record need ever have held it.
 */
function memoryBasis(derived: {
  readonly memoryGuarded: boolean;
  readonly projectedPeakKb: number | undefined;
}): string {
  const { projectedPeakKb } = derived;
  if (!derived.memoryGuarded || projectedPeakKb === undefined) return 'memory-unguarded';
  return `checked against a projected ${String(projectedPeakKb)} kB`;
}

export async function poolMain(deps: PoolDeps): Promise<number> {
  const args = parsePoolArgs(deps.argv);
  const { repoRoot } = deps;

  const plan = await planRuns(deps, args);
  if (typeof plan === 'number') return plan;
  const { all, toRun } = plan;

  if (toRun.size === 0) {
    const replay = await deps.exec('turbo', taskArgs(args), {
      cwd: repoRoot,
      stdio: 'inherit',
      reject: false,
    });
    /* v8 ignore next -- a finished spawn always carries an exit code */
    return replay.exitCode ?? 1;
  }

  const store = ledgerPath(repoRoot, deps.fingerprint, args.task);
  // One fold of every run the store retains, on the path to every derived
  // count; what that costs, measured, is stated at {@link readLedger}.
  const ledger = readLedger(store);
  const estimates: PoolTaskEstimate[] = [...toRun.keys()].map((name) => ({
    name,
    wallsMs: ledger.tasks[name]?.wallsMs,
  }));
  const derived = deriveConcurrency({
    tasks: estimates,
    observations: ledger.runs,
    maxConcurrency: deps.maxConcurrency,
    memoryBudgetKb: deps.memoryBudgetKb,
  });
  deps.log(
    `[turbo-pool] ${args.task}: ${String(toRun.size)} of ${String(all.size)} executing ` +
      `(${String(all.size - toRun.size)} cached), concurrency ${String(derived.concurrency)} ` +
      `(${derivationBasis(derived)}, ${memoryBasis(derived)})`
  );

  const ordered: PoolEntry[] = scheduleOrder(estimates).map((name) => ({
    package: name,
    /* v8 ignore next -- the names come from the map being read */
    dir: toRun.get(name) ?? '',
  }));

  const recorder = createPoolPeakRecorder(deps.sampleAttributedPss);
  const sampler = sampleOnInterval(() => recorder.sample(deps.selfPid), PSS_SAMPLE_INTERVAL_MS);
  const startedAt = deps.now();
  const results = await runPool(
    ordered,
    derived.concurrency,
    async (entry) => {
      const child = deps.exec('turbo', taskArgs(args, entry.package), {
        cwd: repoRoot,
        stdio: 'inherit',
        reject: false,
      });
      // Registered before the first await: a sample that reads this tree's bytes must also count
      // it as a live lane. Unregistered, the bytes reach the peak through the remainder while the
      // width stays a lane short, filing a heavy peak at a narrower rung than the lanes it took.
      const { pid } = child;
      if (pid !== undefined) recorder.enter(pid);
      try {
        const result = await child;
        return { exitCode: result.exitCode };
      } finally {
        if (pid !== undefined) recorder.leave(pid);
      }
    },
    deps.now
  );
  const makespanMs = deps.now() - startedAt;
  sampler.stop();
  // One answer for the peak, the width and the baseline, closed at the moment
  // the loop above was: a reading still outstanding at the stop lands in
  // neither, so nothing here can pair a width from one sample with a peak from
  // another.
  const peaks = recorder.stop();

  const observation = observe(results, derived.concurrency, makespanMs, {
    peakRssKb: peaks.peakKb,
    fixedRssKb: peaks.fixedKb,
    lanesAtPeak: peaks.lanesAtPeak,
  });
  // The unfiltered dry run enumerates every package this task has, cache hits
  // included, so a recorded unit absent from it is one the workspace no longer
  // declares and retention has no reason to keep a run file carrying it.
  if (args.record) {
    writeLedger(store, measuredLedger(results, observation), (unit) => all.has(unit));
  }

  const failed = results.filter((result) => result.exitCode !== 0);
  const slowest = [...results].toSorted((a, b) => b.wallMs - a.wallMs)[0];
  deps.log(
    `[turbo-pool] ${args.task}: ${String(results.length - failed.length)} passed, ` +
      `${String(failed.length)} failed` +
      /* v8 ignore start -- a run with tasks always has a slowest one */
      (slowest
        ? `, slowest ${slowest.package} at ${String(Math.round(slowest.wallMs / 1000))}s`
        : '')
  );
  /* v8 ignore stop */
  for (const failure of failed) deps.log(`[turbo-pool] failed: ${failure.package}`);
  return failed.length > 0 ? 1 : 0;
}

/* v8 ignore start -- CLI entry point, exercised by the pnpm scripts that call it */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    return asElectedCacheWriter({ rootDir: path.dirname(scriptDir), command: 'turbo-pool' }, () =>
      poolMain({
        argv: process.argv.slice(2),
        repoRoot: path.dirname(scriptDir),
        fingerprint: machineFingerprint(),
        exec: (file, execArgs, options) =>
          toPoolChild(execa(file, [...execArgs], options as ExecaOptions)),
        maxConcurrency: performanceCoreCount(),
        memoryBudgetKb: memoryBudgetKb(PLANNING_MEMORY_FRACTION),
        sampleAttributedPss: sampleAttributedTreePssKb,
        selfPid: process.pid,
        now: () => performance.now(),
        log: (line) => {
          console.log(line);
        },
      })
    );
  });
}
/* v8 ignore stop */
