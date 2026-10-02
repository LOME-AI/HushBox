import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';
import { parseCLI } from 'vitest/node';

import { currentRunId, readOwnership, recordOwnedResource } from './lib/claims/ownership.js';
import { isMainModule } from './lib/cli/is-main.js';
import { runMain } from './lib/cli/run-main.js';
import { ARGUMENT_SEPARATOR } from './lib/cli/argument-separator.js';
import { withRunnerCacheClaim } from './lib/vitest/cache-sweep.js';
import { COVERAGE_DIRECTORY_NAME } from './lib/vitest/coverage-directory.js';
import { REPORT_ENV } from './lib/vitest/coverage-offset-reporter.js';
import { claimReportFile, dropReportFile } from './lib/test-run/report-file.js';
import { BATCH_PORT_ENV, parseVerdict, serializeLine } from './lib/test-run/test-batch-protocol.js';
import { packageVitestConfigFile } from './lib/test-run/test-packages.js';
import { COVERAGE_RUN_ROUTES } from './lib/test-run/test-routes.js';
import {
  collectedNoTestFile,
  coverageNotEvaluatedReason,
  emptyCoverageScopeReason,
  measuredNoFile,
  noTestFilesCollectedReason,
  partialCoverageReason,
} from './lib/vitest/coverage-scope.js';
import { loadPackageCoverageGlobs } from './lib/vitest/coverage-globs.js';
import {
  POLE_MAJORITY_SHARE,
  POLE_MIN_MS,
  detectPoles,
  failedFilesForDirectory,
  perFileWallMs,
  sumFileWallMs,
  type VitestJsonReport,
} from './lib/test-run/test-report.js';
import {
  deriveRepositoryVitestWorkers,
  formatVitestRunReport,
  measureTestFiles,
  observeRunConstraints,
  readMachineMemoryEvents,
  recordVitestRun,
  trackRunSplit,
} from './lib/vitest/workers.js';
import { machineFingerprint } from './lib/pool/machine.js';
import { PSS_SAMPLE_INTERVAL_MS } from './turbo-pool.js';
import {
  formatOffsetDivergences,
  type OffsetScanResult,
} from './lib/vitest/coverage-offset-detector.js';
import type { Ownership } from './lib/claims/ownership.js';
import type {
  MachineMemoryEvents,
  RunSplitTracker,
  TestFileMeasurement,
  VitestRunDisposition,
  VitestRunRecord,
  VitestRunShape,
  VitestWorkerDerivation,
} from './lib/vitest/workers.js';

/**
 * One package's `test` script. Two modes:
 *
 * - **Batch** (`HB_TEST_BATCH_PORT` set): a full-suite run is in flight and
 *   the coordinator (`scripts/test-batch.ts`) executes every cache-missed
 *   package's tests in one consolidated vitest invocation, so a single global
 *   worker pool schedules all files. This process registers, waits, and exits
 *   with the coordinator's verdict — turbo then caches this package's task on
 *   its own input hash exactly as if the tests had run here.
 * - **Solo** (no port): a scoped run of just this package through the same
 *   consolidated root config — the package directory as the file filter and
 *   the package's own coverage globs as the include scope.
 *
 * The old per-package worker allocation (proportional work-shares over a
 * fixed budget) is gone with the per-package vitest processes it divided the
 * machine between: one shared pool needs no division.
 */

const REPORTS_DIRECTORY_FLAG = '--coverage.reportsDirectory';
const COVERAGE_INCLUDE_FLAG = '--coverage.include';
const CONFIG_FLAG = '--config';

/** What every coverage directory named here begins with. */
const RUN_DIRECTORY_PREFIX = 'run-';

/**
 * Coverage reports directory of the run holding `runId`, under `dir`.
 *
 * Vitest's v8 provider deletes the reports directory and the `.tmp` scratch
 * inside it both when it starts and when it finishes, so two runs sharing one
 * delete each other's intermediate dumps: the losing run dies on a missing
 * `.tmp` with every test passed and no `FAIL` line, which reads as a healthy
 * run. Vitest offers no setting for the scratch on its own — it is always
 * `.tmp` under the reports directory — so a reports directory per run is the
 * whole of the supported answer, and it is the one vitest's own error message
 * names.
 *
 * Keyed to the run's claim rather than to its pid: a pid is recycled, so a
 * later run can be handed a directory an earlier one is still writing, and a
 * pid says nothing an already-dead run's leftovers can be attributed by. The
 * claim answers both — the registry says whether the run naming a directory is
 * still alive, without a clock entering the decision.
 */
