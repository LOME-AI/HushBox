import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  collectedNoTestFile,
  coverageNotEvaluatedReason,
  emptyCoverageScopeReason,
  measuredNoFile,
  noTestFilesCollectedReason,
  partialCoverageReason,
  underDirectory,
} from '../vitest/coverage-scope.js';
import {
  POLE_MAJORITY_SHARE,
  POLE_MIN_MS,
  detectPoles,
  failedFilesForDirectory,
  reportForDirectory,
  type VitestJsonReport,
} from './test-report.js';
import type { OffsetScanResult } from '../vitest/coverage-offset-detector.js';

/**
 * Per-package judgement over one consolidated vitest run. Every signal the
 * per-package solo run gates on is attributed here by file path → package
 * directory, because a signal `scripts/run-package-tests.ts` raises and this
 * one does not is a batched package passing where its own solo run would have
 * failed. The exit code is one fact about the whole batch, so a non-zero exit
 * fails every package this run attributed no failure to — a conservative
 * verdict is a rerun, a generous one is a poisoned cache entry.
 */

interface BatchedPackage {
  readonly package: string;
  /** Absolute package directory. */
  readonly dir: string;
  /** The repo-root-relative coverage scope this package was measured under. */
  readonly coverageInclude: readonly string[];
}

interface VerdictInput {
  readonly repoRoot: string;
  readonly packages: readonly BatchedPackage[];
  readonly vitestExitCode: number;
  /** The run's jest-shaped json report; `undefined` when it was not written. */
  readonly report: VitestJsonReport | undefined;
  /** The vitest process's stderr, where threshold errors are printed. */
  readonly errorOutput: string;
  /** The coverage-offset scan's findings; `undefined` when the scan never ran. */
  readonly offsetDivergences: OffsetScanResult | undefined;
  /**
   * The run's coverage map, keyed by absolute file path; `undefined` when the
   * run wrote none. Required rather than optional so that a caller must decide:
   * a field a caller can silently omit is a guard that silently stops running,
   * which is the defect this input exists to close.
   */
  readonly coverageMap: Readonly<Record<string, unknown>> | undefined;
  /** Where the run was told to write that map, named when none arrived. */
  readonly coverageReportsDirectory: string;
}

interface PackageVerdict {
  readonly ok: boolean;
  readonly reasons: readonly string[];
}

const THRESHOLD_LINE = /does not meet .*threshold \([\d.]+%\) for (?<file>\S+)/g;

/** Repo-root-relative paths named by per-file coverage-threshold errors. */
export function parseThresholdFailures(errorOutput: string): readonly string[] {
  const files: string[] = [];
  for (const match of errorOutput.matchAll(THRESHOLD_LINE)) {
    const file = match.groups?.['file'];
    if (file) {
      files.push(file);
    }
  }
  return files;
}

/** A divergence's url as an absolute file path; non-file urls attribute nowhere. */
function divergencePath(url: string): string | undefined {
  try {
    return url.startsWith('file://') ? fileURLToPath(url) : undefined;
  } catch {
    return undefined;
  }
}

/** The offset divergences that attribute to one package's directory. */
function divergenceReasons(offsetDivergences: OffsetScanResult | undefined, dir: string): string[] {
  const reasons: string[] = [];
  for (const divergence of offsetDivergences ?? []) {
    const file = divergencePath(divergence.url);
    if (file !== undefined && underDirectory(file, dir)) {
      reasons.push(`coverage-offset divergence: ${divergence.url}`);
    }
  }
  return reasons;
}

