import { existsSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import path from 'node:path';

import type { LedgerEntry } from '../pool/ledger.js';
import type { AttributedTreePssKb } from '../pool/memory.js';
import type { TreePeak } from '../pool/tree-peak.js';
import type { ConcurrencyBound, PoolTaskEstimate, RunObservation } from '../pool/schedule.js';
import type { VitestJsonReport } from '../test-run/test-report.js';

// Explicit-URL runtime import: wherever this module is loaded by Node's own
// loader rather than through a transform that rewrites specifiers, a `.js`
// specifier resolves literally and finds no such file next to
// `../pool/ledger.ts` — the same constraint
// `scripts/lib/test-run/test-packages.ts` documents.
const { ledgerPath, readLedger, writeLedger } = (await import(
  new URL('../pool/ledger.ts', import.meta.url).href
)) as typeof import('../pool/ledger.js');
const { PLANNING_MEMORY_FRACTION, memoryBudgetKb, readProcStatRecords, sampleAttributedTreePssKb } =
  (await import(
    new URL('../pool/memory.ts', import.meta.url).href
  )) as typeof import('../pool/memory.js');
const { describeDerivationBound, deriveConcurrency, unknownTaskSet } = (await import(
  new URL('../pool/schedule.ts', import.meta.url).href
)) as typeof import('../pool/schedule.js');
const { sampleOnInterval } = (await import(
  new URL('../pool/interval-sampler.ts', import.meta.url).href
)) as typeof import('../pool/interval-sampler.js');
const { foldTreePeak } = (await import(
  new URL('../pool/tree-peak.ts', import.meta.url).href
)) as typeof import('../pool/tree-peak.js');
const { PARENT_FIELD, STATE_FIELD, parseProcStatRecord } = (await import(
  new URL('../proc-stat.ts', import.meta.url).href
)) as typeof import('../proc-stat.js');
const { sumFileWallMs } = (await import(
  new URL('../test-run/test-report.ts', import.meta.url).href
)) as typeof import('../test-run/test-report.js');

/**
 * The vitest worker count. Every consumer that declares a worker ceiling takes
 * it from {@link deriveVitestWorkers} rather than spelling one, so the count is
 * no single run's: which configuration a run resolves against decides which
 * declaration it reads, and `packages/config/vitest.config.ts` states that
 * derivation.
 *
 * The rule the count comes out of is not spelled here. It is
 * {@link deriveConcurrency}, the same function the turbo task pool derives lint
 * and typecheck from, and this module's whole job is to hand it the right
 * units: for vitest a unit is one test file, because a fork holds a file and
 * not a package. A second spelling of the rule — a ceiling, a work bound or a
 * memory descent written again here — would be a copy that has to agree with
 * that one to be correct, which `docs/CODE-RULES.md` §One Implementation,
 * Shared forbids.
 *
 * What the units carry is the walls the ledger retains for the file, and
 * nothing else. A unit no longer carries a memory charge of its own, because
 * nothing composes one: the memory bound reads whole runs, filed by the lanes
 * that were live when each held its peak, and what this module records for that
 * bound is one row per run rather than a charge per file.
 *
 * A machine whose ledger names no file has no unit set to bound: nothing has
 * measured its files, and the ruling for that run is that it opens
 * `min(cpuCount, unitCount)` with no memory term and reports itself underived.
 * It reaches that answer through the same function, over a stand-in set of
 * never-measured units one per lane, rather than through a second path that
 * returns a number no derivation produced.
 */

export const VITEST_LEDGER_TASK = 'vitest';

/**
 * What kind of vitest invocation a row was measured by. Every one of them
 * records into {@link VITEST_LEDGER_TASK}, so this is what tells them apart
 * once they are there.
 *
 * A single-file run and a whole-repository batch are not comparable workloads
 * and do not arrive at comparable rates — a developer runs the first many times
 * a day — which is why they once needed a store each. The ledger's retention
 * keeps a width while it is among the newest runs **of its own shape**, so a
 * day of one-file runs can no longer expire a batch's widths, and one store
 * serves every invocation.
 *
 * `package` is spelled to match the shape the ledger files the superseded
 * package-rooted store's rows under, so a package-rooted run's history reaches
 * back past the fold rather than starting again beside it.
 */
export type VitestRunShape = 'batch' | 'package' | 'watch';

/** A worker count and everything a reader needs to judge what it rests on. */
export interface VitestWorkerDerivation {
  readonly workers: number;
  /** `cold-start` is the run nothing on record bounded; `derived` the run recorded walls did. */
  readonly state: 'cold-start' | 'derived';
  /** The limit the count came out of, which is what every reader prints a word for. */
  readonly bound: ConcurrencyBound;
  /** True where the memory projection, rather than the work shape, set the count. */
  readonly memoryCapped: boolean;
  /**
   * True where the count was actually checked against a projection. False is
   * the unguarded run — no budget was named, or no recorded run carries a peak
   * filed at a width to project from — and it is the difference between a count
   * memory admitted and a count nothing examined.
   */
  readonly memoryGuarded: boolean;
  /** Test files the count was derived over; zero where nothing named one. */
  readonly units: number;
}

interface DeriveVitestWorkersOptions {
  /** The hardware ceiling, e.g. `os.availableParallelism()`. */
  readonly maxParallelism: number;
  /** The test files this run will execute, carrying whatever the ledger records for each. */
  readonly files?: readonly PoolTaskEstimate[] | undefined;
  /**
   * Completed runs, oldest first. The projection is a ladder over what widths
   * have really held, so these are what the memory bound is made of; a set
   * carrying none leaves the count unguarded.
   */
  readonly observations?: readonly RunObservation[] | undefined;
  /** Memory the run's projected peak must fit into; omit to skip the projection. */
  readonly memoryBudgetKb?: number | undefined;
}

export function deriveVitestWorkers(options: DeriveVitestWorkersOptions): VitestWorkerDerivation {
  const { maxParallelism, files, observations = [], memoryBudgetKb } = options;
  const units = files ?? [];
  const derived = deriveConcurrency({
    tasks: units.length === 0 ? unknownTaskSet(maxParallelism) : units,
    observations,
    maxConcurrency: maxParallelism,
    memoryBudgetKb,
  });
  return {
    workers: derived.concurrency,
    state: derived.state,
    bound: derived.bound,
    memoryCapped: derived.memoryCapped,
    memoryGuarded: derived.memoryGuarded,
    units: units.length,
  };
}

/**
 * Whether a unit of this ledger is still in the tree. Its units are test files,
 * so the tree answers directly — which is also what disposes of the keys the
 * ledger carried before the file became the unit, since a package name resolves
 * to no file.
 *
 * The derivation and the store's retention ask the same question through this
 * one function rather than each spelling it: a row the derivation skips is one
 * whose run file retention has no reason to keep alive, and the two asking
 * differently is the drift that keeps carriers nothing ever reads.
 */
function testFileInTree(repoRoot: string, unit: string): boolean {
  return existsSync(path.resolve(repoRoot, unit));
}

/**
 * The units a run derives its worker count over: the ledger's row for every test
 * file under a directory the run covers.
 *
 * Scoped to the run's own directories rather than taken whole, for the reason
 * {@link deriveConcurrency}'s own module gives: a run over one cache-missed
 * package and a run over every package are answering different questions, and
 * the walls the work bound schedules have to be the walls of the set that is
 * about to run.
 */
export function vitestFileUnits(
  repoRoot: string,
  rows: Readonly<Record<string, LedgerEntry>>,
  directories: readonly string[]
): PoolTaskEstimate[] {
  // Both ends resolved, so the comparison is between two spellings the platform
  // agrees on: a root handed over with a trailing separator would otherwise
  // match no key at all, and every row would be dropped on every run — a cold
  // start that repeats forever and reports itself as nothing.
  const roots = directories.map((directory) => path.resolve(repoRoot, directory));
  const units: PoolTaskEstimate[] = [];
  for (const [file, entry] of Object.entries(rows)) {
    const resolved = path.resolve(repoRoot, file);
    if (!roots.some((root) => resolved.startsWith(root + path.sep))) continue;
    // Liveness is derived from the tree at each use rather than remembered by
    // pruning what is stored, because retention keeps whole run files and a
    // kept one carries the rows of every unit it measured: a file set that
    // churns leaves rows for files that no longer exist, and a row nothing can
    // name again is one nothing will ever read.
    if (!testFileInTree(repoRoot, file)) continue;
    units.push({ name: file, wallsMs: entry.wallsMs });
  }
  return units;
}

/** A repository-wide count, with the two inputs a reader of that count also answers for. */
interface RepositoryVitestWorkers {
  readonly derivation: VitestWorkerDerivation;
  /** The completed runs the count was taken over, oldest first. */
  readonly observations: readonly RunObservation[];
  /** The memory its projection was held to; undefined where none could be read. */
  readonly memoryBudgetKb: number | undefined;
}

/**
 * The worker count for a run whose units are the whole repository's recorded
 * test files: the shared vitest configuration's own declaration, the figure a
 * launcher writes on the runner's command line before a runner exists to read
 * that declaration, and the figure `scripts/concurrency.ts` reports as the one
 * the next such run will open.
 *
 * One home for all four arguments, because a command-line count replaces the
 * configuration's own and nothing clamps it afterwards: narrower than the
 * machine was measured for is a slower green run, while wider opens lanes the
 * memory ladder inside {@link deriveVitestWorkers} never admitted, which can
 * exhaust the machine rather than merely slow it. Two argument lists that read
 * alike settle nothing there, because each argument is itself derived and the
 * derivations are what may differ.
 *
 * The unit set is every test file on record rather than the set about to run,
 * because the configuration's declaration is resolved before any runner
 * argument is read. Scoping the units to the package about to run is the
 * tempting variant and it is a slowdown: the work bound prices recorded test
 * walls and nothing per lane, so a package whose work is spread over many short
 * files resolves to very few lanes and takes longer than the same package left
 * to this answer. A launcher that genuinely knows a narrower set derives over it
 * through {@link deriveVitestWorkers} directly.
 *
 * The machine key is a parameter while the memory budget is not, and the
 * asymmetry is a load-graph cost rather than a preference: `../pool/memory.ts`
 * is already a dependency of this module and `../pool/machine.ts` is not, so
 * reaching for the key here would add that module to the graph of the shared
 * vitest configuration — a file every vitest run in this repository loads.
 */
export function deriveRepositoryVitestWorkers(
  repoRoot: string,
  fingerprint: string
): RepositoryVitestWorkers {
  const recorded = readLedger(ledgerPath(repoRoot, fingerprint, VITEST_LEDGER_TASK));
  const budgetKb = memoryBudgetKb(PLANNING_MEMORY_FRACTION);
  return {
    derivation: deriveVitestWorkers({
      maxParallelism: availableParallelism(),
      files: vitestFileUnits(repoRoot, recorded.tasks, [repoRoot]),
      observations: recorded.runs,
      memoryBudgetKb: budgetKb,
    }),
    observations: recorded.runs,
    memoryBudgetKb: budgetKb,
  };
}

/**
 * A process that has exited and is waiting to be collected. It still has a
 * parent and still appears in the table, but it holds no resident memory to
 * attribute, so it is not one of the workers a reading is split across.
 */
const EXITED_STATE = 'Z';

/**
 * The live children one reading of the process table parents to `parentPid`,
 * taken from the raw records so liveness is read from the same field the
 * kernel states it in.
 */
export function liveChildPids(statRecords: readonly string[], parentPid: number): number[] {
  const children: number[] = [];
  for (const content of statRecords) {
    const record = parseProcStatRecord(content);
    if (record === undefined) continue;
    if (record.fields[STATE_FIELD] === EXITED_STATE) continue;
    if (Number.parseInt(record.fields[PARENT_FIELD] ?? '', 10) !== parentPid) continue;
    const pid = Number.parseInt(record.pid, 10);
    if (Number.isInteger(pid)) children.push(pid);
  }
  return children;
}

/**
 * The runner's live children, read from this machine's own process table.
 *
 * The enumeration this feeds is what separates the workers' subtrees from the
 * rest of the run's tree, so it has to come from the machine rather than from
 * what a sampler managed to read: a root whose rollup could not be taken is
 * absent from a reading, which is the same shape as a root that was never
 * there.
 *
 * Empty where the table cannot be read at all, which is every platform without
 * a `/proc`. A run there records no split, exactly as it records no peak.
 */
export function readDirectChildPids(parentPid: number): number[] {
  const records = readProcStatRecords();
  /* v8 ignore next -- /proc is absent only where no reading of any kind is taken */
  if (records === undefined) return [];
  return liveChildPids(records, parentPid);
}

/**
 * The kernel counter a run is judged against, as `/proc/vmstat` states it.
 *
 * **It is a total since boot and it is the machine's, not a run's**, so a single
 * reading says nothing about a run, and a difference across a run's span says
 * only what happened on the machine while it ran — every other process on it
 * moves the counter too. So a difference bounds a run in one direction only, the
 * one where it is zero: nothing was killed for memory anywhere, so no worker
 * was.
 *
 * Swap is not among the counters read. The series this belongs to optimizes
 * against available memory and the run's own usage, and nothing records, folds
 * or reasons about what a machine paged out.
 */
export interface MachineMemoryEvents {
  /** `oom_kill`: processes the kernel has killed for memory; absent where unreadable. */
  readonly oomKills: number | undefined;
}

export function parseMachineMemoryEvents(vmstat: string): MachineMemoryEvents {
  return { oomKills: vmstatCounter(vmstat, 'oom_kill') };
}

/** One `/proc/vmstat` counter, absent where this kernel does not report it. */
function vmstatCounter(vmstat: string, name: string): number | undefined {
  const match = new RegExp(String.raw`^${name} (\d+)$`, 'm').exec(vmstat);
  if (match === null) return undefined;
  /* v8 ignore next -- the regex matched, so its group is present */
  return Number.parseInt(match[1] ?? '', 10);
}

/** The counter as this machine states it now; absent where there is no `/proc`. */
export function readMachineMemoryEvents(): MachineMemoryEvents {
  try {
    return parseMachineMemoryEvents(readFileSync('/proc/vmstat', 'utf8'));
  } catch {
    /* v8 ignore next -- no /proc/vmstat, which is every platform without one */
    return { oomKills: undefined };
  }
}

/**
 * What a run observed about the constraints it is judged against, each figure
 * at the scope it can honestly claim and no wider.
 */
export interface RunConstraintObservation {
  /** {@link MachineMemoryEvents.oomKills} across the run's span — machine scope. */
  readonly machineOomKills: number | undefined;
}

/** The difference two counter readings bound, or nothing where either end is missing. */
function counterDuring(before: number | undefined, after: number | undefined): number | undefined {
  if (before === undefined || after === undefined) return undefined;
  return after - before;
}

export function observeRunConstraints(
  before: MachineMemoryEvents,
  after: MachineMemoryEvents
): RunConstraintObservation {
  return { machineOomKills: counterDuring(before.oomKills, after.oomKills) };
}

/** What one run's samples established about the memory it held outside its workers. */
export interface RunMemorySplit {
  /** The peak of everything under the run that is not a worker's subtree. */
  readonly fixedRssKb: number | undefined;
}

/** Where a recorder gets its readings: who the workers are and what they cost. */
export interface RunSplitDeps {
  readonly listWorkers: (runnerPid: number) => readonly number[];
  readonly sample: (
    treeRootPid: number,
    rootPids: readonly number[]
  ) => Promise<AttributedTreePssKb>;
}

export interface RunSplitRecorder {
  /**
   * Take one sample and fold it in, returning the tree's total for that same
   * sample — the shape a peak tracker drives, so the split and the whole-tree
   * peak come from one series of readings rather than two.
   */
  readonly sample: (treeRootPid: number) => Promise<number | undefined>;
  /** Stop folding and report what the samples reached. */
  readonly stop: () => TreePeak;
  /** {@link TrackedRunSplit.peakRunnerChildren} as the samples so far have it. */
  readonly peakRunnerChildren: () => number;
}

const MACHINE_SPLIT_DEPS: RunSplitDeps = {
  listWorkers: readDirectChildPids,
  sample: sampleAttributedTreePssKb,
};

/**
 * Reads the tree over the runner's own children, and folds every reading
 * through {@link foldTreePeak} — the same fold `scripts/turbo-pool.ts` records
 * its runs with, so a row filed there and a row filed here mean one thing.
 *
 * What this owns is the enumeration: the workers are the runner's direct
 * children, read from the machine at every sample, because that enumeration is
 * what separates their subtrees from the remainder and it is not knowable any
 * other way — a run's workers are forks this process never spawned.
 *
 * The count of them is kept as the run's own shape, which is this side's alone:
 * the pool has no runner to count the children of.
 */
export function createRunSplitRecorder(
  runnerPid: number | undefined,
  deps: RunSplitDeps = MACHINE_SPLIT_DEPS
): RunSplitRecorder {
  const peak = foldTreePeak();
  let peakRunnerChildren = 0;
  return {
    sample: async (treeRootPid) => {
      // A runner that never started parents nothing, and asking the machine for
      // the children of a process id it does not have answers with another
      // process's — the children of process id zero being process id one. So
      // the absence charges nothing as a worker rather than being enumerated.
      const workers = runnerPid === undefined ? [] : deps.listWorkers(runnerPid);
      peakRunnerChildren = Math.max(peakRunnerChildren, workers.length);
      return peak.fold(await deps.sample(treeRootPid, workers), workers);
    },
    stop: () => peak.stop(),
    peakRunnerChildren: () => peakRunnerChildren,
  };
}

/** What a run's sampling reached: its whole-tree peak and how that peak divided. */
export interface TrackedRunSplit {
  readonly peakRssKb: number | undefined;
  readonly split: RunMemorySplit;
  /**
   * The most direct children the runner was ever seen holding — the run's own
   * process shape, from the same enumeration the split is taken against.
   *
   * Zero is silence rather than a reading: a machine with no process table
   * states no child at any sample, exactly as it states no memory figure.
   */
  readonly peakRunnerChildren: number;
  /**
   * Workers live at the reading {@link TrackedRunSplit.peakRssKb} came out of,
   * which is the width that peak is evidence about and the width the ledger
   * files the row at. Not the widest the run was ever seen at: that is a
   * maximum across readings taken at different moments, and it would file a
   * dear reading under a width that was never holding it.
   *
   * Undefined where no reading answered with a total at all — the same silence
   * as an unread peak, and for the same reason.
   */
  readonly lanesAtPeak: number | undefined;
}

export interface RunSplitTracker {
  /** Stop sampling and report what was read. */
  readonly stop: () => TrackedRunSplit;
}

interface TrackRunSplitOptions {
  /** The tree to measure: the process everything the run spawned descends from. */
  readonly treeRootPid: number;
  /**
   * The process whose direct children are the run's workers; undefined where
   * the runner never started, which charges nothing as a worker.
   */
  readonly runnerPid: number | undefined;
  readonly intervalMs: number;
}

/**
 * Sample a run's tree on an interval, folding each reading into the split and
 * keeping the largest whole tree any one reading added up to.
 *
 * The enumeration is this module's; the loop around it is
 * {@link sampleOnInterval}'s, which is also what the turbo pool drives its own
 * sampling with, and the fold beneath both is {@link foldTreePeak}. Closing the
 * fold is what ties the peak to the width: one answer taken at one moment,
 * rather than two figures read a microtask apart that a reading landing between
 * them can pull in different directions.
 */
export function trackRunSplit(
  options: TrackRunSplitOptions,
  deps: RunSplitDeps = MACHINE_SPLIT_DEPS
): RunSplitTracker {
  const recorder = createRunSplitRecorder(options.runnerPid, deps);
  const sampler = sampleOnInterval(() => recorder.sample(options.treeRootPid), options.intervalMs);
  return {
    stop: () => {
      sampler.stop();
      const { peakKb, lanesAtPeak, fixedKb } = recorder.stop();
      return {
        peakRssKb: peakKb,
        split: { fixedRssKb: fixedKb },
        peakRunnerChildren: recorder.peakRunnerChildren(),
        lanesAtPeak,
      };
    },
  };
}

/** What a run has to say about its own shape before it can be judged. */
interface RunShape {
  /** The count the run was launched at and held for its whole span. */
  readonly declaredWorkers: number;
  /** Test files the run collected. */
  readonly fileCount: number;
  /** {@link TrackedRunSplit.peakRunnerChildren}; absent where nothing observed it. */
  readonly peakRunnerChildren?: number | undefined;
}

/**
 * How the run's declared shape contradicts the work it did, or undefined where
 * it does not.
 *
 * The count a run is judged against is the one it declared at launch and held,
 * never one observed while it ran: a count taken by watching which forks
 * survive two consecutive samples misses every file shorter than the sampling
 * interval, so it names a pool narrower than the one that ran. A run that
 * collected files while declaring no worker to run them on has no shape any
 * row can describe, so it records nothing and says why — wrong by absence
 * rather than wrong by silence.
 */
export function shapeFault(shape: RunShape): string | undefined {
  const { declaredWorkers, fileCount, peakRunnerChildren } = shape;
  if (fileCount > 0 && declaredWorkers <= 0) {
    return `the run declared ${String(declaredWorkers)} worker(s) for ${String(fileCount)} files`;
  }
  // The split this module records rests on one unstated fact: the processes a
  // run's memory is charged to as workers are the runner's own direct children.
  // A helper or an intermediate spawned between the runner and its forks leaves
  // the runner holding a single child whose subtree then swallows every worker,
  // so the fixed cost collapses and the row misdirects the next run's
  // projection.
  //
  // One child is that layout and no other, but only for a run that had more
  // files than lanes: such a run had to fill every lane it declared, so one
  // child cannot be the work running out. A run with lanes to spare may
  // genuinely hold one fork, a run that declared one worker holds one
  // legitimately, and a machine with no process table states none at all —
  // which is why zero is silence here rather than a fault. Judged on the batch
  // that saturates, which is also the run whose misattributed fixed cost the
  // next derivation would read.
  if (declaredWorkers > 1 && fileCount > declaredWorkers && peakRunnerChildren === 1) {
    return (
      `the runner was never seen holding more than one direct child while running ` +
      `${String(fileCount)} files at ${String(declaredWorkers)} workers, so its workers are no ` +
      `longer its own children and the memory split names the wrong processes`
    );
  }
  return undefined;
}

/**
 * One test file as one run measured it: the key its ledger row is written
 * under, and the wall the run weighed it at.
 *
 * The file is the unit a worker count is derived over, because a vitest worker
 * holds a file and not a package, so the row is keyed on the file's path within
 * the repository.
 */
export interface TestFileMeasurement {
  /** The test file, relative to the repository root, spelled with `/` on every platform. */
  readonly file: string;
  readonly wallMs: number;
}

/**
 * The ledger key for a test file: its path within the repository, separators
 * normalised, so a row written on one platform names the same file on another.
 */
export function repoRelativeTestFile(repoRoot: string, testFile: string): string {
  return path.relative(repoRoot, testFile).split(path.sep).join('/');
}

type TestResultEntry = NonNullable<VitestJsonReport['testResults']>[number];

/** The report's entries under the file each belongs to; a file its run collected under two projects has two. */
function entriesByFile(report: VitestJsonReport): Map<string, TestResultEntry[]> {
  const entries = new Map<string, TestResultEntry[]>();
  for (const entry of report.testResults ?? []) {
    const { name } = entry;
    if (name === undefined) continue;
    const forFile = entries.get(name);
    if (forFile === undefined) entries.set(name, [entry]);
    else forFile.push(entry);
  }
  return entries;
}

/**
 * What one run measured file by file: every file its report could weigh.
 *
 * The run's own file set is the whole admission rule, and that is what keeps a
 * nested runner out of the ledger — a file this run did not collect is not in
 * the report it is reading, so it reaches no row.
 *
 * A file's wall is the run-wide reducer applied to that file's own entries
 * rather than a second sum spelled here, so the walls these rows carry and the
 * run-wide total on the run's row are one figure over one population.
 */
export function measureTestFiles(
  repoRoot: string,
  report: VitestJsonReport | undefined
): readonly TestFileMeasurement[] {
  if (report === undefined) return [];
  const measured: TestFileMeasurement[] = [];
  for (const [name, entries] of entriesByFile(report)) {
    const wallMs = sumFileWallMs({ testResults: entries });
    if (wallMs === undefined) continue;
    measured.push({ file: repoRelativeTestFile(repoRoot, name), wallMs });
  }
  return measured;
}

export interface VitestRunRecord {
  readonly wallMs: number;
  /** The whole tree's peak; the split below is of the same series of readings. */
  readonly peakRssKb: number | undefined;
  readonly split: RunMemorySplit;
  /**
   * The process whose direct children were charged as workers; undefined where
   * the runner never started, which is a defect rather than a measurement.
   */
  readonly runnerPid: number | undefined;
  /**
   * The `--maxWorkers` the run was launched under, which is the run's worker
   * count: it is set once at launch and held, so every figure that names a
   * count of workers on this row is this one.
   */
  readonly declaredWorkers: number;
  /** Test files the run collected. */
  readonly fileCount: number;
  /**
   * {@link TrackedRunSplit.peakRunnerChildren}. Optional because not every
   * launcher observes the shape, and for one that does not the default states
   * the truth: nothing counted the runner's children.
   */
  readonly peakRunnerChildren?: number | undefined;
  /**
   * {@link TrackedRunSplit.lanesAtPeak} — the width the ladder files this row
   * at. Absent where nothing counted them, which leaves the ledger to
   * approximate the width from the row's own lanes and units.
   */
  readonly lanesAtPeak: number | undefined;
  /**
   * What kind of invocation this was. One store holds every vitest run, so the
   * stamp is what keeps a batch's history and a one-file run's from expiring
   * each other: retention counts a width's age in runs of its own shape.
   */
  readonly shape: VitestRunShape;
  /** Packages the batch covered — what makes one row comparable with another. */
  readonly packageCount: number;
  /**
   * The mean wall of the files the run covered, from the reporter's own
   * timestamps; undefined where no file could be weighed. Recorded, not
   * interpreted: it weighs the workload, and whether a memory bound follows
   * from it is a question for whatever reads the row.
   */
  readonly perFileWallMs: number | undefined;
  /**
   * The summed wall of the files the run could weigh, from the same reduction;
   * undefined where none could be. Carried rather than derived from the weight
   * and a count, which count different populations.
   */
  readonly sumFileWallMs: number | undefined;
}

/** The row's keys that hold a figure, which is every one of them but the shape. */
type RunFigureKey = {
  [K in keyof RunObservation]-?: NonNullable<RunObservation[K]> extends number ? K : never;
}[keyof RunObservation];

/**
 * The row one measured run becomes. Every figure the run may not have read is
 * absent rather than zero, because a figure at zero reads as a run that
 * measured nothing — the one thing none of them may be confused with.
 *
 * Called only past {@link recordVitestRun}'s guards, which is what makes the
 * peak unconditional here.
 */
function measuredRow(record: VitestRunRecord, peakRssKb: number): RunObservation {
  const { split } = record;
  // Assigned onto a typed object rather than spread in conditionally, because
  // that is the only form in which a misspelled figure name fails to compile: a
  // spread of `cond ? {} : { typo: n }` satisfies the row type, and the figure
  // then lands under a name the reader drops — this family's whole trap, driven
  // from the producer's side rather than the validator's.
  const figures: Partial<Record<RunFigureKey, number>> = {};
  if (split.fixedRssKb !== undefined) figures.fixedRssKb = Math.round(split.fixedRssKb);
  if (record.fileCount > 0) figures.fileCount = record.fileCount;
  if (record.perFileWallMs !== undefined) figures.perFileWallMs = Math.round(record.perFileWallMs);
  if (record.sumFileWallMs !== undefined) figures.sumFileWallMs = Math.round(record.sumFileWallMs);
  // A peak no worker was live for says nothing about a width, so the row states
  // no width and the ledger approximates one from the lanes and units the row
  // does carry.
  if (record.lanesAtPeak !== undefined && record.lanesAtPeak > 0) {
    figures.lanesAtPeak = record.lanesAtPeak;
  }
  return {
    shape: record.shape,
    // The count the run declared at launch and held for its whole span, which
    // is what every other row on this ledger puts here. What the run was
    // actually holding when it peaked is the lane count beside it.
    concurrency: record.declaredWorkers,
    taskCount: record.packageCount,
    sumWallMs: Math.round(record.wallMs),
    longestWallMs: Math.round(record.wallMs),
    makespanMs: Math.round(record.wallMs),
    peakRssKb: Math.round(peakRssKb),
    ...figures,
  };
}

/**
 * The rows this run measured, keyed by file.
 *
 * Only this run's own walls, because the record is assembled by folding the
 * runs in the store rather than by any run rewriting it: a file this run did
 * not weigh keeps the walls earlier runs weighed it at, which the fold does on
 * its own.
 */
function measuredFileRows(files: readonly TestFileMeasurement[]): Record<string, LedgerEntry> {
  const rows: Record<string, LedgerEntry> = {};
  for (const { file, wallMs } of files) {
    rows[file] = { wallsMs: [...(rows[file]?.wallsMs ?? []), Math.round(wallMs)] };
  }
  return rows;
}

/**
 * Append what one vitest run measured, or refuse and say why.
 *
 * A row is a measurement of a workload, so it carries the workload it measured:
 * the packages it covered and the files it collected. Neither decides which
 * counts the row prices — the lanes live at its peak do — so they are carried
 * for the report rather than compared with anything.
 *
 * Every invocation records here, under its own {@link VitestRunShape}, and no
 * caller names a store: one system measures every vitest run, and a shape is a
 * stamp on a row rather than a history of its own.
 *
 * The file rows go in beside the run's row, under the same guards: a run
 * refused its own row measured nothing worth keying to a file either.
 */
export function recordVitestRun(
  repoRoot: string,
  fingerprint: string,
  record: VitestRunRecord,
  files: readonly TestFileMeasurement[] = []
): VitestRunDisposition {
  // First, because this run measured nothing and reads as though it had: the
  // sampler charges the untouched tree to the fixed cost, and the row lands
  // claiming the whole machine as a fixed cost the next run reads back.
  if (record.runnerPid === undefined) {
    return refused('the test runner never started, so this run measured nothing');
  }
  // Nothing read at all — every platform without proportional accounting, and a
  // tree that vanished under the sampler — is not a complaint about the run's
  // shape: there is no reading to draw any conclusion from.
  if (record.peakRssKb === undefined) return refused("nothing in the run's tree could be read");
  if (record.packageCount <= 0) return refused('the batch covered no package');
  const fault = shapeFault({
    declaredWorkers: record.declaredWorkers,
    fileCount: record.fileCount,
    peakRunnerChildren: record.peakRunnerChildren,
  });
  if (fault !== undefined) return refused(fault);
  // Past the guard above, a run declaring no worker collected no file either,
  // so there is no pool to describe and nothing to say about one.
  if (record.declaredWorkers <= 0) {
    return refused('the run declared no worker and collected no file');
  }
  writeLedger(
    ledgerPath(repoRoot, fingerprint, VITEST_LEDGER_TASK),
    {
      tasks: measuredFileRows(files),
      runs: [measuredRow(record, record.peakRssKb)],
    },
    (unit) => testFileInTree(repoRoot, unit)
  );
  return { kind: 'recorded' };
}

/**
 * Whether a run's row reached the ledger, and what stopped it where it did not.
 *
 * Returned rather than warned so that every path out of the recorder is visible
 * the same way: two of them used to leave no trace at all, which made a run that
 * recorded nothing indistinguishable from one that was never asked to.
 */
export type VitestRunDisposition =
  | { readonly kind: 'recorded' }
  | { readonly kind: 'refused'; readonly reason: string };

function refused(reason: string): VitestRunDisposition {
  return { kind: 'refused', reason };
}

export interface VitestRunReportInput {
  /** The count the run was launched at, and why nothing bounded it. */
  readonly derivation: VitestWorkerDerivation;
  readonly split: RunMemorySplit;
  readonly constraints: RunConstraintObservation;
  readonly disposition: VitestRunDisposition;
}

/** How the count was reached, in the one clause every reader of a count needs. */
export function describeVitestDerivation(derivation: VitestWorkerDerivation): string {
  const { workers, memoryGuarded, units } = derivation;
  const qualifiers = [
    describeDerivationBound(derivation),
    ...(memoryGuarded ? [] : ['memory-unguarded']),
  ].join(', ');
  return `${String(workers)} (${qualifiers}) over ${String(units)} test file(s) as units`;
}

/** A figure, or the statement that it was not read — never a stand-in zero. */
function figure(value: number | undefined, unit: string): string {
  if (value === undefined) return 'not measured';
  return `${String(value)} ${unit}`;
}

/**
 * What one run observed, in the form a reader has after the fact.
 *
 * Every line states the scope its figure is true at, because the two scopes
 * available here are not interchangeable and a reader who conflates them draws
 * a conclusion about a run from a counter the whole machine moves.
 */
export function formatVitestRunReport(input: VitestRunReportInput): string {
  const { derivation, split, constraints, disposition } = input;
  const lines = [
    `workers: ${describeVitestDerivation(derivation)}; declared at launch and held for the run`,
    `memory: fixed ${figure(split.fixedRssKb, 'kB')} — nothing here is charged per worker`,
    `killed for memory, anywhere on this machine while the run ran: ${figure(constraints.machineOomKills, 'processes')} — machine scope, and it attributes no process death to this run: a worker's exit status belongs to the runner, not to this process. At zero no worker was killed for memory; above zero it says nothing about this run`,
    disposition.kind === 'recorded'
      ? 'ledger row: recorded'
      : `ledger row: refused — ${disposition.reason}`,
  ];
  return lines.map((line) => `[vitest-run] ${line}`).join('\n');
}