export function runCoverageDirectory(dir: string, runId: string): string {
  return path.join(coverageDirectory(dir), `${RUN_DIRECTORY_PREFIX}${runId}`);
}

/** The directory one tree's run coverage directories sit in. */
export function coverageDirectory(dir: string): string {
  return path.join(dir, COVERAGE_DIRECTORY_NAME);
}

/**
 * The run a coverage directory names, or undefined for a name this module
 * never minted. The name is the only part of the directory that exists from
 * the instant the directory does, which is what lets a leftover be attributed
 * at all.
 */
export function coverageDirectoryRunId(entry: string): string | undefined {
  if (!entry.startsWith(RUN_DIRECTORY_PREFIX)) {
    return undefined;
  }
  const runId = entry.slice(RUN_DIRECTORY_PREFIX.length);
  return runId === '' ? undefined : runId;
}

export interface CoverageDirectoryFs {
  readonly readdir: (dir: string) => readonly string[];
  readonly remove: (target: string) => void;
}

export interface CoverageReclaim {
  /** Directories whose owning run is gone, and which this pass removed. */
  readonly removed: readonly string[];
  /** Directories no claim accounts for. Reported and left standing. */
  readonly unowned: readonly string[];
}

/**
 * Collect the coverage directories runs that died left behind.
 *
 * The three ownership states carry three verdicts, the same three every other
 * reclaimer in this repository reads off the claim registry: a directory whose
 * run still holds its claim belongs to a concurrent run and removing it would
 * kill that run on its own missing `.tmp`; one whose run is gone is culled;
 * and one no claim accounts for is reported and left standing, because nothing
 * here can tell it from a resource this design has never seen.
 *
 * A missing coverage directory is the first run in a package, not a failure.
 */
export function reclaimCoverageDirectories(
  coverageDir: string,
  ownership: Ownership,
  fs: CoverageDirectoryFs
): CoverageReclaim {
  let entries: readonly string[];
  try {
    entries = fs.readdir(coverageDir);
  } catch {
    return { removed: [], unowned: [] };
  }
  const removed: string[] = [];
  const unowned: string[] = [];
  for (const entry of entries) {
    const runId = coverageDirectoryRunId(entry);
    if (runId === undefined) {
      continue;
    }
    const state = ownership.stateOfRun(runId);
    if (state === 'owned-live') {
      continue;
    }
    const target = path.join(coverageDir, entry);
    if (state === 'unowned') {
      unowned.push(target);
      continue;
    }
    fs.remove(target);
    removed.push(target);
  }
  return { removed, unowned };
}

/**
 * The real filesystem behind {@link reclaimCoverageDirectories}, shared by both
 * runners that key a coverage directory to their run: this per-package runner
 * and the batch coordinator, which sweeps the repo-root directory the same way.
 */
export const coverageDirectoryFs: CoverageDirectoryFs = {
  readdir: (dir) => readdirSync(dir),
  remove: (target) => {
    rmSync(target, { recursive: true, force: true });
  },
};

/**
 * Records this run's coverage directory against its claim and collects the
 * ones dead runs left behind.
 *
 * One call because both read the claim registry, and because claiming has to
 * happen before anything creates the directory: a claim naming a directory
 * nothing made is harmless, and the reverse order produces an orphan by
 * construction.
 *
 * Shared by both entry points that key a coverage directory to their run — the
 * whole-package route and the named-files route — because a second spelling of
 * this pair is a second answer to which directories a run may destroy.
 */
export async function claimAndReclaimCoverage(
  reportsDirectory: string,
  registryDir?: string
): Promise<CoverageReclaim> {
  await recordOwnedResource('directory', reportsDirectory);
  // One reading answers the whole pass: re-reading between directories would
  // classify them against two different worlds.
  return reclaimCoverageDirectories(
    path.dirname(reportsDirectory),
    await readOwnership(registryDir),
    coverageDirectoryFs
  );
}

/** Removes one run's own coverage directory, once the gates reading it have. */
export function dropCoverageDirectory(reportsDirectory: string): void {
  coverageDirectoryFs.remove(reportsDirectory);
}

/**
 * This run's claim, or a refusal naming what cannot work without one. A run
 * with no claim can neither key its coverage directory away from a concurrent
 * run of the same package nor have that directory reclaimed if it is killed,
 * and inventing an identity here would put both back where this replaced them.
 */
export function requireCoverageRunId(): string {
  const runId = currentRunId();
  if (runId === null) {
    throw new Error(
      'run-package-tests: this process holds no run claim, so its coverage directory can be ' +
        'neither isolated from a concurrent run of the same package nor reclaimed if this run ' +
        'is killed. Invoke it through scripts/with-env.ts, which takes the claim.'
    );
  }
  return runId;
}

