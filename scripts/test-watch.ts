import path from 'node:path';
import os from 'node:os';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCLI } from 'vitest/node';
import { isMainModule } from './lib/cli/is-main.js';
import { runMain } from './lib/cli/run-main.js';
import { slotsHiddenBySeparator } from './lib/cli/argument-separator.js';
import { spawnLongLived } from './lib/spawn/long-lived.js';
import { claimReportFile, dropReportFile } from './lib/test-run/report-file.js';
import {
  SOURCE_FLAG,
  coverageFigures,
  coverageIncludeFor,
  emptyMapOutcome,
  exitCodeFor,
  lowerBoundReport,
  modulesUnderTest,
  type CoverageOutcome,
  type ModuleFs,
} from './lib/test-run/file-coverage.js';
import {
  claimAndReclaimCoverage,
  dropCoverageDirectory as removeCoverageDirectory,
  measureVitestRun,
  runCoverageDirectory,
  type RunMeasurement,
} from './run-package-tests.js';
import { currentRunId } from './lib/claims/ownership.js';
import { ledgerPath, readLedger } from './lib/pool/ledger.js';
import { machineFingerprint } from './lib/pool/machine.js';
import { PLANNING_MEMORY_FRACTION, memoryBudgetKb } from './lib/pool/memory.js';
import { withRunnerCacheClaim } from './lib/vitest/cache-sweep.js';
import {
  VITEST_LEDGER_TASK,
  deriveVitestWorkers,
  readMachineMemoryEvents,
  recordVitestRun,
  repoRelativeTestFile,
  trackRunSplit,
  vitestFileUnits,
} from './lib/vitest/workers.js';
import { PSS_SAMPLE_INTERVAL_MS } from './turbo-pool.js';
import {
  NODE_OPTION_FLAG,
  appendNodeOption,
  loadEnvironment,
  stackModeFrom,
  withRunClaim,
} from './with-env.js';
import type { LedgerEntry, PoolLedger } from './lib/pool/ledger.js';
import type { PoolTaskEstimate } from './lib/pool/schedule.js';
import type { VitestJsonReport } from './lib/test-run/test-report.js';
import type { VitestWorkerDerivation } from './lib/vitest/workers.js';

/**
 * Package-aware `pnpm test:watch`. A root invocation naming a package's test
 * file must run vitest FROM that package directory — vitest only loads the
 * owning package's config (aliases like apps/web's `@/`) for an in-package
 * invocation, so running from the repo root fails alias resolution.
 */

/** The disk both the planner and the scope derivation read, injected as one. */
export interface WatchFs extends ModuleFs {
  readonly hasPackageJson: (dir: string) => boolean;
}

export interface Invocation {
  readonly cwd: string;
  readonly args: readonly string[];
}

/**
 * An {@link Invocation} beside the positional paths that produced it, which is
 * what a coverage run derives its scope from. Separate from `Invocation`
 * because only the planner can answer which slots vitest's parser read as
 * paths, and only a coverage run needs the answer.
 */
interface PlannedInvocation extends Invocation {
  /** The positional paths this run named, absolute. */
  readonly paths: readonly string[];
}

/** Nearest ancestor of `targetPath` (inclusive for directories) with a package.json, up to `rootDir`. */
export function findOwningPackageDir(targetPath: string, rootDir: string, fs: WatchFs): string {
  let dir = fs.isDirectory(targetPath) ? targetPath : path.dirname(targetPath);
  for (;;) {
    if (fs.hasPackageJson(dir)) {
      return dir;
    }
    if (dir === rootDir || path.dirname(dir) === dir) {
      throw new Error(`test:watch: no package.json found from ${targetPath} up to ${rootDir}`);
    }
    dir = path.dirname(dir);
  }
}

/**
 * Opt-in spelling for vitest's substring match over test paths. Without it a
 * positional means a file or directory, so a typo cannot silently become a
 * filter.
 */
const PATH_FILTER_FLAG = '--path-filter';

