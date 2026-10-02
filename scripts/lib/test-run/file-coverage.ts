import path from 'node:path';

/**
 * The percentage below is the coverage library's own definition rather than
 * arithmetic spelled here, so a figure this file prints and the table vitest
 * prints above it are one measurement: truncation to two decimals, and a file
 * holding none of a metric reading as complete on it, both come from it. A
 * second spelling — the algebraically equal `(covered / total) * 10_000`
 * included — reads to the same reader as a second, disagreeing measurement.
 */
import percent from 'istanbul-lib-coverage/lib/percent.js';

import {
  coverageNotEvaluatedReason,
  emptyCoverageScopeReason,
  partialCoverageReason,
} from '../vitest/coverage-scope.js';

/**
 * What a coverage run over named test files may be concluded from, and how it
 * says so.
 *
 * Coverage from such a run is partial by construction: only the named files
 * ran, so every line another test file exercises is absent from the map and a
 * well-covered module can read near zero. The figures are therefore a LOWER
 * BOUND — coverage is monotone in test files, since running more of them can
 * only add executed lines — and the two directions are not symmetric. At or
 * above the per-file thresholds the question is settled, because no further
 * test file can lower the figure. Below them nothing is settled: the tests may
 * be short, or another file may cover the rest, and this run cannot tell those
 * apart. A bare percentage printed here reads as a verdict on the module and
 * is wrong in exactly the second case.
 */

/** The flag naming the module under test where it is not the test file's sibling. */
export const SOURCE_FLAG = '--source';

/**
 * The module a test file covers, derived from this repository's colocation
 * rule: the test sits beside what it tests, under the same name.
 *
 * The listing is what the answer is drawn from rather than a list of
 * extensions and test-name markers spelled here, which would be a second
 * spelling of both. A sibling qualifies when the test file's name, with its
 * own extension and then one trailing segment at a time removed, leaves a stem
 * the sibling extends by exactly one extension — so `payments.ts` answers for
 * `payments.integration.test.ts` while `payments.fixtures.ts` does not, and
 * the test file never answers for itself.
 */
export function moduleUnderTest(testFile: string, siblingNames: readonly string[]): string {
  const dir = path.dirname(testFile);
  const name = path.basename(testFile);
  const ownExtension = path.extname(name);
  let stem = name.slice(0, name.length - ownExtension.length);
  for (;;) {
    const matches = siblingNames
      .filter(
        (sibling) =>
          sibling !== name &&
          sibling.startsWith(`${stem}.`) &&
          !sibling.slice(stem.length + 1).includes('.')
      )
      .toSorted((left, right) => left.localeCompare(right));
    const preferred = matches.find((sibling) => path.extname(sibling) === ownExtension);
    const answer = preferred ?? matches[0];
    if (answer !== undefined) {
      return path.join(dir, answer);
    }
    const cut = stem.lastIndexOf('.');
    if (cut === -1) {
      throw new Error(
        `test:file: no module sits beside ${name} under a name it extends, so there is nothing ` +
          `for this run to measure. Name the module under test with \`${SOURCE_FLAG} <path>\`, or ` +
          `measure the whole package with \`pnpm test:pkg <package>\`.`
      );
    }
    stem = stem.slice(0, cut);
  }
}

/** The disk the scope below reads, injected so its refusals are testable. */
export interface ModuleFs {
  readonly isFile: (p: string) => boolean;
  readonly isDirectory: (p: string) => boolean;
  readonly listDirectory: (dir: string) => readonly string[];
}

/** What a command line asked to be measured, before it is resolved to modules. */
interface ModuleScope {
  /** Modules named explicitly, as the caller spelled them. */
  readonly sources: readonly string[];
  /** The positional test files the planner resolved, absolute. */
  readonly testFiles: readonly string[];
  /** What the caller's own spellings resolve against, and refusals are named from. */
  readonly invocationDir: string;
  /**
   * The package vitest will run from, which its coverage include is resolved
   * against. Required rather than derived here: only the planner knows which
   * package the named test files landed in, and a scope that guessed it would
   * decide measurability from a different package than the run uses.
   */
  readonly packageDir: string;
}

/** One module as vitest's include spells it: package-relative, and posix because its matcher reads only `/`. */
function includeGlob(module: string, packageDir: string): string {
  return path.relative(packageDir, module).split(path.sep).join('/');
}