/** A flag's value in either CLI form (`--flag=value`, `--flag value`); first occurrence wins. */
export function flagValue(args: readonly string[], flag: string): string | undefined {
  for (const [index, argument] of args.entries()) {
    if (argument.startsWith(`${flag}=`)) {
      return argument.slice(flag.length + 1);
    }
    if (argument === flag) {
      return args[index + 1];
    }
  }
  return undefined;
}

/**
 * Drop every bare separator a package manager puts among forwarded arguments.
 * vitest 4.1.8 discards every argument after a bare `--` (verified: the
 * positional file filter is dropped and the whole package is collected), so an
 * unstripped separator silently voids the rest of the passthrough *and* this
 * wrapper's own appended defaults — the coverage override lands nowhere and the
 * run still exits 0. Position cannot be used to tell a harmful separator from a
 * meaningful one, because there is no meaningful one: `pnpm run <script> -- <args>`
 * re-inserts a separator of its own on top of the one it consumed, so `-- --`
 * arrives as two, and a `test` script carrying its own arguments makes them land
 * mid-list. A `--`-prefixed token longer than the separator is an ordinary flag
 * and is untouched.
 */
export function dropSeparators(args: readonly string[]): readonly string[] {
  return args.filter((argument) => argument !== ARGUMENT_SEPARATOR);
}

/**
 * Refuse a command line that names test files.
 *
 * A named file reaches vitest as one more positional filter beside the package
 * directory this runner already passes, and vitest unions its filters: the
 * named files run, the rest of the package runs too, and nothing says the
 * request was widened. Running the named files instead is not on offer here —
 * the coverage scope stays the package's own globs and its thresholds are per
 * file, so every file a subset leaves unexercised fails the gate.
 *
 * Which slots are filters is vitest's own parser's answer rather than a second
 * reading of the line here: a bare token is equally the value of a preceding
 * flag, and refusing one of those would break a caller passing a flag this
 * forwards.
 */
export function refuseFileSelection(passthroughArgs: readonly string[]): void {
  // `parseCLI` overwrites the two leading slots of the array it is handed, so
  // it gets one built for it rather than the caller's own.
  const named = parseCLI(['vitest', 'run', ...dropSeparators(passthroughArgs)]).filter;
  if (named.length === 0) {
    return;
  }
  const quoted = named.map((filter) => `\`${filter}\``).join(', ');
  throw new Error(
    `run-package-tests: this runs a whole package, so it refuses the test files named on its ` +
      `command line: ${quoted}. vitest unions a named file with the package directory this ` +
      `passes, so they would have run AND so would the rest of the package, and this runner ` +
      `cannot narrow to them: its coverage scope is the package's own globs and every file a ` +
      `subset leaves unexercised fails the per-file threshold. ${COVERAGE_RUN_ROUTES}; ` +
      `\`pnpm test:watch <path> --run\` runs a named test file without coverage.`
  );
}

/**
 * Drop a flag and its value from forwarded arguments, in either CLI form. The
 * `--config` a package script passes names that package's own config (the
 * coverage-glob source); the consolidated invocation must not inherit it.
 */
export function dropFlag(args: readonly string[], flag: string): readonly string[] {
  const kept: string[] = [];
  let skipNext = false;
  for (const argument of args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (argument === flag) {
      skipNext = true;
      continue;
    }
    if (argument.startsWith(`${flag}=`)) {
      continue;
    }
    kept.push(argument);
  }
  return kept;
}

/**
 * `1` when this run produced no coverage map at all (warning as it goes), `0`
 * otherwise. Separate from {@link vacuousScopeExitCode} because the two states
 * are different findings an operator acts on differently — a scope that reached
 * nothing is a configuration fault, an absent map is a run that never got as far
 * as judging coverage — and collapsing them would report either one under the
 * other's name.
 *
 * It fails rather than warns, unlike the absent offset findings: a missing
 * offset scan leaves the coverage numbers unchecked for one corruption, whereas
 * a missing map means there are no coverage numbers, so exiting 0 here hands
 * back a green that a reader takes for a coverage pass.
 */
export function coverageNotEvaluatedExitCode(
  packageName: string,
  reportsDirectory: string,
  coverageMap: Readonly<Record<string, unknown>> | undefined,
  deps: Pick<SoloDeps, 'warn'>
): number {
  if (coverageMap !== undefined) {
    return 0;
  }
  deps.warn(`[${packageName}] ${coverageNotEvaluatedReason(reportsDirectory)}`);
  return 1;
}