/** Pull `--path-filter <substring>` and `--path-filter=<substring>` out of argv. */
function splitPathFilters(args: readonly string[]): {
  readonly rest: readonly string[];
  readonly filters: readonly string[];
} {
  const rest: string[] = [];
  const filters: string[] = [];
  let consumedAsValue = false;
  for (const [index, argument] of args.entries()) {
    if (consumedAsValue) {
      consumedAsValue = false;
      continue;
    }
    const separate = argument === PATH_FILTER_FLAG;
    if (!separate && !argument.startsWith(`${PATH_FILTER_FLAG}=`)) {
      rest.push(argument);
      continue;
    }
    consumedAsValue = separate;
    const value = separate ? args[index + 1] : argument.slice(PATH_FILTER_FLAG.length + 1);
    if (value === undefined || value === '') {
      throw new Error(
        `test:watch: ${PATH_FILTER_FLAG} needs a substring to match test paths against`
      );
    }
    filters.push(value);
  }
  return { rest, filters };
}

/** Turns this into a one-shot coverage run over the modules the named files cover. */
const COVERAGE_FLAG = '--coverage';

/** Where vitest writes the coverage report, which this run keys to its own claim. */
const REPORTS_DIRECTORY_FLAG = '--coverage.reportsDirectory';

interface CoverageRequest {
  /** Argv with this wrapper's own flags removed, for vitest's parser to read. */
  readonly rest: readonly string[];
  readonly coverage: boolean;
  /** Modules named explicitly, replacing the sibling each test file would answer with. */
  readonly sources: readonly string[];
}

/**
 * The module named by the slot at `index`, and whether it took the slot after
 * it as its value. `undefined` for a slot that is not a source override.
 */
function sourceOverride(
  args: readonly string[],
  index: number
): { readonly value: string; readonly separate: boolean } | undefined {
  const argument = args[index] ?? '';
  const separate = argument === SOURCE_FLAG;
  if (!separate && !argument.startsWith(`${SOURCE_FLAG}=`)) {
    return undefined;
  }
  const value = separate ? args[index + 1] : argument.slice(SOURCE_FLAG.length + 1);
  if (value === undefined || value === '') {
    throw new Error(`test:file: ${SOURCE_FLAG} needs the path of the module to measure`);
  }
  return { value, separate };
}

/**
 * Pull this wrapper's own coverage flags out of argv before vitest's parser
 * sees it.
 *
 * Removed rather than forwarded, for two different reasons. The coverage flag
 * is re-issued by {@link runVitest} beside the directory and the include this
 * run decides, so forwarding it as well would leave the caller's copy
 * competing with those. The source override names a module rather than a test
 * file, and a module reaching vitest as a positional is a filter matching no
 * test path.
 */
export function splitCoverageRequest(args: readonly string[]): CoverageRequest {
  const rest: string[] = [];
  const sources: string[] = [];
  let consumedAsValue = false;
  let coverage = false;
  for (const [index, argument] of args.entries()) {
    if (consumedAsValue) {
      consumedAsValue = false;
      continue;
    }
    if (argument === COVERAGE_FLAG) {
      coverage = true;
      continue;
    }
    const override = sourceOverride(args, index);
    if (override === undefined) {
      rest.push(argument);
      continue;
    }
    consumedAsValue = override.separate;
    sources.push(override.value);
  }
  return { rest, coverage, sources };
}

/**
 * Separates an argv slot's spelling from its index. A NUL cannot reach `process.argv`
 * — `execve` terminates each argument with one — so a tagged slot never collides
 * with an untagged one.
 */
const POSITION_TAG = '\u0000';

interface TaggedArgument {
  /** The slot as the caller spelled it. */
  readonly argument: string;
  /** The slot as vitest's parser is shown it. */
  readonly tagged: string;
}

/**
 * Argv paired with the spelling vitest's parser is shown for each slot. The parser
 * answers with filter VALUES, so two slots spelled alike are indistinguishable in
 * its answer; appending the index to a repeated spelling makes the answer name a
 * slot instead.
 *
 * Only a repeated spelling is tagged, because a tag also changes how the parser
 * READS a slot — a tagged short flag is read as a cluster of one-letter flags, and
 * a tagged subcommand as a positional path, which would reject `--ui run` as a
 * missing file. Two slots stay untagged for that reason even when repeated:
 * anything starting with `-`, and the first slot, where a subcommand repeated by a
 * directory of the same name (`run run`) has to keep its meaning.
 */
