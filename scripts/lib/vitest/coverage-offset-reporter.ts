import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

import {
  collectRawCoverage,
  findOffsetDivergences,
  type OffsetScanResult,
} from './coverage-offset-detector.js';

/**
 * The vitest reporter half of the coverage-offset gate.
 *
 * The scan has to happen inside the vitest process: the v8 provider deletes its
 * raw-coverage directory (`<reportsDirectory>/.tmp`) at the end of every
 * completed run, so by the time the wrapper that spawned vitest regains control
 * there is nothing left to read — verified on vitest 4.1.10, where the directory
 * is gone even after a fully passing run, and a `globalSetup` teardown also runs
 * too late to see it. The reporter's `onCoverage` hook does run while the raw
 * files are still on disk, so the scan lives here and hands its findings to the
 * wrapper through a file, leaving the pass/fail decision with the wrapper
 * alongside its other gates.
 */

export const RAW_DIR_ENV = 'HB_COVERAGE_RAW_DIR';
export const REPORT_ENV = 'HB_COVERAGE_OFFSET_REPORT';

export interface OffsetScanFs {
  readonly readdir: (dir: string) => readonly string[];
  readonly readFile: (file: string) => string;
  readonly writeFile: (file: string, contents: string) => void;
}

/**
 * Scan the raw coverage directory and write the findings, or do nothing when the
 * runner asked for no scan. Writes `[]` on a clean run so the wrapper can tell a
 * clean scan from a scan that never happened.
 *
 * Swallows its own failures: a reporter that throws takes down a run whose tests
 * all passed, and this gate must be able to fail a run through its findings
 * only.
 */
export function scanForOffsetDivergence(env: NodeJS.ProcessEnv, fs: OffsetScanFs): void {
  const rawDir = env[RAW_DIR_ENV];
  const reportFile = env[REPORT_ENV];
  if (rawDir === undefined || rawDir === '' || reportFile === undefined || reportFile === '') {
    return;
  }
  try {
    const divergences: OffsetScanResult = findOffsetDivergences(
      collectRawCoverage(rawDir, { readdir: fs.readdir, readFile: fs.readFile })
    );
    fs.writeFile(reportFile, JSON.stringify(divergences));
  } catch {
    // Nothing to report to; the wrapper's missing-report warning covers this.
  }
}

/* v8 ignore start -- the reporter shell is exercised end-to-end by every package's test run */
export default class CoverageOffsetReporter {
  onCoverage(): void {
    scanForOffsetDivergence(process.env, {
      readdir: (dir) => readdirSync(dir),
      readFile: (file) => readFileSync(file, 'utf8'),
      writeFile: (file, contents) => {
        writeFileSync(file, contents);
      },
    });
  }
}
/* v8 ignore stop */