/**
 * Whether an include glob names a file outside the package it is resolved
 * against, which vitest can therefore never match however the run goes.
 */
function outsidePackage(coverageGlob: string): boolean {
  return coverageGlob.startsWith('../');
}

/** A module the caller named, beside the spelling a refusal has to name it back with. */
interface NamedModule {
  readonly spelling: string;
  readonly module: string;
}

/**
 * Refuses a scope in which some named modules would be measured and the rest
 * could not be, which is the shape a verdict nobody asked for is reported on:
 * the measurable ones carry the run to figures and a threshold verdict, while
 * the others are absent from it with nothing saying so.
 *
 * A scope no part of which can be measured is left alone deliberately. That run
 * reaches vitest, produces an empty map, and is refused by the empty-scope
 * route, which names the whole scope — so refusing it here as well would be a
 * second mechanism for one fault, and the worse-placed of the two.
 */
function rejectSubstitutedScope(named: readonly NamedModule[], packageDir: string): void {
  const unmeasurable = named.filter(({ module }) =>
    outsidePackage(includeGlob(module, packageDir))
  );
  if (unmeasurable.length === 0 || unmeasurable.length === named.length) {
    return;
  }
  throw new Error(
    `test:file: ${SOURCE_FLAG} names ${unmeasurable.map((entry) => entry.spelling).join(', ')} ` +
      `outside the package this run measures, and vitest resolves its coverage include against ` +
      `that package, so no figure for it can exist — while the rest of this scope would get one. ` +
      `The run would have reported a verdict on a scope you did not name. Measure it from the ` +
      `package it belongs to, or name it on its own and this run says its scope reached nothing.`
  );
}

/**
 * The modules a coverage run measures: the sibling of each named test file, or
 * the modules named explicitly, which replace the derivation rather than adding
 * to it.
 *
 * Here rather than at the entry point because each of its refusals decides
 * what a run measures, and an entry point is excluded from measurement: a
 * scope decision left there is a decision no test watches.
 */
export function modulesUnderTest(scope: ModuleScope, fs: ModuleFs): readonly string[] {
  if (scope.sources.length > 0) {
    const named = scope.sources.map((spelling) => {
      const module = path.resolve(scope.invocationDir, spelling);
      if (!fs.isFile(module)) {
        throw new Error(`test:file: ${SOURCE_FLAG} names no file: ${spelling}`);
      }
      return { spelling, module };
    });
    rejectSubstitutedScope(named, scope.packageDir);
    return named.map((entry) => entry.module);
  }
  if (scope.testFiles.length === 0) {
    throw new Error(
      'test:file: name the test files to measure. It scopes coverage to the modules those ' +
        'files cover; `pnpm test:pkg <package>` measures a whole package.'
    );
  }
  return scope.testFiles.map((file) => {
    if (fs.isDirectory(file)) {
      throw new Error(
        `test:file: ${path.relative(scope.invocationDir, file)} is a directory. Name the test ` +
          `files themselves, or measure the whole package with \`pnpm test:pkg <package>\`.`
      );
    }
    return moduleUnderTest(file, fs.listDirectory(path.dirname(file)));
  });
}

/**
 * The include globs a coverage run over named test files is narrowed to,
 * package-relative and in posix spelling — vitest resolves an include against
 * the project root, which is the package directory this runs from, and matches
 * it with a glob matcher that reads only `/`.
 *
 * Named once however many test files reached the same module: a repeated
 * include measures nothing twice, but the list is printed in the empty-scope
 * refusal, where a repetition reads as two different scopes.
 */
export function coverageIncludeFor(
  modules: readonly string[],
  packageDir: string
): readonly string[] {
  return [...new Set(modules.map((module) => includeGlob(module, packageDir)))];
}

/** One measured file's four coverage metrics, as percentages. */
export interface CoverageFigure {
  /** The measured file, relative to the package the run was scoped to. */
  readonly file: string;
  readonly statements: number;
  readonly branches: number;
  readonly functions: number;
  readonly lines: number;
}

/** One istanbul-shaped file entry, reduced to the counters the figures read. */
interface FileCoverageEntry {
  readonly s?: Readonly<Record<string, number>>;
  readonly f?: Readonly<Record<string, number>>;
  readonly b?: Readonly<Record<string, readonly number[]>>;
  readonly statementMap?: Readonly<Record<string, { readonly start?: { readonly line?: number } }>>;
}