function tagPositions(args: readonly string[]): readonly TaggedArgument[] {
  const occursOnce = (value: string): boolean => args.indexOf(value) === args.lastIndexOf(value);
  return args.map((argument, index) => ({
    argument,
    tagged:
      index === 0 || argument.startsWith('-') || occursOnce(argument)
        ? argument
        : `${argument}${POSITION_TAG}${String(index)}`,
  }));
}

/**
 * Refuses a bare slot a preceding flag took as its value while it names something
 * that exists on disk.
 *
 * vitest's parser reports the VALUES a flag was given, never whether the flag
 * wanted one, so a flag that takes no value still absorbs the token after it and
 * a path there reaches no filter. Existence on disk is the evidence used here,
 * as it is for a positional: a guess at which flags take values would be a copy
 * of vitest's option table that drifts silently on every upgrade.
 */
function rejectSwallowedPath(
  slots: readonly TaggedArgument[],
  invocationDir: string,
  fs: WatchFs
): void {
  for (const [index, { argument }] of slots.entries()) {
    const flag = slots[index - 1]?.argument;
    if (flag === undefined || !flag.startsWith('-') || argument.startsWith('-')) {
      continue;
    }
    const resolved = path.resolve(invocationDir, argument);
    if (fs.isFile(resolved) || fs.isDirectory(resolved)) {
      throw new Error(
        `test:watch: \`${flag}\` took \`${argument}\` as its value, so nothing named a file to ` +
          `run and the run would have covered the whole repository. Put the path first if the flag ` +
          `takes no value (\`${argument} ${flag}\`); if the flag does take one, name what to run ` +
          `beside it — \`.\` for the whole repository.`
      );
    }
  }
}

/**
 * Refuses every slot standing after a bare `--`.
 *
 * vitest's parser reads `--` as the end of its own options, so from that slot
 * onward nothing is reported back as a filter or as an option. The positionals
 * that scope this wrapper's run therefore reach nothing, no package is
 * detected, and vitest widens to everything its config collects. Which failure
 * the operator meets is decided by vitest's own `watch` default, which follows
 * whether the process is interactive: non-interactive it exits 0, a widened run
 * that still looks like a passing one; interactive — and this wrapper passes no
 * `run` subcommand — it sits in watch mode rather than finishing.
 *
 * The reach is derived from the terminator, never from what follows it: a
 * subcommand, a path, a flag and a {@link PATH_FILTER_FLAG} are all dropped
 * alike, as is a spelling nobody has typed yet. A trailing `--` is left alone
 * because nothing follows it to drop, and it is the repair
 * {@link rejectSwallowedPath} names.
 */
function rejectTerminatedSlots(args: readonly string[]): void {
  const listed = slotsHiddenBySeparator(args);
  if (listed === null) {
    return;
  }
  throw new Error(
    `test:watch: \`--\` ends vitest's options, so ${listed} reached neither a filter nor a flag, ` +
      `nothing named a file to run, and the run would have covered everything the config ` +
      `collects. Write the same arguments without the \`--\`.`
  );
}

/**
 * Split argv into paths (rewritten absolute, driving package detection) and
 * passthrough args. One owning package → run from it; none → the invocation
 * directory (watch-all behavior unchanged); several → error.
 *
 * Which args are paths is decided by vitest's own CLI parser rather than by
 * shape, and its answer — a list of filter VALUES — is matched back onto argv by
 * POSITION wherever two slots are spelled alike (see {@link tagPositions}). So a
 * value taken by a preceding flag (`-t <name>`) is left alone even when a
 * positional path in the same invocation is spelled byte-identically to it, on
 * either side of it, and a leading subcommand (`run`) likewise. A path that resolves to nothing is rejected here: vitest would accept
 * it as a substring filter over test paths and report a green run that never
 * loaded the file. A path a flag absorbed as its value is rejected for the same
 * reason: it reaches no filter at all, so nothing checks it, no package is
 * detected, and the run silently widens to the whole repository. A slot the
 * `--` terminator hides from the parser altogether is rejected before either
 * check ({@link rejectTerminatedSlots}), since the parser's answer cannot
 * mention it.
 */