/**
 * `1` when this package's run measured no file at all (warning as it goes), `0`
 * otherwise. The invariant is unconditional rather than gated on a command-line
 * flag: a run that reports success having measured nothing proves nothing,
 * whatever narrowed its scope, and gating it on a flag puts the invariant
 * somewhere a per-package configuration edit can lose it.
 *
 * The predicate and the wording are {@link measuredNoFile} and
 * {@link emptyCoverageScopeReason}, imported rather than restated, so this mode
 * and the batch cannot come to differ about what counts as a vacuous run or
 * about what it tells the operator.
 */
export function vacuousScopeExitCode(
  packageName: string,
  coverageMap: Readonly<Record<string, unknown>> | undefined,
  deps: Pick<SoloDeps, 'packageDir' | 'coverageInclude' | 'warn'>
): number {
  // A missing map is a run that produced no coverage data to judge, not a
  // vacuous scope; only a map that exists and measures nothing here proves it.
  // {@link coverageNotEvaluatedExitCode} is what fails the run in that case.
  if (coverageMap === undefined || !measuredNoFile(coverageMap, deps.packageDir)) {
    return 0;
  }
  deps.warn(`[${packageName}] ${emptyCoverageScopeReason(deps.coverageInclude)}`);
  return 1;
}

/**
 * `1` when the coverage-offset scan found a module measured under more than one
 * wrapper offset (warning as it goes), `0` otherwise. It fails rather than warns
 * because the finding is not a heuristic: the run's coverage numbers for that
 * module describe the wrong lines, so passing the coverage threshold on them
 * proves nothing, and the corruption is invisible in the report itself.
 *
 * A missing findings file means the scan never ran — a hole in the gate worth
 * saying out loud, but not evidence of a corrupt merge, so it does not fail.
 */
export function offsetDivergenceExitCode(
  packageName: string,
  reportFile: string,
  deps: Pick<SoloDeps, 'readOffsetDivergences' | 'warn'>
): number {
  const divergences = deps.readOffsetDivergences(reportFile);
  if (divergences === undefined) {
    deps.warn(
      `[${packageName}] coverage-offset scan did not run — this run's coverage numbers were not checked for offset misattribution (no findings at ${reportFile}).`
    );
    return 0;
  }
  if (divergences.length === 0) {
    return 0;
  }
  for (const line of formatOffsetDivergences(packageName, divergences)) {
    deps.warn(line);
  }
  return 1;
}

/**
 * `1` when the run collected no test file under this package (warning as it
 * goes), `0` otherwise.
 *
 * The predicate and the line it warns with are {@link collectedNoTestFile} and
 * {@link noTestFilesCollectedReason}, which the batch verdicts judge the same
 * state through: a signal one mode raises and the other does not is a batched
 * package passing where its own solo run would have failed.
 *
 * An absent report is a different state and is not this gate's to judge —
 * {@link runSolo} returns before reaching here, because a run killed before it
 * wrote one collected an unknown number of files.
 */
export function noTestsCollectedExitCode(
  packageName: string,
  packageDir: string,
  report: VitestJsonReport,
  warn: (line: string) => void
): number {
  if (!collectedNoTestFile(report, packageDir)) {
    return 0;
  }
  warn(`[${packageName}] ${noTestFilesCollectedReason()}`);
  return 1;
}

/**
 * States that this run's coverage numbers were measured over a suite that did
 * not finish, when one of this package's test files failed.
 *
 * It adds no exit code: the failing file already fails the run, and the
 * coverage thresholds judge these numbers exactly as they judge a complete
 * run's. What the line adds is the fact a reader needs to tell a shortfall
 * caused by the failure from one caused by a thin test — the wording is
 * {@link partialCoverageReason}, which the batch verdicts state the same state
 * in, so the two modes cannot come to describe it differently.
 */
export function warnPartialCoverage(
  packageName: string,
  packageDir: string,
  report: VitestJsonReport,
  warn: (line: string) => void
): void {
  const failedFiles = failedFilesForDirectory(report, packageDir);
  if (failedFiles.length > 0) {
    warn(`[${packageName}] ${partialCoverageReason(failedFiles.length)}`);
  }
}

/** `1` when the report holds a pole (warning as it goes), `0` otherwise. */
export function poleExitCode(
  packageName: string,
  report: VitestJsonReport,
  warn: (line: string) => void
): number {
  const poles = detectPoles(report, { minMs: POLE_MIN_MS, majorityShare: POLE_MAJORITY_SHARE });
  if (poles.length === 0) {
    return 0;
  }
  warn(
    `[${packageName}] POLE TEST FILE — a single file dominates this package's test wall-clock; split it into smaller test files:`
  );
  for (const pole of poles) {
    const seconds = (pole.wallMs / 1000).toFixed(1);
    const percent = (pole.share * 100).toFixed(0);
    warn(`[${packageName}]   ${pole.file} — ${seconds}s (${percent}% of package test-work)`);
  }
  return 1;
}

