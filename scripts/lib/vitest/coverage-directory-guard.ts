import path from 'node:path';

import { coverageDirectoryRunId } from '../../run-package-tests.js';
import { COVERAGE_RUN_ROUTES } from '../test-run/test-routes.js';

/**
 * The refusal a coverage run earns when it would write a coverage directory
 * that is not keyed to its own claim.
 *
 * The runners key every coverage directory to the run holding it, because
 * vitest's v8 provider deletes the reports directory and its `.tmp` scratch at
 * both ends of a run: two runs sharing one directory delete each other's
 * intermediate dumps, and the losing run dies on a missing `.tmp` with every
 * test passed and no `FAIL` line — a failure that reads as a healthy run.
 *
 * That keying is applied by the runners, so an invocation that reaches vitest
 * another way — `vitest run --coverage` in a package directory — inherits the
 * package's own default and writes the shared path with nothing to stop it.
 * This is what stops it: the guard runs from vitest's own global setup, which
 * every invocation through the shared config loads, so there is no path around
 * it. Refusing is the whole answer here rather than substituting a directory:
 * global setup cannot change the coverage configuration a run already resolved.
 */
export interface CoverageDirectoryRequest {
  /** Whether this run measures coverage at all. */
  readonly enabled: boolean;
  /** The absolute directory the resolved coverage configuration names. */
  readonly reportsDirectory: string;
  /** The run holding this process's claim, or `null` where it holds none. */
  readonly runId: string | null;
}

export function coverageDirectoryRefusal(request: CoverageDirectoryRequest): string | undefined {
  if (!request.enabled) {
    return undefined;
  }
  if (request.runId === null) {
    return (
      'NO RUN CLAIM — this coverage run holds no claim, so its coverage directory can be ' +
      'neither isolated from a concurrent run nor reclaimed if this run is killed. ' +
      `${COVERAGE_RUN_ROUTES}; both take the claim in with-env before vitest starts.`
    );
  }
  if (coverageDirectoryRunId(path.basename(request.reportsDirectory)) === request.runId) {
    return undefined;
  }
  return (
    `SHARED COVERAGE DIRECTORY — this coverage run would write ${request.reportsDirectory}, ` +
    `which is not the directory its own claim keys (run-${request.runId}). A concurrent run ` +
    'writing there deletes this run’s intermediate dumps and kills it with every test ' +
    'passed and no FAIL line, so this run refused instead. ' +
    `${COVERAGE_RUN_ROUTES}; both pass the run-scoped directory.`
  );
}

/** The part of a resolved coverage configuration a raised refusal has to disarm. */
export interface CoverageReportPlan {
  /** The report writers the runner executes at shutdown. */
  reporter: readonly unknown[];
}

/**
 * Drop the reports a refused run would otherwise write.
 *
 * {@link coverageDirectoryRefusal} cannot prevent that write by happening
 * earlier, because the runner reports coverage from a `finally` around the whole
 * run: global setup throwing is an unhandled error rather than a failed test, so
 * the shutdown path reaches the reporters with an empty coverage map and the
 * JSON reporter lands `coverage-final.json` at the very directory the refusal
 * turned the run away from. Emptying the reporter list is what leaves
 * nothing, and it needs no cleanup of its own: the provider removes its own
 * reports directory after reporting whenever nothing wrote into it.
 */
export function cancelCoverageReports(coverage: CoverageReportPlan): void {
  coverage.reporter = [];
}