export function planInvocation(
  args: readonly string[],
  invocationDir: string,
  fs: WatchFs
): PlannedInvocation {
  rejectTerminatedSlots(args);
  const { rest, filters } = splitPathFilters(args);
  const slots = tagPositions(rest);
  const paths = new Set(parseCLI(['vitest', ...slots.map((slot) => slot.tagged)]).filter);
  if (paths.size === 0) {
    rejectSwallowedPath(slots, invocationDir, fs);
  }
  const rewritten: string[] = [];
  const resolvedPaths: string[] = [];
  const packageDirectories = new Set<string>();
  for (const { argument, tagged } of slots) {
    if (!paths.has(tagged)) {
      rewritten.push(argument);
      continue;
    }
    const resolved = path.resolve(invocationDir, argument);
    if (!fs.isFile(resolved) && !fs.isDirectory(resolved)) {
      throw new Error(
        `test:watch: no such file or directory: ${argument} (resolved to ${resolved}). ` +
          `Positional arguments name files and directories to run. vitest would have taken ` +
          `this one as a substring filter over test paths instead, run whatever else you ` +
          `named, and exited 0. Check the spelling and which directory the path is relative ` +
          `to, or pass \`${PATH_FILTER_FLAG} ${argument}\` if you did mean a substring filter.`
      );
    }
    const owner = findOwningPackageDir(resolved, invocationDir, fs);
    if (owner !== invocationDir) {
      packageDirectories.add(owner);
    }
    rewritten.push(resolved);
    resolvedPaths.push(resolved);
  }
  if (packageDirectories.size > 1) {
    const names = [...packageDirectories].map((d) => path.relative(invocationDir, d)).join(', ');
    throw new Error(
      `test:watch: files span multiple packages (${names}); run one package at a time`
    );
  }
  const [packageDir] = packageDirectories;
  return {
    cwd: packageDir ?? invocationDir,
    args: [...rewritten, ...filters],
    paths: resolvedPaths,
  };
}

/** What an invocation states about the work it is about to run, before vitest resolves it. */
interface WatchUnitScope {
  readonly repoRoot: string;
  /** The package directory vitest runs from, which scopes a run that named no path. */
  readonly packageDir: string;
  /** The positional paths the invocation named, absolute; empty where it named none. */
  readonly paths: readonly string[];
  /** Whether a named path is a directory rather than a file. */
  readonly isDirectory: (candidate: string) => boolean;
}

/**
 * The units a package-rooted invocation derives its worker count over.
 *
 * Which test files vitest will collect is not knowable here and cannot be made
 * so: the runner resolves them against the package's own include globs, a
 * substring filter narrows them again, and a watch session re-runs whichever of
 * them a later edit reaches. What the invocation does state is the paths it
 * named, and every file such a run can collect lies under one of them — so the
 * set is taken from those paths, and where none was named, from the package the
 * run executes in.
 *
 * Read high: a filter that narrows the run leaves the work bound scheduling
 * files that never ran, which surrenders a lane rather than opening one the
 * machine cannot hold.
 *
 * A named file is a unit whether or not the store has ever weighed it. It is
 * about to run, and the derivation weighs an unmeasured unit at the longest
 * wall in its own set rather than at nothing.
 */
function watchUnits(
  rows: Readonly<Record<string, LedgerEntry>>,
  scope: WatchUnitScope
): PoolTaskEstimate[] {
  const { repoRoot, packageDir, paths, isDirectory } = scope;
  const named = paths.filter((candidate) => !isDirectory(candidate));
  const directories =
    paths.length === 0 ? [packageDir] : paths.filter((candidate) => isDirectory(candidate));
  const units = vitestFileUnits(repoRoot, rows, directories);
  const covered = new Set(units.map((unit) => unit.name));
  for (const file of named) {
    const name = repoRelativeTestFile(repoRoot, file);
    if (covered.has(name)) continue;
    covered.add(name);
    units.push({ name, wallsMs: rows[name]?.wallsMs });
  }
  return units;
}

