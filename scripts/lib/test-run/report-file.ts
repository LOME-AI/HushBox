import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { currentRunId, readOwnership, unownedFinding } from '../claims/ownership.js';

/**
 * The json report a test runner asks vitest for, from the name it is given to
 * the collection of the ones killed runs left behind.
 *
 * A report is written by vitest, read once by the gates that judge the run that
 * asked for it, and of no use to anyone afterwards — so the run that named it
 * drops it while its own claim is still on disk. What a run killed before that
 * leaves is answered the way every other resource in this design is: the file's
 * name carries its owning run's claim, so the next runner culls a report whose
 * run is gone, keeps one whose run is still alive, and leaves one no claim
 * accounts for standing.
 *
 * Their own directory rather than the temp directory itself. Reports written
 * before this existed are named after a pid, which no claim can be looked up
 * by; a pass that could see those would classify every one of them as unowned
 * and print a finding for each that nothing is able to act on.
 */

/** Where every json test report this repo asks for is written. */
export function reportDirectory(): string {
  return path.join(os.tmpdir(), 'hushbox-test-reports');
}

/** What every report file named here begins with. */
const RUN_PREFIX = 'run-';

/**
 * A report file under `dir` for the run holding `runId`.
 *
 * Unique per call as well as per run, because one run can put several runners
 * in flight at once: the batch coordinator hands a package back to run on its
 * own, and two so handed back run concurrently under the single claim their
 * `pnpm test` took. The run is what ownership is read from; the rest of the
 * name only keeps two of its runners apart.
 *
 * A run holding no claim gets a name this module's reclaim pass does not
 * recognise. Nothing could attribute such a file afterwards, and a name that
 * invited the attempt would have it read as unowned — the state that gets a
 * finding printed for it on every later pass.
 */
export function runReportFile(dir: string, runId: string | null): string {
  const unique = randomUUID();
  return path.join(
    dir,
    runId === null || runId === ''
      ? `unclaimed.${unique}.json`
      : `${RUN_PREFIX}${runId}.${unique}.json`
  );
}

/**
 * The run a report file names, or undefined for a name this module never
 * minted. The name is the only part of the file that exists from the instant
 * the file does, which is what lets a leftover be attributed at all.
 */
export function reportFileRunId(entry: string): string | undefined {
  if (!entry.startsWith(RUN_PREFIX)) {
    return undefined;
  }
  const runId = entry.slice(RUN_PREFIX.length).split('.')[0];
  return runId === undefined || runId === '' ? undefined : runId;
}

interface ReportReclaim {
  /** Reports whose owning run is gone, and which this pass removed. */
  readonly removed: readonly string[];
  /** Reports no claim accounts for. Reported and left standing. */
  readonly unowned: readonly string[];
}

interface ReportFileOptions {
  /** Defaults to the machine-wide registry; a test points it elsewhere. */
  readonly registryDir?: string | undefined;
  /** Defaults to {@link reportDirectory}. */
  readonly directory?: string | undefined;
}

/** Removes one report. Idempotent: a report already gone is what the call asked for. */
export function dropReportFile(file: string): void {
  rmSync(file, { force: true });
}

/**
 * Collect the reports runs that died left behind.
 *
 * One reading of the registry answers the whole pass: a run that finishes
 * mid-pass has its record removed before its lock is released, so a pass that
 * re-read between classifying and removing would be acting on two worlds.
 *
 * A missing directory is the first run on this machine, not a failure.
 */
export async function reclaimReportFiles(
  dir: string,
  options: ReportFileOptions = {}
): Promise<ReportReclaim> {
  let entries: readonly string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { removed: [], unowned: [] };
  }
  const ownership = await readOwnership(options.registryDir);
  const removed: string[] = [];
  const unowned: string[] = [];
  for (const entry of entries) {
    const runId = reportFileRunId(entry);
    if (runId === undefined) {
      continue;
    }
    const state = ownership.stateOfRun(runId);
    if (state === 'owned-live') {
      continue;
    }
    const target = path.join(dir, entry);
    if (state === 'unowned') {
      console.warn(
        `The test report ${entry} is ${unownedFinding(ownership)}. Classify everything with ` +
          '`pnpm dev:clean --dry-run`.'
      );
      unowned.push(target);
      continue;
    }
    dropReportFile(target);
    removed.push(target);
  }
  return { removed, unowned };
}

/**
 * Names this run's report file, having first collected the ones dead runs left
 * beside it.
 *
 * One call because the name is the whole of the claim, so the two cannot be
 * ordered any other way: nothing may write a report before the name saying who
 * owns it exists, and the pass that reads the registry to attribute the
 * leftovers is what runs while there is still nothing of this run's to
 * misclassify.
 */
export async function claimReportFile(options: ReportFileOptions = {}): Promise<string> {
  const dir = options.directory ?? reportDirectory();
  mkdirSync(dir, { recursive: true });
  await reclaimReportFiles(dir, options);
  return runReportFile(dir, currentRunId());
}
