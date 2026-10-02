import path from 'node:path';

import type { VitestJsonReport } from '../test-run/test-report.js';

export function underDirectory(absoluteFile: string, dir: string): boolean {
  const prefix = dir.endsWith(path.sep) ? dir : `${dir}${path.sep}`;
  return absoluteFile.startsWith(prefix);
}

/**
 * Whether a package came out of a run with no file measured at all — the one
 * vacuous case, which vitest reports as a clean 0/0 and exits 0 on.
 *
 * This is the single implementation both run modes judge through: the scoped
 * solo run passes its own directory over a map holding only its own files, the
 * consolidated batch passes each package's directory over the shared map. They
 * have to agree, or the invariant becomes a property of which mode you happened
 * to run, so they are not allowed to be two functions.
 *
 * A file measured at 0% is still a measured file: an include matching at least
 * one file puts it in the map whether or not a test exercised it, so absence
 * from the map means the scope reached nothing, not that the tests were thin.
 */
export function measuredNoFile(
  coverageMap: Readonly<Record<string, unknown>>,
  packageDir: string
): boolean {
  return !Object.keys(coverageMap).some((file) => underDirectory(file, packageDir));
}

/**
 * The operator-facing line a package's empty coverage scope fails its run with,
 * shared by both modes for the same reason the predicate is.
 *
 * It states the fact and names the scope rather than prescribing a cause:
 * `loadPackageCoverageGlobs` already refuses, before vitest starts, an include
 * that declares nothing or resolves to no file on disk, so a scope that reaches
 * here resolved statically and stopped measuring for some subtler reason.
 */
export function emptyCoverageScopeReason(coverageInclude: readonly string[]): string {
  return `EMPTY COVERAGE SCOPE — this run measured no file, so its green verdict proves nothing; the scope in force was (${coverageInclude.join(', ')}), relative to the repo root.`;
}

/**
 * The operator-facing line a run states when it produced no coverage map at
 * all, so nothing was judged against the coverage thresholds.
 *
 * The condition is the artifact's absence, deliberately, rather than any
 * account of how a run ended early: a crashed worker, a deleted reports
 * directory and a future release's own reasons all land the same way, and a
 * rule enumerating them is falsified by the next member of the list. "No map,
 * no judgement" survives all of them.
 *
 * It has to be said out loud because nothing else announces it: a verdict that
 * judged no coverage at all reads exactly like a coverage pass.
 */
export function coverageNotEvaluatedReason(reportsDirectory: string): string {
  return `COVERAGE NOT EVALUATED — this run wrote no coverage map into ${reportsDirectory}, so no file was measured against the coverage thresholds; its verdict is silent about coverage rather than green on it.`;
}

/**
 * The operator-facing line a run states when its coverage numbers were
 * measured over a suite that did not finish.
 *
 * The runner writes its coverage map even when a test file fails
 * (`coverage.reportOnFailure`), so a red run now yields figures where it used
 * to yield none. Those figures are real but short: a test that failed stopped
 * where it failed, so every line it would have reached after that point is
 * missing from them, and a reader who cannot tell this run from a complete one
 * reads a shortfall as a coverage regression.
 *
 * The count is in the sentence rather than a bare "some files failed" because
 * it is what tells a reader whether the figures are nearly whole or barely
 * measured at all.
 */
export function partialCoverageReason(failedFileCount: number): string {
  const files = failedFileCount === 1 ? '1 test file' : `${String(failedFileCount)} test files`;
  return `PARTIAL COVERAGE — ${files} failed in this run, so these coverage numbers were measured over a suite that did not finish: whatever a failing test would have reached past the point it failed is missing from them.`;
}

/**
 * Whether a run executed no test file under one package's directory.
 *
 * The single implementation both run modes gate on: the scoped solo run passes
 * its own directory over a report holding only its own files, the consolidated
 * batch passes each package's directory over the shared report. A package the
 * solo gate would have failed and the batch gate would have passed is the
 * defect this shape exists to make impossible, exactly as {@link measuredNoFile}
 * does for the coverage scope beside it.
 *
 * A report carrying no test-result list is judged the same way: it is not
 * evidence that anything ran. An absent report is a different state and is not
 * this predicate's to judge — a run killed before it wrote one collected an
 * unknown number of files, so its caller returns before reaching here.
 */
export function collectedNoTestFile(report: VitestJsonReport, packageDir: string): boolean {
  return !(report.testResults ?? []).some(
    (entry) => entry.name !== undefined && underDirectory(entry.name, packageDir)
  );
}

/**
 * The operator-facing line a package's empty test collection fails its run
 * with, shared by both modes for the same reason the predicate is.
 *
 * Direction is what earns this its own gate beside the coverage ones: a run
 * that executed nothing still writes a map of every included file at 0%, so
 * neither neighbour fires, and a package that ran nothing comes out `ok` — a
 * verdict the task runner then caches under that package's input hash, which
 * outlives the run that made it.
 *
 * It states the fact and names the scope rather than prescribing a cause, for
 * the reason {@link coverageNotEvaluatedReason} gives: a rule enumerating the
 * ways a collection comes back empty is falsified by the next member of the
 * list — a package whose suite is not written yet is neither a scoping fault
 * nor a harness one. What survives every cause is that nothing was judged.
 *
 * The package is named by the line prefix both modes already write, so naming
 * it again here would print it twice.
 */
export function noTestFilesCollectedReason(): string {
  return `NO TEST FILES COLLECTED — no test file under this package's directory was executed, so this run's verdict proves nothing about it.`;
}