/** What a package-rooted run needs before it can say how many workers to open. */
interface WatchWorkerInputs extends WatchUnitScope {
  /** One ledger task's retained rows; this path asks for exactly one. */
  readonly readLedger: (task: string) => PoolLedger;
  /** The hardware ceiling. */
  readonly maxParallelism: number;
  /** Memory the projected peak must fit into; undefined where none could be read. */
  readonly memoryBudgetKb: number | undefined;
}

/**
 * How many workers this invocation opens, from what every vitest run on this
 * machine recorded and what this run is about to execute.
 *
 * One store, because one system measures every vitest invocation: a width this
 * path has never opened is still priced by a run that did open it, and a wall a
 * batch weighed a file at is the same wall here. What used to keep the two
 * apart was retention — a day of one-file runs evicting the batch's history —
 * and `scripts/lib/pool/ledger.ts` now ages a width on its own shape's runs, so
 * neither history reaches the other's.
 */
export function deriveWatchWorkers(inputs: WatchWorkerInputs): VitestWorkerDerivation {
  const recorded = inputs.readLedger(VITEST_LEDGER_TASK);
  return deriveVitestWorkers({
    maxParallelism: inputs.maxParallelism,
    files: watchUnits(recorded.tasks, inputs),
    observations: recorded.runs,
    memoryBudgetKb: inputs.memoryBudgetKb,
  });
}

/**
 * What this run says when it ended having collected no test file.
 *
 * A run that collected nothing and a run whose tests failed both leave vitest
 * exiting 1, and the line vitest prints for the first — that it found no test
 * files — reads, in the collected output of a many-runs-at-once proof, exactly
 * like a package that met a conflict. They are different findings: one is a
 * scoping or harness fault in which nothing was judged, the other is a verdict
 * on code. So the run names which of the two it was.
 */
export function emptyRunNotice(args: readonly string[]): string {
  return (
    `test:watch: this run collected no test file, so nothing ran and nothing was judged. That is ` +
    `an empty run, not a failing test: read it as a scoping or harness fault, never as a verdict ` +
    `on the code. What scoped the run: ${args.join(' ')}`
  );
}

/** The seams the empty-run verdict reads, and the one it speaks through. */
export interface WatchRunDeps {
  /**
   * Names where vitest writes the json report the verdict reads, and collects
   * the reports dead runs left beside it. One call because the name carries
   * the owning run, so it cannot be minted after the file it attributes.
   */
  readonly claimReportFile: () => Promise<string>;
  /** The report at that path, or `undefined` when there is none to read. */
  readonly readReport: (file: string) => VitestJsonReport | undefined;
  /** Removes the report once the verdict above has read it. */
  readonly dropReport: (file: string) => void;
  readonly warn: (line: string) => void;
  /**
   * Starts measuring the run whose runner is `runnerPid`, for the ledger row it
   * will become, against the derivation the run was launched at.
   *
   * On every run this launcher starts rather than on the one-shot plan alone.
   * This launcher names reporters on its command line, and a named reporter
   * replaces the configured list wholesale, so the recorder the shared vitest
   * configuration declares never runs inside a runner started here: the row is
   * this seam's or there is none. A watch session's row spans the session
   * rather than any single re-run inside it, which is what the peak it carries
   * describes and what its shape says it is.
   *
   * The derivation arrives from the launch rather than being taken here, so the
   * count the row states as this run's is the count the run's command line
   * declared and not a second answer reached beside it.
   */
  readonly measure: (runnerPid: number, derivation: VitestWorkerDerivation) => RunMeasurement;
}