/** `@hushbox/ops` → `ops`; an unscoped name is returned unchanged. */
export function deriveShortName(fullName: string): string {
  const slash = fullName.lastIndexOf('/');
  return slash === -1 ? fullName : fullName.slice(slash + 1);
}

/** A run under measurement, until the report it is folded together with lands. */
export interface RunMeasurement {
  /** Stop sampling and append the row this run and its report amount to. */
  readonly record: (report: VitestJsonReport | undefined) => void;
}

/** Where a measured run's readings come from, and where its row and account go. */
export interface MeasuredRunDeps {
  /** The repository the rows are keyed within. */
  readonly repoRoot: string;
  /**
   * Starts sampling the tree the run's workers live in. The runner is optional
   * for the reason the record's own field is: a binary that fails to spawn
   * carries no process id, and standing a number in for it would charge some
   * other process's children as this run's workers.
   */
  readonly track: (runnerPid: number | undefined) => RunSplitTracker;
  /** Appends the row and the rows of the files it measured, or refuses and says what refused it. */
  readonly record: (
    record: VitestRunRecord,
    files: readonly TestFileMeasurement[]
  ) => VitestRunDisposition;
  /** The machine's out-of-memory counter, read at each end of the run. */
  readonly machineEvents: () => MachineMemoryEvents;
  /** The count the package's own configuration launched the run at. */
  readonly derivation: VitestWorkerDerivation;
  /**
   * What kind of invocation this is, which is the stamp retention ages the row
   * under. Named by the caller rather than fixed here, because the launchers
   * sharing this measurement do not share a shape: a one-shot run rooted in a
   * package is `package`, and a watch session — whose row spans the session
   * rather than any single run inside it — is `watch`, the shape the shared
   * vitest configuration's own reporter stamps.
   */
  readonly shape: VitestRunShape;
  /** Where the run's account of itself goes, and where a refused row goes. */
  readonly report: (line: string) => void;
  readonly warn: (line: string) => void;
}

/**
 * Measures one launcher-started run and records what it measured, the way the
 * consolidated batch records its own.
 *
 * The row states one package, because every launcher reaching here spawns
 * vitest in exactly one package directory. Batch rows and these land in one
 * store, told apart by the shape each stamps: retention ages a width on the
 * runs of its own shape, so this path's many short runs cannot expire a width
 * only a batch has ever reached.
 *
 * A row per file goes in beside it carrying the wall this run weighed the file
 * at, through the same reduction the batch uses.
 *
 * Shared by both package-rooted launchers rather than written once each: the
 * two rows describe the same kind of thing and would be read against each
 * other, so a figure assembled differently on one side is a figure the ladder
 * compares with itself. It lives here rather than beside the watch launcher
 * because that launcher already imports this module, and the reverse edge
 * would close a cycle.
 */
export function measureVitestRun(
  runnerPid: number | undefined,
  deps: MeasuredRunDeps
): RunMeasurement {
  // Read at the run's two ends, because these counters are the machine's whole
  // uptime: only the difference across the span says anything, and only at
  // machine scope.
  const eventsAtStart = deps.machineEvents();
  const startedAt = performance.now();
  const tracker = deps.track(runnerPid);
  return {
    record: (report) => {
      const { peakRssKb, split, lanesAtPeak } = tracker.stop();
      const constraints = observeRunConstraints(eventsAtStart, deps.machineEvents());
      const files = measureTestFiles(deps.repoRoot, report);
      const disposition = deps.record(
        {
          wallMs: performance.now() - startedAt,
          peakRssKb,
          split,
          runnerPid,
          declaredWorkers: deps.derivation.workers,
          fileCount: report?.testResults?.length ?? 0,
          // The lanes that were live when the tree peaked, which is the width
          // the ladder files this row at — never the count the run declared: a
          // run that opened eight lanes for two files held two.
          lanesAtPeak,
          shape: deps.shape,
          packageCount: 1,
          perFileWallMs: perFileWallMs(report),
          sumFileWallMs: sumFileWallMs(report),
        },
        files
      );
      const account = formatVitestRunReport({
        derivation: deps.derivation,
        split,
        constraints,
        disposition,
      });
      if (disposition.kind === 'refused') deps.warn(account);
      else deps.report(account);
    },
  };
}

