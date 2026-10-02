/**
 * Shared vocabulary over vitest's jest-shaped json report: the pole gate and
 * the per-package split a multi-package (consolidated) report needs before
 * per-package judgements can be made on it.
 */

export interface VitestJsonReport {
  readonly success?: boolean;
  readonly testResults?: readonly {
    readonly startTime?: number;
    readonly endTime?: number;
    readonly name?: string;
    readonly status?: string;
  }[];
}

// A "pole" is a single test file whose wall time single-handedly extends its
// package's test wall-clock (≈ max(longestFile, totalWork/workers)); the only
// fix is to split the file. The threshold is a strict majority of the package's
// total test-work plus an absolute floor, so a huge-but-balanced package trips
// nothing while a package dominated by one heavy file trips.
export const POLE_MIN_MS = 15_000;
export const POLE_MAJORITY_SHARE = 0.5;

interface Pole {
  readonly file: string;
  readonly wallMs: number;
  readonly share: number;
}

interface PoleThresholds {
  readonly minMs: number;
  readonly majorityShare: number;
}

type TestResultEntry = NonNullable<VitestJsonReport['testResults']>[number];

/**
 * A test-result entry reduced to `{ file, wallMs }`, or `undefined` when it has
 * missing/non-finite timestamps, a missing name, or non-positive wall time.
 */
function toWallEntry(
  entry: TestResultEntry
): { readonly file: string; readonly wallMs: number } | undefined {
  const { startTime, endTime, name } = entry;
  if (
    typeof startTime !== 'number' ||
    typeof endTime !== 'number' ||
    !Number.isFinite(startTime) ||
    !Number.isFinite(endTime) ||
    typeof name !== 'string'
  ) {
    return undefined;
  }
  const wallMs = endTime - startTime;
  return wallMs > 0 ? { file: name, wallMs } : undefined;
}

/** Sum wall time by file path — a file run under multiple vitest projects appears once per project. */
function aggregateWallByFile(report: VitestJsonReport): Map<string, number> {
  const wallByFile = new Map<string, number>();
  for (const entry of report.testResults ?? []) {
    const parsed = toWallEntry(entry);
    if (parsed !== undefined) {
      wallByFile.set(parsed.file, (wallByFile.get(parsed.file) ?? 0) + parsed.wallMs);
    }
  }
  return wallByFile;
}

function sumWallMs(wallByFile: ReadonlyMap<string, number>): number {
  let total = 0;
  for (const wallMs of wallByFile.values()) {
    total += wallMs;
  }
  return total;
}

/**
 * The mean wall of the files a report covered, reduced from the timestamps the
 * reporter already writes per file: what the run's work came to, per file.
 *
 * Absent rather than zero wherever the weight cannot be taken — no report
 * written, no file covered, or no entry carrying a usable timestamp pair —
 * because a run that weighed nothing and a run whose files cost nothing are
 * different facts, and every reader of this figure distinguishes them.
 */
export function perFileWallMs(report: VitestJsonReport | undefined): number | undefined {
  if (report === undefined) {
    return undefined;
  }
  const wallByFile = aggregateWallByFile(report);
  return wallByFile.size === 0 ? undefined : sumWallMs(wallByFile) / wallByFile.size;
}

/**
 * The total wall of the files a report covered — the run's whole test work, over
 * the same population {@link perFileWallMs} averages.
 *
 * Reported directly rather than left to be reconstructed from the mean and a
 * count, because the reporter writes an entry for a file it could not weigh —
 * one that failed to collect, or whose every test was skipped, both arriving
 * with equal timestamps — and such an entry is outside the mean's population
 * while sitting inside any count of what the reporter wrote. Multiplying the
 * two therefore reads high, one-sidedly, and by the most on a run that is
 * already failing.
 *
 * Absent rather than zero on the same three conditions as the mean.
 */
export function sumFileWallMs(report: VitestJsonReport | undefined): number | undefined {
  if (report === undefined) {
    return undefined;
  }
  const wallByFile = aggregateWallByFile(report);
  return wallByFile.size === 0 ? undefined : sumWallMs(wallByFile);
}

/**
 * Pole test files in a package's vitest json report. Wall time is aggregated by
 * file path first, then a file is a pole iff its total wall time is at least
 * `minMs` (the floor) AND a strict majority (`> majorityShare`) of the package's
 * total test-work. Returned sorted by wall time descending.
 */
export function detectPoles(report: VitestJsonReport, thresholds: PoleThresholds): readonly Pole[] {
  const wallByFile = aggregateWallByFile(report);
  const total = sumWallMs(wallByFile);
  if (total <= 0) {
    return [];
  }

  const poles: Pole[] = [];
  for (const [file, wallMs] of wallByFile) {
    if (wallMs >= thresholds.minMs && wallMs / total > thresholds.majorityShare) {
      poles.push({ file, wallMs, share: wallMs / total });
    }
  }
  return poles.toSorted((a, b) => b.wallMs - a.wallMs);
}

/**
 * The report reduced to the entries under one absolute package directory. The
 * pole gate's majority share is a per-package statement, so a consolidated
 * report must be split before poles can be judged.
 */
export function reportForDirectory(report: VitestJsonReport, dir: string): VitestJsonReport {
  const prefix = dir.endsWith('/') ? dir : `${dir}/`;
  return {
    testResults: (report.testResults ?? []).filter((entry) => entry.name?.startsWith(prefix)),
  };
}

/** Absolute file paths of failed test files under one absolute package directory. */
export function failedFilesForDirectory(report: VitestJsonReport, dir: string): readonly string[] {
  const prefix = dir.endsWith('/') ? dir : `${dir}/`;
  return (report.testResults ?? [])
    .filter((entry) => entry.status === 'failed' && entry.name?.startsWith(prefix))
    .map((entry) => entry.name ?? '');
}