/** The seams and the plan a coverage run adds to the ordinary one. */
export interface CoverageRun {
  /**
   * The directory keyed to this run's claim, or `null` where the run holds
   * none. Null rather than a directory invented here: a run with no claim can
   * key nothing, and naming a directory anyway would leave one nothing
   * reclaims. Passing none lets the coverage-directory guard in vitest's own
   * global setup refuse the run and name the entry points that take a claim.
   */
  readonly reportsDirectory: string | null;
  /**
   * Package-relative globs naming the modules under test. This replaces the
   * package's own include rather than adding to it: the run measures what the
   * named test files cover, and the package's scope would put every unloaded
   * module in the map at zero.
   */
  readonly include: readonly string[];
  /** The package whose unfiltered run settles an inconclusive result. */
  readonly packageName: string;
  /**
   * The repository root. The empty-scope refusal is shared with the package
   * route and names its scope relative to the root, so this run's
   * package-relative globs are re-spelled from here before they reach it.
   */
  readonly rootDir: string;
  /** Records the directory against this run's claim, before anything creates it. */
  readonly claim: (reportsDirectory: string) => Promise<void>;
  readonly readMap: (reportsDirectory: string) => Readonly<Record<string, unknown>> | undefined;
  /** Removes this run's own directory once the verdict below has read it. */
  readonly drop: (reportsDirectory: string) => void;
  /** Where the verdict is written, which is stdout rather than the warning channel. */
  readonly report: (line: string) => void;
}

/** How many of this run's test files failed, which is what makes its map partial. */
function failedTestFileCount(report: VitestJsonReport | undefined): number {
  return (report?.testResults ?? []).filter((result) => result.status === 'failed').length;
}

/**
 * What this run established about coverage, from the artifacts it left.
 *
 * The artifacts are asked about before the tests are: the runner writes its
 * coverage map even for a run whose tests failed, so a red run now has figures
 * to show, and asking about the failure first would answer every later question
 * by a fact that is no longer true. A failure is still asked ahead of the
 * thresholds, because the threshold question is read off vitest's exit code —
 * vitest's per-file thresholds are this repository's one statement of what a
 * passing figure is, and a second one here would be free to disagree with it —
 * and a failing test has already claimed that code.
 */
function coverageOutcome(
  exitCode: number,
  report: VitestJsonReport | undefined,
  coverageMap: Readonly<Record<string, unknown>> | undefined,
  coverageInclude: readonly string[]
): CoverageOutcome {
  if (coverageMap === undefined) {
    return 'not-evaluated';
  }
  if (Object.keys(coverageMap).length === 0) {
    return emptyMapOutcome(coverageInclude);
  }
  if (failedTestFileCount(report) > 0) {
    return 'tests-failed';
  }
  return exitCode === 0 ? 'thresholds-met' : 'thresholds-unmet';
}

/** The coverage flags this run adds to the ones the caller wrote. */
function coverageArguments(coverage: CoverageRun | undefined): readonly string[] {
  if (coverage === undefined) {
    return [];
  }
  const directory = coverage.reportsDirectory;
  return [
    COVERAGE_FLAG,
    ...(directory === null ? [] : [`${REPORTS_DIRECTORY_FLAG}=${directory}`]),
    ...coverage.include.map((glob) => `--coverage.include=${glob}`),
  ];
}

/**
 * Records the directory against this run's claim before anything creates it. A
 * claim naming a directory nothing made is harmless; the reverse order
 * produces an orphan by construction.
 */
async function claimCoverageDirectory(coverage: CoverageRun | undefined): Promise<void> {
  const directory = coverage?.reportsDirectory;
  if (coverage !== undefined && directory !== null && directory !== undefined) {
    await coverage.claim(directory);
  }
}

/**
 * Removes this run's own coverage directory. Drop before release: the verdict
 * has already read it and nothing outside this run reads it at all, so keeping
 * it would leave one directory per invocation for a later run to collect.
 */
function dropCoverageDirectory(coverage: CoverageRun | undefined): void {
  const directory = coverage?.reportsDirectory;
  if (coverage !== undefined && directory !== null && directory !== undefined) {
    coverage.drop(directory);
  }
}

/**
 * States what may be concluded from this run's coverage, on the caller's own
 * output channel, and answers with the code the run exits on. Called after
 * vitest has finished printing, so it is the last thing an operator reads —
 * vitest's own threshold lines name a shortfall without saying what it means.
 */