export interface SoloDeps {
  readonly repoRoot: string;
  readonly packageDir: string;
  readonly packageName: string;
  /** Used only when the caller passes no `--coverage.reportsDirectory` of its own. */
  readonly defaultReportsDirectory: string;
  readonly passthroughArgs: readonly string[];
  readonly coverageInclude: readonly string[];
  readonly readReport: (file: string) => VitestJsonReport | undefined;
  readonly readCoverageMap: (
    reportsDirectory: string
  ) => Readonly<Record<string, unknown>> | undefined;
  readonly readOffsetDivergences: (file: string) => OffsetScanResult | undefined;
  /**
   * Names this run's json report and collects the ones dead runs left beside
   * it. One call for the same reason the coverage pair below is one: the name
   * carries the owner, so it cannot be minted after the file it attributes.
   */
  readonly claimReportFile: () => Promise<string>;
  /** Removes one of this run's report files once the gates have read it. */
  readonly dropReport: (file: string) => void;
  /**
   * Records this run's coverage directory against its claim and collects the
   * ones dead runs left behind. One call because both read the claim registry,
   * and because claiming has to happen before anything creates the directory:
   * a claim naming a directory nothing made is harmless, and the reverse order
   * produces an orphan by construction.
   */
  readonly claimAndReclaimCoverage: (reportsDirectory: string) => Promise<CoverageReclaim>;
  /** Removes this run's own coverage directory once the gates have read it. */
  readonly dropCoverage: (reportsDirectory: string) => void;
  /**
   * The count this run declares on its launch line and holds for its whole
   * span, which is also the count its ledger row states. Taken once by the
   * caller rather than twice here, so the pool the run opened and the pool the
   * row names cannot disagree.
   */
  readonly derivation: VitestWorkerDerivation;
  /**
   * Starts measuring the run whose runner is `runnerPid`, for the ledger row it
   * will become, against the derivation the run was launched at.
   *
   * This launcher names reporters on its command line, and a named reporter
   * replaces the configured list wholesale, so the recorder the shared vitest
   * configuration declares never runs inside a runner started here: the row is
   * this seam's or there is none.
   */
  readonly measure: (
    runnerPid: number | undefined,
    derivation: VitestWorkerDerivation
  ) => RunMeasurement;
  /**
   * Runs vitest, announcing its runner through `started` as soon as one exists
   * — which is what a measurement of the run has to begin from, and is
   * `undefined` where the binary never spawned.
   */
  readonly exec: (
    vitestArgs: readonly string[],
    childEnv: NodeJS.ProcessEnv,
    started: (runnerPid: number | undefined) => void
  ) => Promise<number>;
  readonly log: (line: string) => void;
  readonly warn: (line: string) => void;
}

/**
 * The scoped standalone run: this package's directory as the file filter and
 * its own coverage globs as the include, through the consolidated root config.
 * Returns vitest's exit code raised by the vacuous-scope, offset and pole
 * gates.
 */