function hitRatio(counters: Readonly<Record<string, number>> = {}): number {
  const values = Object.values(counters);
  return percent(values.filter((count) => count > 0).length, values.length);
}

/**
 * Lines from the statement map, the way every consumer of this format derives
 * them: a line carries the highest count of the statements starting on it, so
 * a line holding one executed statement is covered whatever sits beside it.
 */
function lineRatio(entry: FileCoverageEntry): number {
  const byLine = new Map<number, number>();
  for (const [id, statement] of Object.entries(entry.statementMap ?? {})) {
    const line = statement.start?.line;
    if (line === undefined) {
      continue;
    }
    const count = entry.s?.[id] ?? 0;
    byLine.set(line, Math.max(byLine.get(line) ?? 0, count));
  }
  const counts = [...byLine.values()];
  return percent(counts.filter((count) => count > 0).length, counts.length);
}

function branchRatio(branches: Readonly<Record<string, readonly number[]>> = {}): number {
  const arms = Object.values(branches).flat();
  return percent(arms.filter((count) => count > 0).length, arms.length);
}

/** Every measured file's figures, named relative to the package the run scoped to. */
export function coverageFigures(
  coverageMap: Readonly<Record<string, unknown>>,
  packageDir: string
): readonly CoverageFigure[] {
  return Object.entries(coverageMap)
    .map(([file, raw]) => {
      const entry = raw as FileCoverageEntry;
      return {
        file: path.relative(packageDir, file),
        statements: hitRatio(entry.s),
        branches: branchRatio(entry.b),
        functions: hitRatio(entry.f),
        lines: lineRatio(entry),
      };
    })
    .toSorted((left, right) => left.file.localeCompare(right.file));
}

/**
 * What this run established, in the six states an operator acts on
 * differently. They are kept apart from each other for the reason the package
 * runner keeps its own signals apart: a failing test, an absent map and a scope
 * that reached nothing are three different repairs. Only the last two carry a
 * threshold verdict — a failing run has figures but no verdict on them, because
 * the failure has already claimed the exit code that verdict is read off.
 */
export type CoverageOutcome =
  | 'tests-failed'
  | 'not-evaluated'
  | 'excluded-from-coverage'
  | 'measured-nothing'
  | 'thresholds-met'
  | 'thresholds-unmet';

/**
 * Which of the two empty-map outcomes a run landed in, from the scope it was
 * given.
 *
 * An empty map says the coverage configuration measured no file this run
 * scoped to, and there are two reasons for that an operator acts on
 * differently. A module inside the package the run measured exists on disk —
 * {@link modulesUnderTest} refuses one that does not — and a module vitest
 * measures appears in the map at 0% whether or not a test loaded it, verified
 * by running a source override over a module its test file never imports. So
 * absence there is the configuration declining to measure it, which for a
 * barrel is this repository's own deliberate ruling and nothing to act on. A
 * module outside that package could never have appeared whatever it holds, so
 * the run measured nothing because its scope was wrong — the fault the sibling
 * routes fail on.
 */
export function emptyMapOutcome(coverageInclude: readonly string[]): CoverageOutcome {
  return coverageInclude.some((glob) => outsidePackage(glob))
    ? 'measured-nothing'
    : 'excluded-from-coverage';
}

/**
 * The code the run exits with once its coverage verdict is in.
 *
 * A verdict can only add a failure, and it adds one wherever the run's own
 * line says the run proves nothing: a scope that measured no file, and a run
 * that wrote no coverage map at all. Both exit non-zero although vitest exited
 * clean, because a script reads the code and not the line, and both sibling
 * routes already fail the identical conditions — the package runner returns
 * non-zero for each, and the batch records each as a reason. An absent map
 * proves strictly less than a measured one below the thresholds, which exits
 * non-zero here, so it cannot be the greener of the two. The excluded case is
 * the one empty scope that is an answer rather than a fault, so it keeps the
 * code vitest gave it.
 */
export function exitCodeFor(outcome: CoverageOutcome, vitestExit: number): number {
  return outcome === 'measured-nothing' || outcome === 'not-evaluated'
    ? Math.max(vitestExit, 1)
    : vitestExit;
}