function reportLowerBound(
  coverage: CoverageRun,
  invocation: Invocation,
  exitCode: number,
  report: VitestJsonReport | undefined
): number {
  const directory = coverage.reportsDirectory;
  const coverageMap = directory === null ? undefined : coverage.readMap(directory);
  const outcome = coverageOutcome(exitCode, report, coverageMap, coverage.include);
  for (const line of lowerBoundReport({
    outcome,
    figures: coverageFigures(coverageMap ?? {}, invocation.cwd),
    failedTestFiles: failedTestFileCount(report),
    packageName: coverage.packageName,
    reportsDirectory: directory ?? '',
    coverageInclude: coverage.include,
    packageDir: invocation.cwd,
    rootDir: coverage.rootDir,
  })) {
    coverage.report(line);
  }
  return exitCodeFor(outcome, exitCode);
}

/**
 * Spawn vitest in the planned cwd; `preferLocal` picks the package's own binary.
 *
 * The worker count is declared here and nowhere else in the run: it is settled
 * before the runner starts and held for as long as the runner lives, so a watch
 * session's re-runs all execute in the pool the first launch opened. The
 * command line carries nothing about the pool or about file parallelism beside
 * it, for the reason `scripts/test-batch.ts` states at its own launch: the
 * shared configuration declares one fork per test file, and an override of
 * either is what would bypass that declaration.
 *
 * The json reporter rides alongside the default one rather than replacing it —
 * the console output is what the operator reads, and the report is the only
 * thing that says afterwards how many test files the run actually collected.
 *
 * A coverage run is one shot rather than a watcher: a coverage figure is read
 * once, and a watcher would hold the directory it claimed open indefinitely.
 */
export async function runVitest(
  invocation: Invocation,
  derivation: VitestWorkerDerivation,
  deps: WatchRunDeps,
  coverage?: CoverageRun
): Promise<number> {
  const reportFile = await deps.claimReportFile();
  await claimCoverageDirectory(coverage);
  const subcommand = coverage === undefined ? [] : ['run'];
  const child = await spawnLongLived(
    'vitest',
    [
      ...subcommand,
      `--maxWorkers=${String(derivation.workers)}`,
      ...invocation.args,
      ...coverageArguments(coverage),
      '--reporter=default',
      '--reporter=json',
      `--outputFile.json=${reportFile}`,
    ],
    {
      stdio: 'inherit',
      preferLocal: true,
      localDir: invocation.cwd,
      cwd: invocation.cwd,
      // Vitest binds no port the allocator hands out, so there is none to claim.
      ports: [],
    }
  );
  const measurement = deps.measure(child.pid, derivation);
  try {
    const exitCode = await child.exit;
    const report = deps.readReport(reportFile);
    measurement.record(report);
    // The report's own list of the files it ran is the evidence, and its
    // absence is not: a run killed before it wrote one collected an unknown
    // number of files, which is a different thing from having collected none.
    if (exitCode !== 0 && report?.testResults?.length === 0) {
      deps.warn(emptyRunNotice(invocation.args));
    }
    if (coverage !== undefined) {
      return reportLowerBound(coverage, invocation, exitCode, report);
    }
    return exitCode;
  } finally {
    // Drop before release. The verdict above is the report's only reader, so
    // keeping it would leave one file per watch session for a later run to
    // collect.
    deps.dropReport(reportFile);
    dropCoverageDirectory(coverage);
  }
}

