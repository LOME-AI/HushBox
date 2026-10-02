/**
 * Detects the one condition that makes a coverage run's numbers silently wrong.
 *
 * Vitest's v8 provider records, per test file, a raw V8 coverage object whose
 * every entry carries the `startOffset` of the module's code inside the
 * vite-node wrapper (`'use strict';async (…)=>{{`, 209 bytes today) — or 0 when
 * the module was loaded natively as an external. `generateCoverage` merges those
 * raw objects with `mergeProcessCovs`, which drops `startOffset`, then re-attaches
 * it from whichever raw file it happened to read last for that url. So when one
 * module is recorded under two different offsets in a single run, every range
 * contributed under the losing offset is remapped to the wrong source position:
 * the figures stay stable across reruns but describe the wrong lines, and the
 * arithmetic can produce impossible negative branch counts.
 *
 * Measured on vitest 4.1.10: a module reached by one suite inlined (offset 209)
 * and by another externalized (offset 0) reported an executed `return` statement
 * as never executed, while the same two suites with matching offsets reported it
 * correctly. Nothing about the merge announces this, which is why it is worth a
 * gate: the value here is attribution, not prevention.
 */

export interface RawCoverageEntry {
  readonly url: string;
  readonly startOffset?: number;
}

export interface RawCoverageFile {
  readonly result?: readonly RawCoverageEntry[];
}

/** One raw coverage file, paired with the on-disk name used when it names no test module. */
export interface NamedRawCoverage {
  readonly name: string;
  readonly file: RawCoverageFile;
}

export interface OffsetGroup {
  readonly startOffset: number;
  readonly testFiles: readonly string[];
}

export interface OffsetDivergence {
  readonly url: string;
  readonly offsets: readonly OffsetGroup[];
}

/** What one scan found — the payload the reporter hands the wrapper. */
export type OffsetScanResult = readonly OffsetDivergence[];

export interface RawCoverageFs {
  readonly readdir: (dir: string) => readonly string[];
  readonly readFile: (file: string) => string;
}

const TEST_MODULE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** How many test files are printed per offset before the rest are counted. */
const MAX_LISTED_TEST_FILES = 5;

/**
 * The test file a raw coverage object belongs to. Vitest keeps that mapping only
 * in memory, but a test file's own module is always one of the entries in the
 * coverage it produced, so the attribution is recoverable from the file alone.
 */
export function attributeTestFile(file: RawCoverageFile, fallback: string): string {
  return (file.result ?? []).find((entry) => TEST_MODULE_PATTERN.test(entry.url))?.url ?? fallback;
}

/**
 * Every raw coverage object in `dir`. A missing directory yields nothing (the
 * run wrote no raw coverage), and an unparseable file is skipped rather than
 * thrown on — a killed run leaves a half-written file behind, and a detector
 * that dies on debris would fail runs it has nothing to say about.
 */
export function collectRawCoverage(dir: string, fs: RawCoverageFs): readonly NamedRawCoverage[] {
  let entries: readonly string[];
  try {
    entries = fs.readdir(dir);
  } catch {
    return [];
  }
  const collected: NamedRawCoverage[] = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) {
      continue;
    }
    try {
      collected.push({ name, file: JSON.parse(fs.readFile(`${dir}/${name}`)) as RawCoverageFile });
    } catch {
      continue;
    }
  }
  return collected;
}

/**
 * Every url recorded under more than one distinct start offset, with the test
 * files that contributed each offset. Offsets sort ascending and test files
 * alphabetically so the message is stable across runs and diffable.
 */
export function findOffsetDivergences(
  files: readonly NamedRawCoverage[]
): readonly OffsetDivergence[] {
  const offsetsByUrl = new Map<string, Map<number, Set<string>>>();
  for (const { name, file } of files) {
    const testFile = attributeTestFile(file, name);
    for (const entry of file.result ?? []) {
      // `?? 0` mirrors the provider's own `|| 0`, so this reads the offsets the
      // merge will actually use rather than a stricter view of the same data.
      const startOffset = entry.startOffset ?? 0;
      const byOffset = offsetsByUrl.get(entry.url) ?? new Map<number, Set<string>>();
      offsetsByUrl.set(entry.url, byOffset);
      const contributors = byOffset.get(startOffset) ?? new Set<string>();
      byOffset.set(startOffset, contributors);
      contributors.add(testFile);
    }
  }

  const divergences: OffsetDivergence[] = [];
  for (const [url, byOffset] of offsetsByUrl) {
    if (byOffset.size < 2) {
      continue;
    }
    divergences.push({
      url,
      offsets: [...byOffset.entries()]
        .toSorted(([a], [b]) => a - b)
        .map(([startOffset, testFiles]) => ({
          startOffset,
          testFiles: [...testFiles].toSorted((a, b) => a.localeCompare(b)),
        })),
    });
  }
  return divergences.toSorted((a, b) => a.url.localeCompare(b.url));
}

/** `file:///a/b.ts` → `/a/b.ts`; anything else is returned unchanged. */
function displayPath(url: string): string {
  return url.startsWith('file://') ? url.slice('file://'.length) : url;
}

function describeTestFiles(testFiles: readonly string[]): string {
  const shown = testFiles.slice(0, MAX_LISTED_TEST_FILES).map((file) => displayPath(file));
  const hidden = testFiles.length - shown.length;
  return hidden > 0 ? `${shown.join(', ')} (+${String(hidden)} more)` : shown.join(', ');
}

/**
 * The failure message. It names the module and, per offset, the suites that
 * recorded it, because the whole value of this gate is that the next instance is
 * attributable in seconds — "coverage is unreliable" would be worth nothing.
 */
export function formatOffsetDivergences(
  packageName: string,
  divergences: readonly OffsetDivergence[]
): readonly string[] {
  const lines = [
    `[${packageName}] COVERAGE OFFSET DIVERGENCE — ${String(divergences.length)} module(s) were measured under more than one vite-node wrapper offset in this run, so this run's coverage numbers for them are WRONG, not merely suspect: the merge keeps one offset per module and remaps every range recorded under the others out of place.`,
  ];
  for (const { url, offsets } of divergences) {
    lines.push(`[${packageName}]   ${displayPath(url)}`);
    for (const { startOffset, testFiles } of offsets) {
      lines.push(
        `[${packageName}]     offset ${String(startOffset)} ← ${describeTestFiles(testFiles)}`
      );
    }
  }
  lines.push(
    `[${packageName}]   Each offset is one way the module was loaded — 0 means it was loaded natively as an external, non-zero means it went through the vite-node wrapper. Make the listed suites reach the module the same way (usually by matching how they import it), then rerun.`
  );
  return lines;
}