export async function runSolo(env: NodeJS.ProcessEnv, deps: SoloDeps): Promise<number> {
  const passthroughArgs = dropFlag(dropSeparators(deps.passthroughArgs), CONFIG_FLAG);
  const vitestArgs = [
    'run',
    deps.packageDir,
    '--coverage',
    `${CONFIG_FLAG}=${path.join(deps.repoRoot, 'vitest.projects.config.ts')}`,
    // Declared rather than left to the configuration to resolve inside the
    // runner, because this launcher records the run's row and a count no
    // command line carried is one it could only guess at. The figure is
    // {@link deriveRepositoryVitestWorkers}', which answers as the configuration
    // itself would, so declaring it changes what the row can state and not what pool
    // the run opens.
    `--maxWorkers=${String(deps.derivation.workers)}`,
    ...deps.coverageInclude.map((glob) => `${COVERAGE_INCLUDE_FLAG}=${glob}`),
    ...passthroughArgs,
  ];
  const suppliedReportsDirectory = flagValue(passthroughArgs, REPORTS_DIRECTORY_FLAG);
  const reportsDirectory = suppliedReportsDirectory ?? deps.defaultReportsDirectory;
  // A directory the caller named is the caller's to keep: this run neither
  // claims it, nor sweeps beside it, nor drops it.
  const ownsDirectory = suppliedReportsDirectory === undefined;
  if (ownsDirectory) {
    vitestArgs.push(`${REPORTS_DIRECTORY_FLAG}=${reportsDirectory}`);
    deps.log(`[${deps.packageName}] coverage report → ${reportsDirectory}`);
    const { unowned } = await deps.claimAndReclaimCoverage(reportsDirectory);
    if (unowned.length > 0) {
      deps.warn(
        `[${deps.packageName}] coverage directories no run claim accounts for, left standing: ${unowned.join(', ')}`
      );
    }
  }
  // Keep the default console reporter so failures still show; json purely
  // captures per-file durations for the pole gate.
  const temporaryFile = await deps.claimReportFile();
  vitestArgs.push('--reporter=default', '--reporter=json', `--outputFile.json=${temporaryFile}`);

  // The coverage provider writes the offset-scan findings itself (it is the
  // raw dumps' only reader); this run just names the file and judges it after.
  const offsetReportFile = `${temporaryFile}.offsets.json`;
  let measurement: RunMeasurement | undefined;
  try {
    const vitestExitCode = await deps.exec(
      vitestArgs,
      { ...env, [REPORT_ENV]: offsetReportFile },
      (runnerPid) => {
        measurement = deps.measure(runnerPid, deps.derivation);
      }
    );
    // Folded in before the gates below rather than after them: the run ended
    // when the runner did, and sampling through a multi-megabyte map parse
    // would charge this process's own gate work to the run it measured.
    const report = deps.readReport(temporaryFile);
    measurement?.record(report);

    // Read once and judged twice: the two gates ask different questions of the
    // same artifact, and a second read of a multi-megabyte map to answer the
    // second question buys nothing.
    const coverageMap = deps.readCoverageMap(reportsDirectory);
    let exitCode = Math.max(
      vitestExitCode,
      coverageNotEvaluatedExitCode(deps.packageName, reportsDirectory, coverageMap, deps),
      vacuousScopeExitCode(deps.packageName, coverageMap, deps),
      offsetDivergenceExitCode(deps.packageName, offsetReportFile, deps)
    );
    if (report === undefined) {
      deps.warn(
        `[${deps.packageName}] no json report at ${temporaryFile}: the gates that read it were skipped`
      );
      return exitCode;
    }
    warnPartialCoverage(deps.packageName, deps.packageDir, report, deps.warn);
    exitCode = Math.max(
      exitCode,
      noTestsCollectedExitCode(deps.packageName, deps.packageDir, report, deps.warn),
      poleExitCode(deps.packageName, report, deps.warn)
    );
    return exitCode;
  } finally {
    // Drop before release. Every gate above has already read what it needed
    // out of these, and nothing outside this run reads any of them at all, so
    // keeping them would leave a fresh set behind on every invocation for a
    // later run to collect — which is what put a bespoke sweeper here in the
    // first place.
    deps.dropReport(temporaryFile);
    deps.dropReport(offsetReportFile);
    if (ownsDirectory) {
      deps.dropCoverage(reportsDirectory);
    }
  }
}

/**
 * Register with the coordinator and wait for this package's verdict. A dead or
 * unreachable coordinator fails loudly: falling back to a standalone run here
 * would have every waiting package start its own full-pool vitest at once —
 * the exact oversubscription the batch exists to prevent.
 */
export function runBatched(
  port: number,
  registration: { package: string; dir: string },
  warn: (line: string) => void
): Promise<'ok' | 'fail' | 'solo'> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let buffer = '';
    socket.on('connect', () => {
      socket.write(serializeLine(registration));
    });
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline === -1) {
        return;
      }
      const message = parseVerdict(buffer.slice(0, newline));
      socket.end();
      if (!message) {
        warn(`[${registration.package}] unparseable batch verdict; failing this package's task`);
        resolve('fail');
        return;
      }
      if (message.verdict === 'fail') {
        for (const reason of message.reasons) {
          warn(`[${registration.package}] ${reason}`);
        }
      }
      resolve(message.verdict);
    });
    socket.on('error', (error: Error) => {
      warn(`[${registration.package}] batch coordinator unreachable (${error.message}); failing`);
      resolve('fail');
    });
    socket.on('end', () => {
      // Coordinator went away without a verdict — e.g. its vitest crashed.
      if (!buffer.includes('\n')) {
        warn(`[${registration.package}] batch coordinator closed without a verdict; failing`);
        resolve('fail');
      }
    });
  });
}