interface LowerBoundInput {
  readonly outcome: CoverageOutcome;
  readonly figures: readonly CoverageFigure[];
  /**
   * How many of this run's test files failed. Required rather than optional so
   * that a caller must decide: a run whose figures are short of what a finished
   * suite would have produced says so with this number in the sentence, and a
   * field a caller can silently omit is that sentence silently going missing.
   */
  readonly failedTestFiles: number;
  /** The package whose unfiltered run settles an inconclusive result. */
  readonly packageName: string;
  readonly reportsDirectory: string;
  /** The include globs vitest was given, relative to {@link LowerBoundInput.packageDir}. */
  readonly coverageInclude: readonly string[];
  /** The package the run was scoped to, which the include globs are relative to. */
  readonly packageDir: string;
  /** The repository root, which the empty-scope refusal names its scope from. */
  readonly rootDir: string;
}

/**
 * The include globs as paths from the repo root.
 *
 * The empty-scope refusal is shared with the package route and says the scope
 * it prints stands relative to the repo root, which is true of that route and
 * of no run scoped to a package: this command's globs are relative to the
 * package directory vitest ran from, so passing them through unchanged names a
 * path that exists nowhere. Re-spelling them here keeps the one wording both
 * routes state that refusal in and leaves the printed path resolvable from
 * where its reader stands.
 */
function fromRepoRoot(input: LowerBoundInput): readonly string[] {
  const prefix = path.relative(input.rootDir, input.packageDir).split(path.sep).join('/');
  return input.coverageInclude.map((glob) => path.posix.join(prefix, glob));
}

function metric(label: string, value: number): string {
  return `${label} ${String(value)}%`;
}

function figureLine(figure: CoverageFigure): string {
  return (
    `  ${figure.file} — ${metric('statements', figure.statements)}, ` +
    `${metric('branches', figure.branches)}, ${metric('functions', figure.functions)}, ` +
    metric('lines', figure.lines)
  );
}

/** The measured files and their figures, the body every judged outcome carries. */
function measuredLines(input: LowerBoundInput): readonly string[] {
  return [
    `COVERAGE LOWER BOUND — ${String(input.figures.length)} file(s) measured by the test files ` +
      'named on this command line:',
    ...input.figures.map((figure) => figureLine(figure)),
  ];
}

/**
 * The lines this run ends with, which are the only part of its output an agent
 * should act on. They come last so they are read after vitest's own threshold
 * lines, which name a shortfall without saying what may be concluded from one.
 */
export function lowerBoundReport(input: LowerBoundInput): readonly string[] {
  const settle = `\`pnpm test:pkg ${input.packageName}\`, the unfiltered package run`;
  if (input.outcome === 'tests-failed') {
    return [
      ...measuredLines(input),
      partialCoverageReason(input.failedTestFiles),
      'NO THRESHOLD VERDICT — this run reads the thresholds off vitest’s exit code, and the ' +
        'failing test has already claimed it, so the figures above settle nothing on their own. ' +
        'Fix the failing test and run this again.',
    ];
  }
  if (input.outcome === 'not-evaluated') {
    return [coverageNotEvaluatedReason(input.reportsDirectory)];
  }
  if (input.outcome === 'measured-nothing') {
    return [emptyCoverageScopeReason(fromRepoRoot(input))];
  }
  if (input.outcome === 'excluded-from-coverage') {
    return [
      'NOTHING TO MEASURE — this repository’s coverage configuration measures none of the ' +
        `modules this run scoped to (${fromRepoRoot(input).join(', ')}), so there is no coverage ` +
        'figure for them to have and nothing here left to settle; the tests above are this run’s ' +
        'whole verdict. A barrel is the common case: barrels hold exports only, so this ' +
        'repository leaves them out of coverage deliberately.',
    ];
  }
  const measured = measuredLines(input);
  if (input.outcome === 'thresholds-met') {
    return [
      ...measured,
      'CONCLUSIVE PASS — every file above meets this repository’s per-file coverage thresholds. ' +
        'These figures are a lower bound: only the named test files ran, and running more of them ' +
        'can only raise a figure, so no other test file can bring one of these below the ' +
        'threshold. The question is settled and nothing further is needed.',
    ];
  }
  return [
    ...measured,
    'INCONCLUSIVE — this run did not meet this repository’s per-file coverage thresholds, and ' +
      'that is not a verdict on the module. These figures are a lower bound: only the named test ' +
      'files ran, so every line another test file exercises is absent and a well-covered module ' +
      'can read near zero. Either the named tests are short or another test file covers the rest, ' +
      `and this run cannot tell which. Settle it with ${settle}.`,
  ];
}