/* v8 ignore start -- CLI entry point exercised via package.json scripts */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    const rootDir = path.resolve(scriptDir, '..');
    loadEnvironment(rootDir);
    process.env['NODE_OPTIONS'] = appendNodeOption(process.env['NODE_OPTIONS'], NODE_OPTION_FLAG);

    const fs: WatchFs = {
      isFile: (p) => existsSync(p) && statSync(p).isFile(),
      isDirectory: (p) => existsSync(p) && statSync(p).isDirectory(),
      listDirectory: (dir) => readdirSync(dir),
      hasPackageJson: (dir) => existsSync(path.join(dir, 'package.json')),
    };
    const request = splitCoverageRequest(process.argv.slice(2));
    const invocation = planInvocation(request.rest, process.cwd(), fs);
    const fingerprint = machineFingerprint();
    // Once, here, and held: the same figure reaches the runner on its command
    // line and the ledger as the count this run declared.
    const derivation = deriveWatchWorkers({
      repoRoot: rootDir,
      packageDir: invocation.cwd,
      paths: invocation.paths,
      isDirectory: fs.isDirectory,
      readLedger: (task) => readLedger(ledgerPath(rootDir, fingerprint, task)),
      maxParallelism: os.availableParallelism(),
      memoryBudgetKb: memoryBudgetKb(PLANNING_MEMORY_FRACTION),
    });

    const coverageRun = (): CoverageRun => {
      const runId = currentRunId();
      const manifest = JSON.parse(
        readFileSync(path.join(invocation.cwd, 'package.json'), 'utf8')
      ) as { name: string };
      const reportsDirectory = runId === null ? null : runCoverageDirectory(invocation.cwd, runId);
      return {
        reportsDirectory,
        include: coverageIncludeFor(
          modulesUnderTest(
            {
              sources: request.sources,
              testFiles: invocation.paths,
              invocationDir: process.cwd(),
              packageDir: invocation.cwd,
            },
            fs
          ),
          invocation.cwd
        ),
        packageName: manifest.name,
        rootDir,
        claim: async (directory) => {
          const { unowned } = await claimAndReclaimCoverage(directory);
          if (unowned.length > 0) {
            console.warn(
              `coverage directories no run claim accounts for, left standing: ${unowned.join(', ')}`
            );
          }
        },
        readMap: (directory) => {
          const file = path.join(directory, 'coverage-final.json');
          return existsSync(file)
            ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>)
            : undefined;
        },
        drop: removeCoverageDirectory,
        report: (line) => {
          console.log(line);
        },
      };
    };

    const deps: WatchRunDeps = {
      claimReportFile: () => claimReportFile(),
      readReport: (file) =>
        existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as VitestJsonReport) : undefined,
      dropReport: dropReportFile,
      warn: (line) => {
        console.warn(line);
      },
      measure: (runnerPid, launched) =>
        measureVitestRun(runnerPid, {
          // The tree measured is this process's rather than the runner's:
          // everything this command spawns descends from here, and the workers
          // charged inside that tree are the runner's own children, which
          // leaves this wrapper itself in the fixed cost where it belongs.
          track: (pid) =>
            trackRunSplit({
              treeRootPid: process.pid,
              runnerPid: pid,
              intervalMs: PSS_SAMPLE_INTERVAL_MS,
            }),
          record: (record, files) => recordVitestRun(rootDir, fingerprint, record, files),
          repoRoot: rootDir,
          machineEvents: readMachineMemoryEvents,
          derivation: launched,
          // A one-shot coverage run is package-rooted and files under the shape
          // package-rooted runs have always filed under; a watch session is
          // neither one shot nor one run, and files under the shape the shared
          // configuration's own reporter stamps the runs it reaches.
          shape: request.coverage ? 'package' : 'watch',
          report: (line) => {
            console.log(line);
          },
          warn: (line) => {
            console.warn(line);
          },
        }),
    };

    // Registered here rather than left to whatever started this: a watcher sits
    // on the stack for as long as someone leaves it open, and an unregistered
    // one is a stack torn down underneath it. Run through `with-env`, which
    // registers first, this adopts that run instead of taking a second claim.
    return withRunClaim(
      {
        command: request.coverage ? 'vitest --coverage' : 'vitest --watch',
        mode: stackModeFrom(process.env),
        rootDir,
      },
      () =>
        // The runner's dependency optimizer writes into its cache directory
        // while it builds its project servers, before any of our code runs
        // inside it — so the claim on that directory is taken around the start
        // rather than beside it.
        withRunnerCacheClaim(
          {
            repoRoot: rootDir,
            projectRoot: invocation.cwd,
            processId: process.pid,
            env: process.env,
            now: Date.now(),
          },
          () =>
            // The coverage plan is built inside the claim, because the
            // directory it names is keyed to it.
            request.coverage
              ? runVitest(invocation, derivation, deps, coverageRun())
              : runVitest(invocation, derivation, deps)
        )
    );
  });
}
/* v8 ignore stop */