function packageReasons(
  package_: BatchedPackage,
  input: VerdictInput & { readonly report: VitestJsonReport },
  thresholdFiles: readonly string[]
): string[] {
  const { dir } = package_;
  const { report, coverageMap, offsetDivergences } = input;
  const reasons: string[] = [];
  // First: a package that executed nothing has no verdict about its tests, so
  // it changes what every reason after it means. Neither coverage signal below
  // covers the case — an include matching a file puts it in the map whether or
  // not a test ran it, and one union scope lets another package's tests carry
  // these files past their thresholds with no threshold error to attribute.
  if (collectedNoTestFile(report, dir)) {
    reasons.push(noTestFilesCollectedReason());
  }
  // Then: a package that measured nothing explains why no threshold error was
  // printed for it, so it reads better ahead of the failures that did attribute.
  if (coverageMap !== undefined && measuredNoFile(coverageMap, dir)) {
    reasons.push(emptyCoverageScopeReason(package_.coverageInclude));
  }
  const failedFiles = failedFilesForDirectory(report, dir);
  for (const file of failedFiles) {
    reasons.push(`failed test file: ${file}`);
  }
  // Between the failures and the coverage findings, because it is the sentence
  // that says what those findings are worth: a package whose suite stopped
  // early was measured over less code than it runs, so a shortfall below may be
  // the failure's shadow rather than a regression.
  if (failedFiles.length > 0) {
    reasons.push(partialCoverageReason(failedFiles.length));
  }
  for (const file of thresholdFiles) {
    if (underDirectory(file, dir)) {
      reasons.push(`coverage threshold not met: ${file}`);
    }
  }
  const poles = detectPoles(reportForDirectory(report, dir), {
    minMs: POLE_MIN_MS,
    majorityShare: POLE_MAJORITY_SHARE,
  });
  for (const pole of poles) {
    const seconds = (pole.wallMs / 1000).toFixed(1);
    const percent = (pole.share * 100).toFixed(0);
    reasons.push(
      `POLE TEST FILE — split it into smaller test files: ${pole.file} — ${seconds}s (${percent}% of package test-work)`
    );
  }
  reasons.push(...divergenceReasons(offsetDivergences, dir));
  return reasons;
}

/**
 * The reason every package in the batch carries when the run wrote no coverage
 * map, and nothing when it wrote one.
 *
 * One map covers the whole batch, so its absence attributes to no package and
 * disqualifies every verdict: without it, a package with no failing test of its
 * own comes out `ok` and turbo caches that under its input hash, which retires
 * coverage for that input until the input changes. It leads a package's reasons
 * because it changes what the reasons after it mean.
 */
function unevaluatedCoverageReasons(input: VerdictInput): readonly string[] {
  if (input.coverageMap !== undefined) {
    return [];
  }
  return [coverageNotEvaluatedReason(input.coverageReportsDirectory)];
}

/**
 * The reason one package carries when the run exited non-zero and
 * {@link packageReasons} attributed no failure to it.
 *
 * The exit code is one fact about the whole batch, so another package's
 * recognised failure explains the exit while saying nothing about this one: a
 * failure whose shape no check in {@link packageReasons} recognises leaves its
 * package looking clean. Asking instead whether ANY package was attributed lets
 * one recognised failure certify every other package in the batch, which is the
 * generous verdict that caches as a pass. The cost of asking per package is that
 * a batch with one failing package caches no pass for its neighbours — a rerun,
 * which is the trade this module's header states.
 */
function unexplainedExitReasons(
  input: VerdictInput,
  package_: BatchedPackage,
  attributed: readonly string[]
): readonly string[] {
  if (input.vitestExitCode === 0 || attributed.length > 0) {
    return [];
  }
  return [
    `batched vitest exited ${String(input.vitestExitCode)} with no failure attributed to ${package_.package}`,
  ];
}

export function computeVerdicts(input: VerdictInput): Map<string, PackageVerdict> {
  const verdicts = new Map<string, PackageVerdict>();
  const unevaluated = unevaluatedCoverageReasons(input);
  if (input.report === undefined) {
    for (const package_ of input.packages) {
      verdicts.set(package_.package, {
        ok: false,
        reasons: [...unevaluated, 'batched vitest run produced no json report'],
      });
    }
    return verdicts;
  }

  const thresholdFiles = parseThresholdFailures(input.errorOutput).map((file) =>
    path.resolve(input.repoRoot, file)
  );
  const known = { ...input, report: input.report };
  for (const package_ of input.packages) {
    const attributed = packageReasons(package_, known, thresholdFiles);
    const reasons = [
      ...unevaluated,
      ...attributed,
      ...unexplainedExitReasons(input, package_, attributed),
    ];
    verdicts.set(package_.package, { ok: reasons.length === 0, reasons });
  }
  return verdicts;
}