/* v8 ignore start -- CLI entry point exercised via the per-package test scripts */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.dirname(scriptDir);
    const packageDir = process.cwd();
    const passthroughArgs = process.argv.slice(2);
    // Ahead of the mode dispatch below, because the batch mode does not read
    // these arguments at all: a file named there is discarded even earlier
    // than one named on the standalone path.
    refuseFileSelection(passthroughArgs);
    const manifest = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as {
      name: string;
      scripts?: Record<string, string>;
    };
    const packageName = deriveShortName(manifest.name);

    // The workers-pool suite (a different execution substrate) runs
    // concurrently with this package's node-suite verdict — batched or solo —
    // instead of serializing ahead of it; the task's exit is the worse of the
    // two.
    const workersSuite: Promise<number> =
      typeof manifest.scripts?.['test:workers'] === 'string'
        ? execa('pnpm', ['run', 'test:workers'], {
            cwd: packageDir,
            stdio: 'inherit',
            reject: false,
            preferLocal: true,
          }).then((result) => (typeof result.exitCode === 'number' ? result.exitCode : 1))
        : Promise.resolve(0);

    const portValue = process.env[BATCH_PORT_ENV];
    if (portValue) {
      const [verdict, workersExit] = await Promise.all([
        runBatched(Number(portValue), { package: manifest.name, dir: packageDir }, (line) => {
          console.warn(line);
        }),
        workersSuite,
      ]);
      if (verdict !== 'solo') {
        return Math.max(verdict === 'ok' ? 0 : 1, workersExit);
      }
      // 'solo': the coordinator will not batch this package; run it scoped.
    }

    const { include } = await loadPackageCoverageGlobs(
      repoRoot,
      path.relative(repoRoot, packageDir),
      packageVitestConfigFile(packageDir)
    );
    const defaultReportsDirectory = runCoverageDirectory(packageDir, requireCoverageRunId());
    const fingerprint = machineFingerprint();
    // Once, here, and held: the same figure reaches the runner on its command
    // line and the ledger as the count this run declared.
    const { derivation } = deriveRepositoryVitestWorkers(repoRoot, fingerprint);
    const soloRun = runSolo(process.env, {
      repoRoot,
      packageDir,
      packageName,
      defaultReportsDirectory,
      passthroughArgs,
      coverageInclude: include,
      readReport: (file) => {
        if (!existsSync(file)) {
          return;
        }
        return JSON.parse(readFileSync(file, 'utf8')) as VitestJsonReport;
      },
      readCoverageMap: (reportsDirectory) => {
        // An explicitly supplied reports directory may be relative, and vitest
        // resolves it against the repo root the consolidated config runs from.
        const file = path.resolve(repoRoot, reportsDirectory, 'coverage-final.json');
        if (!existsSync(file)) {
          return;
        }
        return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      },
      readOffsetDivergences: (file) => {
        if (!existsSync(file)) {
          return;
        }
        return JSON.parse(readFileSync(file, 'utf8')) as OffsetScanResult;
      },
      claimReportFile: () => claimReportFile(),
      dropReport: dropReportFile,
      claimAndReclaimCoverage,
      dropCoverage: dropCoverageDirectory,
      derivation,
      measure: (runnerPid, launched) =>
        measureVitestRun(runnerPid, {
          // The tree measured is this process's rather than the runner's: the
          // package's workers-pool suite runs alongside this run rather than
          // inside it, so those processes are siblings of the runner, and
          // everything this command spawns descends from here. The workers
          // charged inside that tree are the runner's own children, which
          // leaves the sibling suite and this wrapper in the fixed cost where
          // they belong.
          track: (pid) =>
            trackRunSplit({
              treeRootPid: process.pid,
              runnerPid: pid,
              intervalMs: PSS_SAMPLE_INTERVAL_MS,
            }),
          record: (record, files) => recordVitestRun(repoRoot, fingerprint, record, files),
          repoRoot,
          machineEvents: readMachineMemoryEvents,
          derivation: launched,
          shape: 'package',
          report: (line) => {
            console.log(line);
          },
          warn: (line) => {
            console.warn(line);
          },
        }),
      exec: (vitestArgs, childEnv, started) =>
        // The runner's dependency optimizer writes into its cache directory
        // while it builds its project servers, before any of our code runs
        // inside it — so the claim on that directory is taken around the start
        // rather than beside it.
        withRunnerCacheClaim(
          {
            repoRoot,
            projectRoot: repoRoot,
            processId: process.pid,
            env: childEnv,
            now: Date.now(),
          },
          async () => {
            const child = execa('vitest', [...vitestArgs], {
              stdio: 'inherit',
              reject: false,
              preferLocal: true,
              cwd: repoRoot,
              env: childEnv,
            });
            // Read off the child and announced once, never defaulted: rejection
            // is disabled here, so a binary that fails to spawn reaches this
            // line with no process id at all.
            started(child.pid);
            const result = await child;
            return typeof result.exitCode === 'number' ? result.exitCode : 1;
          }
        ),
      log: (line) => {
        console.log(line);
      },
      warn: (line) => {
        console.warn(line);
      },
    });
    const [soloExit, workersExit] = await Promise.all([soloRun, workersSuite]);
    return Math.max(soloExit, workersExit);
  });
}
/* v8 ignore stop */
