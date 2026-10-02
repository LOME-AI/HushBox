import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_RETAINED_WALLS,
  MAX_RUNS_PER_SHAPE,
  ledgerPath,
  readLedger,
  writeLedger,
} from '../pool/ledger.js';
import { describeDerivationBound } from '../pool/schedule.js';
import { sumFileWallMs } from '../test-run/test-report.js';
import {
  VITEST_LEDGER_TASK,
  createRunSplitRecorder,
  describeVitestDerivation,
  deriveRepositoryVitestWorkers,
  deriveVitestWorkers,
  shapeFault,
  vitestFileUnits,
  liveChildPids,
  readDirectChildPids,
  formatVitestRunReport,
  measureTestFiles,
  observeRunConstraints,
  parseMachineMemoryEvents,
  readMachineMemoryEvents,
  recordVitestRun,
  repoRelativeTestFile,
  trackRunSplit,
  type MachineMemoryEvents,
  type VitestRunReportInput,
  type VitestWorkerDerivation,
  type RunSplitDeps,
  type RunSplitRecorder,
  type VitestRunRecord,
} from './workers.js';

import type { AttributedTreePssKb } from '../pool/memory.js';
import type { LedgerEntry } from '../pool/ledger.js';
import type { PoolTaskEstimate, RunObservation } from '../pool/schedule.js';
import type { VitestJsonReport } from '../test-run/test-report.js';

describe('deriveVitestWorkers', () => {
  /** A file whose walls all read the same, so a set of them is work-bound at its own size. */
  function file(name: string, wallMs: number): PoolTaskEstimate {
    return { name, wallsMs: [wallMs, wallMs, wallMs] };
  }

  /** One run on record: the width it held its peak at, and what it held there. */
  function heldAt(lanes: number, peakRssKb: number): RunObservation {
    return {
      concurrency: lanes,
      taskCount: lanes,
      sumWallMs: 1000,
      longestWallMs: 1000,
      makespanMs: 1000,
      peakRssKb,
      fixedRssKb: 1_000_000,
      lanesAtPeak: lanes,
    };
  }

  it('opens the machine ceiling where no file is on record', () => {
    expect(deriveVitestWorkers({ maxParallelism: 24 }).workers).toBe(24);
  });

  it('gives a single-processor machine one worker', () => {
    expect(deriveVitestWorkers({ maxParallelism: 1 }).workers).toBe(1);
  });

  it('reports a count no recorded file produced as underived', () => {
    expect(deriveVitestWorkers({ maxParallelism: 24 }).state).toBe('cold-start');
  });

  it('checks a count no recorded file produced against no memory projection', () => {
    expect(deriveVitestWorkers({ maxParallelism: 24, memoryBudgetKb: 1 }).memoryGuarded).toBe(
      false
    );
  });

  it('counts no unit for a run no recorded file names', () => {
    expect(deriveVitestWorkers({ maxParallelism: 24 }).units).toBe(0);
  });

  it('stops at the work bound where the machine has lanes to spare', () => {
    // 100s + five 10s: the critical path is 100s and the total 150s, so two
    // lanes carry the work and the remaining four buy nothing.
    const files = [
      file('long.test.ts', 100_000),
      ...[1, 2, 3, 4, 5].map((n) => file(`short-${String(n)}.test.ts`, 10_000)),
    ];
    expect(deriveVitestWorkers({ maxParallelism: 24, files }).workers).toBe(2);
  });

  it('stops at the machine ceiling where the work bound is above it', () => {
    const files = [1, 2, 3, 4, 5].map((n) => file(`same-${String(n)}.test.ts`, 10_000));
    expect(deriveVitestWorkers({ maxParallelism: 2, files }).workers).toBe(2);
  });

  /** Four lanes have held 8 GB and two have held 4 GB, so a 5 GB budget admits two. */
  const WIDTHS_ON_RECORD = [heldAt(2, 4_000_000), heldAt(4, 8_000_000)];

  it('descends below both bounds while the widths on record overrun the budget', () => {
    // Three lanes sit between the two widths on record and are priced on the
    // line joining them, at 6 GB — over the budget — so the descent goes on to
    // the two-lane rung, which is the widest figure that fits.
    const files = [1, 2, 3, 4].map((n) => file(`same-${String(n)}.test.ts`, 10_000));
    const derived = deriveVitestWorkers({
      maxParallelism: 24,
      files,
      observations: WIDTHS_ON_RECORD,
      memoryBudgetKb: 5_000_000,
    });
    expect(derived.workers).toBe(2);
  });

  it('says the memory projection is what set a count it lowered', () => {
    const files = [1, 2, 3, 4].map((n) => file(`same-${String(n)}.test.ts`, 10_000));
    const derived = deriveVitestWorkers({
      maxParallelism: 24,
      files,
      observations: WIDTHS_ON_RECORD,
      memoryBudgetKb: 5_000_000,
    });
    expect(derived.memoryCapped).toBe(true);
  });

  it('reports a count the recorded walls produced as derived', () => {
    const files = [1, 2, 3].map((n) => file(`same-${String(n)}.test.ts`, 10_000));
    expect(deriveVitestWorkers({ maxParallelism: 24, files }).state).toBe('derived');
  });

  it('counts the units the count was derived over', () => {
    const files = [1, 2, 3].map((n) => file(`same-${String(n)}.test.ts`, 10_000));
    expect(deriveVitestWorkers({ maxParallelism: 24, files }).units).toBe(3);
  });

  /**
   * The case the state word was wrong on: a set far wider than the machine,
   * almost none of it carrying a wall. The work bound imputes the largest known
   * wall to every wall-less unit and takes the longest over that same set, so it
   * lands above the unit count and can never bind — the ceiling is what sets the
   * count, and the walls the handful of measured units carry shaped nothing.
   */
  it('names the ceiling, not the walls, where a wall-less set lands above the ceiling', () => {
    const files = [
      file('measured.test.ts', 10_000),
      ...Array.from({ length: 500 }, (_, index) => ({
        name: `unmeasured-${String(index)}.test.ts`,
      })),
    ];
    const derived = deriveVitestWorkers({ maxParallelism: 24, files });
    expect(derived.workers).toBe(24);
    expect(derived.bound).toBe('ceiling');
  });

  it('leaves that count where it was, since only its description was wrong', () => {
    const wallLess = Array.from({ length: 500 }, (_, index) => ({
      name: `unmeasured-${String(index)}.test.ts`,
    }));
    const withWall = [file('measured.test.ts', 10_000), ...wallLess];
    expect(deriveVitestWorkers({ maxParallelism: 24, files: withWall }).workers).toBe(
      deriveVitestWorkers({ maxParallelism: 24, files: wallLess }).workers
    );
  });

  /**
   * The two cases a real invocation of the package-rooted runner meets: a set
   * of files this path has never run, which carries no wall of its own, and a
   * set it has.
   */
  it('names the ceiling for a set of files this path has never run', () => {
    const files = [1, 2, 3, 4].map((n) => ({ name: `never-run-${String(n)}.test.ts` }));
    const derived = deriveVitestWorkers({
      maxParallelism: 24,
      files,
      observations: WIDTHS_ON_RECORD,
      memoryBudgetKb: 100_000_000,
    });
    expect(derived.workers).toBe(4);
    expect(derived.bound).toBe('ceiling');
  });

  it('names the walls for a set of files this path has run', () => {
    const files = [1, 2, 3, 4].map((n) => file(`already-run-${String(n)}.test.ts`, 10_000));
    const derived = deriveVitestWorkers({
      maxParallelism: 24,
      files,
      observations: WIDTHS_ON_RECORD,
      memoryBudgetKb: 100_000_000,
    });
    expect(derived.workers).toBe(4);
    expect(derived.bound).toBe('work');
  });
});

describe('vitestFileUnits', () => {
  const temporaryRoots: string[] = [];
  function makeRepoRoot(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'vitest-file-units-'));
    temporaryRoots.push(dir);
    return dir;
  }
  afterEach(() => {
    for (const dir of temporaryRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const DB_FILE = path.join('packages', 'db', 'src', 'a.test.ts');
  const WEB_FILE = path.join('apps', 'web', 'src', 'b.test.ts');

  const ROWS: Record<string, LedgerEntry> = {
    [DB_FILE]: { wallsMs: [100, 200] },
    [WEB_FILE]: { wallsMs: [300] },
  };

  /** A repository holding a real file for every row the fixture names. */
  function makeRepoHolding(...files: readonly string[]): string {
    const repoRoot = makeRepoRoot();
    for (const relative of files) {
      const absolute = path.join(repoRoot, relative);
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, '');
    }
    return repoRoot;
  }

  it('takes a unit from the row of every file under a directory the run covers', () => {
    const repoRoot = makeRepoHolding(DB_FILE, WEB_FILE);
    const units = vitestFileUnits(repoRoot, ROWS, [path.join(repoRoot, 'packages', 'db')]);
    expect(units).toEqual([{ name: DB_FILE, wallsMs: [100, 200] }]);
  });

  it('leaves out a row naming a file outside every directory the run covers', () => {
    const repoRoot = makeRepoHolding(DB_FILE, WEB_FILE);
    expect(
      vitestFileUnits(repoRoot, ROWS, [path.join(repoRoot, 'packages', 'db')]).map(
        (unit) => unit.name
      )
    ).not.toContain(WEB_FILE);
  });

  it('takes the units of every directory the run covers', () => {
    const repoRoot = makeRepoHolding(DB_FILE, WEB_FILE);
    const units = vitestFileUnits(repoRoot, ROWS, [
      path.join(repoRoot, 'packages', 'db'),
      path.join(repoRoot, 'apps', 'web'),
    ]);
    expect(units).toHaveLength(2);
  });

  it('reads a directory named relative to the repository as the same directory', () => {
    const repoRoot = makeRepoHolding(DB_FILE, WEB_FILE);
    expect(vitestFileUnits(repoRoot, ROWS, [path.join('packages', 'db')])).toHaveLength(1);
  });

  it('leaves out a row naming a file the repository no longer holds', () => {
    const repoRoot = makeRepoHolding(WEB_FILE);
    expect(vitestFileUnits(repoRoot, ROWS, [repoRoot]).map((unit) => unit.name)).toEqual([
      WEB_FILE,
    ]);
  });

  it('leaves out a row under the package key this ledger carried before the file was the unit', () => {
    const repoRoot = makeRepoHolding(DB_FILE);
    const rows: Record<string, LedgerEntry> = {
      ...ROWS,
      '@hushbox/api': { wallsMs: [900] },
    };
    expect(vitestFileUnits(repoRoot, rows, [repoRoot]).map((unit) => unit.name)).toEqual([DB_FILE]);
  });

  it('leaves out a row whose key names a path outside the repository', () => {
    const repoRoot = makeRepoHolding(DB_FILE);
    const rows: Record<string, LedgerEntry> = { '../elsewhere.test.ts': { wallsMs: [900] } };
    expect(vitestFileUnits(repoRoot, rows, [repoRoot])).toEqual([]);
  });

  it('takes the units of a repository root handed over with a trailing separator', () => {
    const repoRoot = makeRepoHolding(DB_FILE);
    expect(vitestFileUnits(repoRoot + path.sep, ROWS, [repoRoot])).toHaveLength(1);
  });
});

describe('deriveRepositoryVitestWorkers', () => {
  const temporaryRoots: string[] = [];
  function makeRepoRoot(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'vitest-repository-workers-'));
    temporaryRoots.push(dir);
    return dir;
  }
  afterEach(() => {
    for (const dir of temporaryRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const FINGERPRINT = 'testmachine1';
  const DB_FILES = ['a', 'b', 'c', 'd'].map((name) =>
    path.join('packages', 'db', 'src', `${name}.test.ts`)
  );
  const UI_FILES = ['a', 'b', 'c', 'd'].map((name) =>
    path.join('packages', 'ui', 'src', `${name}.test.ts`)
  );

  /** A repository holding a real file for each path named, and a store weighing every one. */
  function weighing(repoRoot: string, files: readonly string[], fingerprint = FINGERPRINT): void {
    for (const relative of files) {
      const absolute = path.join(repoRoot, relative);
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, '');
    }
    writeLedger(
      ledgerPath(repoRoot, fingerprint, VITEST_LEDGER_TASK),
      { tasks: Object.fromEntries(files.map((file) => [file, { wallsMs: [1000] }])), runs: [] },
      () => true
    );
  }

  it('weighs every test file the store holds, not only those under one package', () => {
    const repoRoot = makeRepoRoot();
    weighing(repoRoot, [...DB_FILES, ...UI_FILES]);
    expect(deriveRepositoryVitestWorkers(repoRoot, FINGERPRINT).derivation.units).toBe(
      DB_FILES.length + UI_FILES.length
    );
  });

  it('reads the store under the machine key it was handed', () => {
    const repoRoot = makeRepoRoot();
    weighing(repoRoot, DB_FILES);
    expect(deriveRepositoryVitestWorkers(repoRoot, 'testmachine2').derivation.units).toBe(0);
  });

  it('reports a machine whose store weighs nothing as underived', () => {
    const repoRoot = makeRepoRoot();
    expect(deriveRepositoryVitestWorkers(repoRoot, FINGERPRINT).derivation.state).toBe(
      'cold-start'
    );
  });
});

describe('recordVitestRun', () => {
  const temporaryRoots: string[] = [];
  function makeRepoRoot(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'vitest-workers-'));
    temporaryRoots.push(dir);
    return dir;
  }
  afterEach(() => {
    for (const dir of temporaryRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const FINGERPRINT = 'testmachine1';
  const RUNNER_PID = 500;

  function recordedRuns(repoRoot: string, fingerprint = FINGERPRINT): readonly RunObservation[] {
    return readLedger(ledgerPath(repoRoot, fingerprint, VITEST_LEDGER_TASK)).runs;
  }

  /**
   * The rows as they were written, before the read supplies anything of its
   * own. The ledger fills a missing lane count in from the row's other figures,
   * so a row that recorded none is only distinguishable here.
   */
  function writtenRows(repoRoot: string): readonly Record<string, unknown>[] {
    const store = ledgerPath(repoRoot, FINGERPRINT, VITEST_LEDGER_TASK);
    return readdirSync(store)
      .filter((name) => name.endsWith('.json'))
      .flatMap((name) => {
        const file = JSON.parse(readFileSync(path.join(store, name), 'utf8')) as {
          runs?: readonly Record<string, unknown>[];
        };
        return file.runs ?? [];
      });
  }

  const FULL_BATCH: VitestRunRecord = {
    wallMs: 180_000,
    peakRssKb: 19_000_000,
    split: { fixedRssKb: 2_000_000 },
    runnerPid: RUNNER_PID,
    declaredWorkers: 19,
    peakRunnerChildren: 19,
    lanesAtPeak: 19,
    fileCount: 900,
    packageCount: 12,
    perFileWallMs: 4200,
    sumFileWallMs: 3_780_000,
    shape: 'batch',
  };

  it('records the lanes that were live at the peak, not the count the run declared', () => {
    const repoRoot = makeRepoRoot();
    recordVitestRun(repoRoot, FINGERPRINT, {
      ...FULL_BATCH,
      declaredWorkers: 19,
      lanesAtPeak: 6,
    });
    expect(recordedRuns(repoRoot)[0]?.lanesAtPeak).toBe(6);
  });

  it('leaves the lane count off a row whose peak sample saw no worker live', () => {
    const repoRoot = makeRepoRoot();
    recordVitestRun(repoRoot, FINGERPRINT, { ...FULL_BATCH, lanesAtPeak: undefined });
    expect(writtenRows(repoRoot)[0]).not.toHaveProperty('lanesAtPeak');
  });

  it('stamps the row with the shape of the invocation that recorded it', () => {
    const repoRoot = makeRepoRoot();
    recordVitestRun(repoRoot, FINGERPRINT, { ...FULL_BATCH, shape: 'package' });
    expect(recordedRuns(repoRoot)[0]?.shape).toBe('package');
  });

  it('lands a batch run and a package-rooted run in one store, each under its own shape', () => {
    const repoRoot = makeRepoRoot();
    recordVitestRun(repoRoot, FINGERPRINT, { ...FULL_BATCH, shape: 'batch' });
    recordVitestRun(repoRoot, FINGERPRINT, { ...FULL_BATCH, shape: 'package' });
    expect(recordedRuns(repoRoot).map((run) => run.shape)).toEqual(['batch', 'package']);
  });

  it('opens no second store for the shape that used to keep a ledger task of its own', () => {
    const repoRoot = makeRepoRoot();
    recordVitestRun(repoRoot, FINGERPRINT, { ...FULL_BATCH, shape: 'package' });
    expect(existsSync(`${ledgerPath(repoRoot, FINGERPRINT, VITEST_LEDGER_TASK)}-pkg`)).toBe(false);
  });

  it('records the split it measured beside the whole-tree peak', () => {
    const repoRoot = makeRepoRoot();
    recordVitestRun(repoRoot, FINGERPRINT, FULL_BATCH);
    const { runs } = readLedger(ledgerPath(repoRoot, FINGERPRINT, VITEST_LEDGER_TASK));
    expect(runs[0]).toMatchObject({ peakRssKb: 19_000_000, fixedRssKb: 2_000_000 });
  });

  it('records no per-worker memory figure on the row', () => {
    const repoRoot = makeRepoRoot();
    recordVitestRun(repoRoot, FINGERPRINT, FULL_BATCH);
    const { runs } = readLedger(ledgerPath(repoRoot, FINGERPRINT, VITEST_LEDGER_TASK));
    expect(runs[0]).not.toHaveProperty('perWorkerRssKb');
  });

  it('records no second worker figure beside the count the row already carries', () => {
    const repoRoot = makeRepoRoot();
    recordVitestRun(repoRoot, FINGERPRINT, { ...FULL_BATCH, declaredWorkers: 7, fileCount: 7 });
    const { runs } = readLedger(ledgerPath(repoRoot, FINGERPRINT, VITEST_LEDGER_TASK));
    expect(runs[0]).not.toHaveProperty('liveWorkers');
  });

  it('records the packages the batch covered where the worker count used to sit', () => {
    const repoRoot = makeRepoRoot();
    recordVitestRun(repoRoot, FINGERPRINT, FULL_BATCH);
    const { runs } = readLedger(ledgerPath(repoRoot, FINGERPRINT, VITEST_LEDGER_TASK));
    expect(runs[0]?.taskCount).toBe(12);
  });

  it('records the files the batch collected', () => {
    const repoRoot = makeRepoRoot();
    recordVitestRun(repoRoot, FINGERPRINT, FULL_BATCH);
    const { runs } = readLedger(ledgerPath(repoRoot, FINGERPRINT, VITEST_LEDGER_TASK));
    expect(runs[0]?.fileCount).toBe(900);
  });

  it('leaves the file count off a row for a run that collected no file', () => {
    const repoRoot = makeRepoRoot();
    recordVitestRun(repoRoot, FINGERPRINT, { ...FULL_BATCH, fileCount: 0 });
    const { runs } = readLedger(ledgerPath(repoRoot, FINGERPRINT, VITEST_LEDGER_TASK));
    expect(runs[0]).not.toHaveProperty('fileCount');
  });

  it('refuses a run whose runner never started, and says so', () => {
    const repoRoot = makeRepoRoot();
    const disposition = recordVitestRun(repoRoot, FINGERPRINT, {
      ...FULL_BATCH,
      runnerPid: undefined,
    });
    const { runs } = readLedger(ledgerPath(repoRoot, FINGERPRINT, VITEST_LEDGER_TASK));
    expect(runs).toEqual([]);
    expect(disposition).toEqual({
      kind: 'refused',
      reason: expect.stringMatching(/never started/),
    });
  });

  it('refuses a runnerless run even where its whole tree read cleanly', () => {
    const repoRoot = makeRepoRoot();
    const disposition = recordVitestRun(repoRoot, FINGERPRINT, {
      ...FULL_BATCH,
      runnerPid: undefined,
      fileCount: 0,
      split: { fixedRssKb: 19_000_000 },
    });
    expect(recordedRuns(repoRoot)).toEqual([]);
    expect(disposition).toEqual({
      kind: 'refused',
      reason: expect.stringMatching(/never started/),
    });
  });

  it('records the work per file the batch covered', () => {
    const repoRoot = makeRepoRoot();
    recordVitestRun(repoRoot, FINGERPRINT, FULL_BATCH);
    const { runs } = readLedger(ledgerPath(repoRoot, FINGERPRINT, VITEST_LEDGER_TASK));
    expect(runs[0]?.perFileWallMs).toBe(4200);
  });

  it('records the summed wall of the files it could weigh', () => {
    const repoRoot = makeRepoRoot();
    recordVitestRun(repoRoot, FINGERPRINT, FULL_BATCH);
    const { runs } = readLedger(ledgerPath(repoRoot, FINGERPRINT, VITEST_LEDGER_TASK));
    expect(runs[0]?.sumFileWallMs).toBe(3_780_000);
  });

  it('leaves the summed file wall off a row whose files could not be weighed', () => {
    const repoRoot = makeRepoRoot();
    recordVitestRun(repoRoot, FINGERPRINT, { ...FULL_BATCH, sumFileWallMs: undefined });
    const { runs } = readLedger(ledgerPath(repoRoot, FINGERPRINT, VITEST_LEDGER_TASK));
    expect(runs[0]).not.toHaveProperty('sumFileWallMs');
  });

  it('rounds the work per file it was handed to whole milliseconds', () => {
    const repoRoot = makeRepoRoot();
    recordVitestRun(repoRoot, FINGERPRINT, { ...FULL_BATCH, perFileWallMs: 4200.4 });
    const { runs } = readLedger(ledgerPath(repoRoot, FINGERPRINT, VITEST_LEDGER_TASK));
    expect(runs[0]?.perFileWallMs).toBe(4200);
  });

  it('leaves the work per file off a row whose files could not be weighed', () => {
    const repoRoot = makeRepoRoot();
    recordVitestRun(repoRoot, FINGERPRINT, { ...FULL_BATCH, perFileWallMs: undefined });
    const { runs } = readLedger(ledgerPath(repoRoot, FINGERPRINT, VITEST_LEDGER_TASK));
    expect(runs[0]).not.toHaveProperty('perFileWallMs');
  });

  it("keeps an earlier run's work per file when a later run is recorded", () => {
    const repoRoot = makeRepoRoot();
    recordVitestRun(repoRoot, FINGERPRINT, FULL_BATCH);
    recordVitestRun(repoRoot, FINGERPRINT, { ...FULL_BATCH, perFileWallMs: 1100 });
    const { runs } = readLedger(ledgerPath(repoRoot, FINGERPRINT, VITEST_LEDGER_TASK));
    expect(runs.map((observation) => observation.perFileWallMs)).toEqual([4200, 1100]);
  });

  it("records the count the run declared as the run's concurrency", () => {
    const repoRoot = makeRepoRoot();
    recordVitestRun(repoRoot, FINGERPRINT, {
      ...FULL_BATCH,
      declaredWorkers: 3,
      fileCount: 3,
    });
    const { runs } = readLedger(ledgerPath(repoRoot, FINGERPRINT, VITEST_LEDGER_TASK));
    expect(runs[0]?.concurrency).toBe(3);
  });

  it("keeps an earlier run's figures when a later run is recorded", () => {
    const repoRoot = makeRepoRoot();
    recordVitestRun(repoRoot, FINGERPRINT, FULL_BATCH);
    recordVitestRun(repoRoot, FINGERPRINT, {
      ...FULL_BATCH,
      split: { fixedRssKb: 3_000_000 },
    });
    const { runs } = readLedger(ledgerPath(repoRoot, FINGERPRINT, VITEST_LEDGER_TASK));
    expect(runs.map((observation) => observation.fixedRssKb)).toEqual([2_000_000, 3_000_000]);
  });

  it('keeps the runs of one machine apart from another', () => {
    const repoRoot = makeRepoRoot();
    recordVitestRun(repoRoot, 'machine-a', {
      ...FULL_BATCH,
      peakRssKb: 8_000_000,
      declaredWorkers: 8,
    });
    expect(recordedRuns(repoRoot, 'machine-b')).toEqual([]);
    expect(recordedRuns(repoRoot, 'machine-a')).toHaveLength(1);
  });

  it('records nothing without a sampled peak', () => {
    const repoRoot = makeRepoRoot();
    const disposition = recordVitestRun(repoRoot, FINGERPRINT, {
      ...FULL_BATCH,
      peakRssKb: undefined,
    });
    expect(recordedRuns(repoRoot)).toEqual([]);
    expect(disposition.kind).toBe('refused');
  });

  it('refuses a run that declared no worker and ran no file, and says which', () => {
    const repoRoot = makeRepoRoot();
    const disposition = recordVitestRun(repoRoot, FINGERPRINT, {
      ...FULL_BATCH,
      declaredWorkers: 0,
      fileCount: 0,
    });
    expect(recordedRuns(repoRoot)).toEqual([]);
    expect(disposition).toEqual({ kind: 'refused', reason: expect.stringMatching(/no worker/) });
  });

  it('says so where a run that collected files declared no worker to run them on', () => {
    const repoRoot = makeRepoRoot();
    const disposition = recordVitestRun(repoRoot, FINGERPRINT, {
      ...FULL_BATCH,
      declaredWorkers: 0,
      fileCount: 3,
    });
    expect(recordedRuns(repoRoot)).toEqual([]);
    expect(disposition).toEqual({
      kind: 'refused',
      reason: expect.stringMatching(/declared 0 worker\(s\) for 3 files/),
    });
  });

  it('says so where nothing in the tree could be read at all', () => {
    const repoRoot = makeRepoRoot();
    const disposition = recordVitestRun(repoRoot, FINGERPRINT, {
      ...FULL_BATCH,
      peakRssKb: undefined,
      split: { fixedRssKb: undefined },
    });
    expect(disposition).toEqual({
      kind: 'refused',
      reason: expect.stringMatching(/could be read/),
    });
  });

  it('records nothing for a batch that covered no package, and says which', () => {
    const repoRoot = makeRepoRoot();
    const disposition = recordVitestRun(repoRoot, FINGERPRINT, {
      ...FULL_BATCH,
      packageCount: 0,
    });
    expect(recordedRuns(repoRoot)).toEqual([]);
    expect(disposition).toEqual({ kind: 'refused', reason: expect.stringMatching(/no package/) });
  });

  it('records no swapped-out figure on the row, because nothing reasons about swap', () => {
    const repoRoot = makeRepoRoot();
    recordVitestRun(repoRoot, FINGERPRINT, FULL_BATCH);
    expect(recordedRuns(repoRoot)[0]).not.toHaveProperty('peakSwapPssKb');
  });

  it('refuses a run whose runner was never seen holding more than one child, and says so', () => {
    const repoRoot = makeRepoRoot();
    const disposition = recordVitestRun(repoRoot, FINGERPRINT, {
      ...FULL_BATCH,
      peakRunnerChildren: 1,
    });
    expect(disposition).toEqual({
      kind: 'refused',
      reason: expect.stringMatching(/one direct child/),
    });
  });

  it('records a run whose runner held as many children as it declared workers', () => {
    const repoRoot = makeRepoRoot();
    recordVitestRun(repoRoot, FINGERPRINT, { ...FULL_BATCH, peakRunnerChildren: 19 });
    expect(recordedRuns(repoRoot)).toHaveLength(1);
  });

  it('records a run on a machine whose process table states no child at all', () => {
    const repoRoot = makeRepoRoot();
    recordVitestRun(repoRoot, FINGERPRINT, { ...FULL_BATCH, peakRunnerChildren: 0 });
    expect(recordedRuns(repoRoot)).toHaveLength(1);
  });

  it('records a single-worker run whose runner held its one child', () => {
    const repoRoot = makeRepoRoot();
    recordVitestRun(repoRoot, FINGERPRINT, {
      ...FULL_BATCH,
      declaredWorkers: 1,
      peakRunnerChildren: 1,
    });
    expect(recordedRuns(repoRoot)).toHaveLength(1);
  });

  it('records a one-file run whose runner held its one child', () => {
    const repoRoot = makeRepoRoot();
    recordVitestRun(repoRoot, FINGERPRINT, {
      ...FULL_BATCH,
      fileCount: 1,
      peakRunnerChildren: 1,
    });
    expect(recordedRuns(repoRoot)).toHaveLength(1);
  });

  it('records a run that stated nothing about the children its runner held', () => {
    const repoRoot = makeRepoRoot();
    recordVitestRun(repoRoot, FINGERPRINT, { ...FULL_BATCH, peakRunnerChildren: undefined });
    expect(recordedRuns(repoRoot)).toHaveLength(1);
  });

  /**
   * Two recorders against one store, settled by measurement rather than by
   * reading: six trials of two concurrent processes writing ten rows each left
   * 5, 8, 10, 10, 10, 10 of them under the whole-file read-modify-write this
   * replaced, always parsing valid and always losing a contiguous block
   * belonging to one writer. One file per run removes the window itself — each
   * run records what it measured and rewrites nothing — so no lease or lock is
   * introduced to prevent it.
   */
  it('keeps the row a concurrent recorder landed while this one held what it read', () => {
    const repoRoot = makeRepoRoot();
    recordVitestRun(repoRoot, FINGERPRINT, FULL_BATCH);
    // Both recorders below read the store before either of them records.
    readLedger(ledgerPath(repoRoot, FINGERPRINT, VITEST_LEDGER_TASK));
    readLedger(ledgerPath(repoRoot, FINGERPRINT, VITEST_LEDGER_TASK));
    recordVitestRun(repoRoot, FINGERPRINT, { ...FULL_BATCH, wallMs: 60_000 });
    recordVitestRun(repoRoot, FINGERPRINT, { ...FULL_BATCH, wallMs: 30_000 });
    expect(recordedRuns(repoRoot).map((run) => run.makespanMs)).toEqual([180_000, 60_000, 30_000]);
  });

  function makeTestFile(repoRoot: string, relative: string): string {
    const absolute = path.join(repoRoot, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, '');
    return relative;
  }

  function recordedFiles(repoRoot: string): Record<string, LedgerEntry> {
    return readLedger(ledgerPath(repoRoot, FINGERPRINT, VITEST_LEDGER_TASK)).tasks;
  }

  it('writes one row per test file, keyed by the file within the repository', () => {
    const repoRoot = makeRepoRoot();
    const file = makeTestFile(repoRoot, path.join('pkg', 'a.test.ts'));
    recordVitestRun(repoRoot, FINGERPRINT, FULL_BATCH, [{ file, wallMs: 40 }]);
    expect(Object.keys(recordedFiles(repoRoot))).toEqual([file]);
  });

  it("carries the file's wall on its row", () => {
    const repoRoot = makeRepoRoot();
    const file = makeTestFile(repoRoot, path.join('pkg', 'a.test.ts'));
    recordVitestRun(repoRoot, FINGERPRINT, FULL_BATCH, [{ file, wallMs: 40.6 }]);
    expect(recordedFiles(repoRoot)[file]?.wallsMs).toEqual([41]);
  });

  it("appends this run's wall to the walls an earlier run recorded for the file", () => {
    const repoRoot = makeRepoRoot();
    const file = makeTestFile(repoRoot, path.join('pkg', 'a.test.ts'));
    recordVitestRun(repoRoot, FINGERPRINT, FULL_BATCH, [{ file, wallMs: 40 }]);
    recordVitestRun(repoRoot, FINGERPRINT, FULL_BATCH, [{ file, wallMs: 90 }]);
    expect(recordedFiles(repoRoot)[file]?.wallsMs).toEqual([40, 90]);
  });

  it('retains no more walls for a file than the ledger keeps for any other', () => {
    const repoRoot = makeRepoRoot();
    const file = makeTestFile(repoRoot, path.join('pkg', 'a.test.ts'));
    for (let run = 0; run < MAX_RETAINED_WALLS + 4; run += 1) {
      recordVitestRun(repoRoot, FINGERPRINT, FULL_BATCH, [{ file, wallMs: run }]);
    }
    expect(recordedFiles(repoRoot)[file]?.wallsMs).toHaveLength(MAX_RETAINED_WALLS);
  });

  it('records a run whose ledger still holds rows under the package key', () => {
    const repoRoot = makeRepoRoot();
    // A package name is not a path, so this store's own question — is the file
    // still on disk — answers no for the row being seeded. The row is the whole
    // premise here, so the seed states a tree nothing has left and the
    // recorder's own write is what asks the real question.
    writeLedger(
      ledgerPath(repoRoot, FINGERPRINT, VITEST_LEDGER_TASK),
      { tasks: { '@hushbox/api': { wallsMs: [900] } }, runs: [] },
      () => true
    );
    expect(recordVitestRun(repoRoot, FINGERPRINT, FULL_BATCH)).toEqual({ kind: 'recorded' });
  });

  it('keeps a row naming a file the repository still holds but this run did not run', () => {
    const repoRoot = makeRepoRoot();
    const ran = makeTestFile(repoRoot, path.join('pkg', 'a.test.ts'));
    const untouched = makeTestFile(repoRoot, path.join('pkg', 'b.test.ts'));
    writeLedger(
      ledgerPath(repoRoot, FINGERPRINT, VITEST_LEDGER_TASK),
      { tasks: { [untouched]: { wallsMs: [900] } }, runs: [] },
      (unit) => unit === untouched
    );
    recordVitestRun(repoRoot, FINGERPRINT, FULL_BATCH, [{ file: ran, wallMs: 40 }]);
    expect(recordedFiles(repoRoot)[untouched]?.wallsMs).toEqual([900]);
  });

  /**
   * A store whose two oldest runs each name one file and nothing else, aged out
   * of the newest-runs window by later runs naming a third. One of the two files
   * has since left the tree; the other is still in it. They are recorded by
   * separate runs because retention keeps or drops a whole run file, so two
   * files sharing one could not be told apart by what survives.
   */
  function ageOutOneDepartedAndOnePresentFile(repoRoot: string): {
    departed: string;
    present: string;
  } {
    const departed = makeTestFile(repoRoot, path.join('pkg', 'departed.test.ts'));
    const present = makeTestFile(repoRoot, path.join('pkg', 'present.test.ts'));
    recordVitestRun(repoRoot, FINGERPRINT, FULL_BATCH, [{ file: departed, wallMs: 40 }]);
    recordVitestRun(repoRoot, FINGERPRINT, FULL_BATCH, [{ file: present, wallMs: 50 }]);
    rmSync(path.join(repoRoot, departed));
    const busy = makeTestFile(repoRoot, path.join('pkg', 'busy.test.ts'));
    for (let run = 0; run < MAX_RUNS_PER_SHAPE; run += 1) {
      recordVitestRun(repoRoot, FINGERPRINT, FULL_BATCH, [{ file: busy, wallMs: run + 1 }]);
    }
    return { departed, present };
  }

  it('drops the carrier of a test file the tree no longer holds', () => {
    const repoRoot = makeRepoRoot();
    const { departed } = ageOutOneDepartedAndOnePresentFile(repoRoot);
    expect(Object.keys(recordedFiles(repoRoot))).not.toContain(departed);
  });

  it('keeps the carrier of a test file still in the tree past the newest-runs window', () => {
    const repoRoot = makeRepoRoot();
    const { present } = ageOutOneDepartedAndOnePresentFile(repoRoot);
    expect(recordedFiles(repoRoot)[present]?.wallsMs).toEqual([50]);
  });

  it('says a row it wrote was recorded', () => {
    expect(recordVitestRun(makeRepoRoot(), FINGERPRINT, FULL_BATCH)).toEqual({ kind: 'recorded' });
  });

  it('records a run that could measure no split', () => {
    const repoRoot = makeRepoRoot();
    recordVitestRun(repoRoot, FINGERPRINT, {
      ...FULL_BATCH,
      split: { fixedRssKb: undefined },
    });
    const { runs } = readLedger(ledgerPath(repoRoot, FINGERPRINT, VITEST_LEDGER_TASK));
    expect(runs[0]).toEqual({
      concurrency: 19,
      taskCount: 12,
      sumWallMs: 180_000,
      longestWallMs: 180_000,
      makespanMs: 180_000,
      peakRssKb: 19_000_000,
      fileCount: 900,
      perFileWallMs: 4200,
      sumFileWallMs: 3_780_000,
      lanesAtPeak: 19,
      shape: 'batch',
    });
  });
});

describe('liveChildPids', () => {
  const SLEEPING = 'S';
  const ZOMBIE = 'Z';

  function statRecord(pid: number, ppid: number, state: string): string {
    return `${String(pid)} (node) ${state} ${String(ppid)} ${String(ppid)} 0 -1`;
  }

  it('names the processes whose parent is the given pid', () => {
    const table = [
      statRecord(100, 1, SLEEPING),
      statRecord(101, 100, SLEEPING),
      statRecord(102, 100, SLEEPING),
    ];
    expect(liveChildPids(table, 100)).toEqual([101, 102]);
  });

  it('leaves out a process further down the tree', () => {
    const table = [statRecord(101, 100, SLEEPING), statRecord(999, 101, SLEEPING)];
    expect(liveChildPids(table, 100)).toEqual([101]);
  });

  it('leaves out a child that has exited and not yet been collected', () => {
    const table = [statRecord(101, 100, ZOMBIE), statRecord(102, 100, SLEEPING)];
    expect(liveChildPids(table, 100)).toEqual([102]);
  });

  it('leaves out a record whose parent is not a number', () => {
    expect(liveChildPids(['101 (node) S notapid 0 -1'], 100)).toEqual([]);
  });

  it('leaves out a record that names no parent at all', () => {
    expect(liveChildPids(['101 (node) S'], 100)).toEqual([]);
  });

  it('leaves out a record whose own id is not a number', () => {
    expect(liveChildPids(['x (node) S 100 100 0 -1'], 100)).toEqual([]);
  });

  it('leaves out a record that brackets no command name', () => {
    expect(liveChildPids(['garbage'], 100)).toEqual([]);
  });

  it('names nothing for a pid nothing is parented to', () => {
    expect(liveChildPids([statRecord(100, 1, SLEEPING)], 100)).toEqual([]);
  });
});

describe('readDirectChildPids', () => {
  it("reads this process out of its own parent's children", () => {
    expect(readDirectChildPids(process.ppid)).toContain(process.pid);
  });
});

describe('formatVitestRunReport', () => {
  const DERIVED: VitestWorkerDerivation = {
    workers: 24,
    state: 'derived',
    bound: 'work',
    memoryCapped: false,
    memoryGuarded: true,
    units: 900,
  };

  const MEASURED: VitestRunReportInput = {
    derivation: DERIVED,
    split: { fixedRssKb: 2_000_000 },
    constraints: { machineOomKills: 0 },
    disposition: { kind: 'recorded' },
  };

  it('names the count the run declared and held', () => {
    expect(formatVitestRunReport(MEASURED)).toMatch(/workers: 24 .*declared at launch and held/);
  });

  it('names the fixed cost it measured', () => {
    expect(formatVitestRunReport(MEASURED)).toMatch(/fixed 2000000 kB/);
  });

  it('states that nothing it prints is charged per worker', () => {
    expect(formatVitestRunReport(MEASURED)).toMatch(/nothing here is charged per worker/);
  });

  it('prints a cost the run could not measure as unmeasured rather than as nothing', () => {
    const report = formatVitestRunReport({
      ...MEASURED,
      split: { fixedRssKb: undefined },
    });
    expect(report).toMatch(/fixed not measured/);
    expect(report).not.toMatch(/fixed 0 kB/);
  });

  it('says what the count was derived over', () => {
    expect(formatVitestRunReport(MEASURED)).toMatch(/over 900 test file\(s\) as units/);
  });

  it('says a count recorded walls produced was work-bound', () => {
    expect(formatVitestRunReport(MEASURED)).toMatch(/workers: 24 \(work-bound/);
  });

  it('says a count nothing on record produced was not derived from anything', () => {
    const report = formatVitestRunReport({
      ...MEASURED,
      derivation: {
        ...DERIVED,
        state: 'cold-start',
        bound: 'unmeasured',
        memoryGuarded: false,
        units: 0,
      },
    });
    expect(report).toMatch(/cold-start/);
  });

  it('says so where the memory projection is what set the count', () => {
    const report = formatVitestRunReport({
      ...MEASURED,
      derivation: { ...DERIVED, bound: 'memory', memoryCapped: true },
    });
    expect(report).toMatch(/memory-bound/);
  });

  it('says so where nothing checked the count against a memory projection', () => {
    const report = formatVitestRunReport({
      ...MEASURED,
      derivation: { ...DERIVED, memoryGuarded: false },
    });
    expect(report).toMatch(/memory-unguarded/);
  });

  it('prints nothing about swap, which nothing here reasons about', () => {
    expect(formatVitestRunReport(MEASURED)).not.toMatch(/swap/i);
  });

  it('states that nothing attributes a process death to this run', () => {
    expect(formatVitestRunReport(MEASURED)).toMatch(/attributes no process death to this run/);
  });

  it('prints a counter it could not read as unread rather than as no events', () => {
    const report = formatVitestRunReport({
      ...MEASURED,
      constraints: { machineOomKills: undefined },
    });
    expect(report).toMatch(/not measured/);
    expect(report).not.toMatch(/0 processes/);
  });

  it('shows a recorded row as recorded', () => {
    expect(formatVitestRunReport(MEASURED)).toMatch(/ledger row: recorded/);
  });

  it('shows a refused row as refused, carrying what refused it', () => {
    const report = formatVitestRunReport({
      ...MEASURED,
      disposition: { kind: 'refused', reason: "the runner's process layout changed: 1 of 24" },
    });
    expect(report).toMatch(/ledger row: refused .*layout changed: 1 of 24/);
    expect(report).not.toMatch(/ledger row: recorded/);
  });
});

describe('describeVitestDerivation', () => {
  const WORK_BOUND: VitestWorkerDerivation = {
    workers: 19,
    state: 'derived',
    bound: 'work',
    memoryCapped: false,
    memoryGuarded: true,
    units: 2263,
  };

  it('gives the count the same account of its bound the pool rows give theirs', () => {
    expect(describeVitestDerivation(WORK_BOUND)).toContain(describeDerivationBound(WORK_BOUND));
  });
});

describe('parseMachineMemoryEvents', () => {
  it('reads the counter a run is judged against', () => {
    const vmstat = 'pgmajfault 49585875\npswpin 48629324\npswpout 98531117\noom_kill 3\n';
    expect(parseMachineMemoryEvents(vmstat)).toEqual({ oomKills: 3 });
  });

  it('reads no swap counter, which nothing here reasons about', () => {
    expect(parseMachineMemoryEvents('pswpout 12\noom_kill 3\n')).not.toHaveProperty(
      'pagesSwappedOut'
    );
  });

  it('leaves a counter this kernel does not report absent rather than zero', () => {
    expect(parseMachineMemoryEvents('pswpout 12\n')).toEqual({ oomKills: undefined });
  });
});

describe('readMachineMemoryEvents', () => {
  it('reads the counter off this machine', () => {
    expect(readMachineMemoryEvents().oomKills).toBeGreaterThanOrEqual(0);
  });
});

describe('observeRunConstraints', () => {
  const AT_START: MachineMemoryEvents = { oomKills: 2 };

  it("differences the counter across the run's span", () => {
    expect(observeRunConstraints(AT_START, { oomKills: 5 })).toEqual({ machineOomKills: 3 });
  });

  it('leaves a difference absent where the counter was unreadable at the start', () => {
    expect(
      observeRunConstraints({ oomKills: undefined }, AT_START).machineOomKills
    ).toBeUndefined();
  });

  it('leaves a difference absent where the counter was unreadable at the end', () => {
    expect(
      observeRunConstraints(AT_START, { oomKills: undefined }).machineOomKills
    ).toBeUndefined();
  });
});

describe('createRunSplitRecorder', () => {
  const RUNNER = 500;
  const TREE = 400;

  interface Scripted {
    readonly workers: readonly number[];
    readonly roots: readonly (readonly [number, number])[];
    readonly remainderKb?: number | undefined;
  }

  /** A recorder fed one fixed reading per sample, in order. */
  function scripted(samples: readonly Scripted[]): {
    recorder: RunSplitRecorder;
    asked: number[][];
  } {
    const queue = [...samples];
    const asked: number[][] = [];
    let current: Scripted | undefined;
    const recorder = createRunSplitRecorder(RUNNER, {
      listWorkers: () => {
        current = queue.shift();
        return current?.workers ?? [];
      },
      sample: (_treeRootPid, rootPids) => {
        asked.push([...rootPids]);
        return Promise.resolve({
          rootsKb: new Map(current?.roots),
          remainderKb: current?.remainderKb,
        });
      },
    });
    return { recorder, asked };
  }

  const STEADY: Scripted = {
    workers: [11, 12],
    roots: [
      [11, 100],
      [12, 300],
    ],
    remainderKb: 50,
  };

  it("charges everything outside the workers' subtrees to the fixed cost, and nothing else", async () => {
    const { recorder } = scripted([STEADY, STEADY]);
    await recorder.sample(TREE);
    await recorder.sample(TREE);
    expect(recorder.stop().fixedKb).toBe(50);
  });

  it('returns the whole tree total, so one peak tracker can drive the sampling', async () => {
    const { recorder } = scripted([STEADY]);
    expect(await recorder.sample(TREE)).toBe(450);
  });

  it("hands the sampler the runner's live children as its roots", async () => {
    const { recorder, asked } = scripted([STEADY]);
    await recorder.sample(TREE);
    expect(asked).toEqual([[11, 12]]);
  });

  /** Four lanes holding a dear tree, then six holding almost nothing. */
  const DEAR_AT_FOUR: Scripted = {
    workers: [11, 12, 13, 14],
    roots: [
      [11, 200],
      [12, 200],
      [13, 200],
      [14, 200],
    ],
    remainderKb: 100,
  };
  const CHEAP_AT_SIX: Scripted = {
    workers: [11, 12, 13, 14, 15, 16],
    roots: [[11, 60]],
    remainderKb: 10,
  };

  it('names the lanes live at the sample that read the highest tree total', async () => {
    const { recorder } = scripted([DEAR_AT_FOUR, CHEAP_AT_SIX]);
    await recorder.sample(TREE);
    await recorder.sample(TREE);
    expect(recorder.stop().lanesAtPeak).toBe(4);
  });

  it('names those lanes whichever order the samples arrive in', async () => {
    const { recorder } = scripted([CHEAP_AT_SIX, DEAR_AT_FOUR]);
    await recorder.sample(TREE);
    await recorder.sample(TREE);
    expect(recorder.stop().lanesAtPeak).toBe(4);
  });

  it('names no lanes for a sample nothing in the tree could be read from', async () => {
    const { recorder } = scripted([{ workers: [11, 12], roots: [], remainderKb: undefined }]);
    await recorder.sample(TREE);
    expect(recorder.stop().lanesAtPeak).toBeUndefined();
  });

  it('names no lanes before it has read anything at all', () => {
    const { recorder } = scripted([]);
    expect(recorder.stop().lanesAtPeak).toBeUndefined();
  });

  it('keeps the highest fixed cost it saw', async () => {
    const { recorder } = scripted([
      { ...STEADY, remainderKb: 50 },
      { ...STEADY, remainderKb: 900 },
      { ...STEADY, remainderKb: 200 },
    ]);
    await recorder.sample(TREE);
    await recorder.sample(TREE);
    await recorder.sample(TREE);
    expect(recorder.stop().fixedKb).toBe(900);
  });

  it('charges no per-worker figure over a count that leaves out forks it charged', async () => {
    const four: Scripted = {
      workers: [11, 12, 13, 14],
      roots: [
        [11, 300],
        [12, 300],
        [13, 300],
        [14, 300],
      ],
      remainderKb: 1,
    };
    const three: Scripted = {
      workers: [11, 12, 13],
      roots: [
        [11, 300],
        [12, 300],
        [13, 300],
      ],
      remainderKb: 1,
    };
    const { recorder } = scripted([four, three]);
    await recorder.sample(TREE);
    await recorder.sample(TREE);
    expect(recorder.stop().fixedKb).toBe(1);
  });

  it('keeps a fixed cost it read once, through a later sample that could not read one', async () => {
    const { recorder } = scripted([
      { ...STEADY, remainderKb: 400 },
      { ...STEADY, remainderKb: undefined },
    ]);
    await recorder.sample(TREE);
    await recorder.sample(TREE);
    expect(recorder.stop().fixedKb).toBe(400);
  });

  it('leaves the fixed cost absent where nothing outside the workers could be read', async () => {
    const { recorder } = scripted([{ workers: [11], roots: [[11, 400]], remainderKb: undefined }]);
    await recorder.sample(TREE);
    expect(recorder.stop().fixedKb).toBeUndefined();
  });

  it('reports no total for a tree nothing could be read under', async () => {
    const { recorder } = scripted([{ workers: [11], roots: [], remainderKb: undefined }]);
    expect(await recorder.sample(TREE)).toBeUndefined();
  });

  it('keeps the most direct children it ever saw the runner holding', async () => {
    const { recorder } = scripted([
      { workers: [11], roots: [[11, 100]], remainderKb: 50 },
      STEADY,
      { workers: [11], roots: [[11, 100]], remainderKb: 50 },
    ]);
    await recorder.sample(TREE);
    await recorder.sample(TREE);
    await recorder.sample(TREE);
    expect(recorder.peakRunnerChildren()).toBe(2);
  });

  it('counts no child for a runner the process table states none for', async () => {
    const { recorder } = scripted([{ workers: [], roots: [], remainderKb: 50 }]);
    await recorder.sample(TREE);
    expect(recorder.peakRunnerChildren()).toBe(0);
  });
});

describe('the machine readings a caller gets by default', () => {
  it('enumerates and samples this machine where no readings are injected', async () => {
    const recorder = createRunSplitRecorder(process.pid);
    await recorder.sample(process.pid);
    await recorder.sample(process.pid);
    expect(Object.keys(recorder.stop())).toEqual(['peakKb', 'lanesAtPeak', 'fixedKb']);
  });

  it('drives those same readings from the tracker', () => {
    const tracker = trackRunSplit({
      treeRootPid: process.pid,
      runnerPid: process.pid,
      intervalMs: 250,
    });
    expect(Object.keys(tracker.stop().split)).toEqual(['fixedRssKb']);
  });
});

describe('shapeFault', () => {
  it('reports a fault where a run that collected files declared no worker', () => {
    expect(shapeFault({ declaredWorkers: 0, fileCount: 2 })).toMatch(
      /declared 0 worker\(s\) for 2 files/
    );
  });

  it('reports a fault where a run that collected files declared a negative count', () => {
    expect(shapeFault({ declaredWorkers: -1, fileCount: 2 })).toMatch(/declared -1 worker/);
  });

  it('reports nothing where a batch smaller than the declared count collected files', () => {
    expect(shapeFault({ declaredWorkers: 4, fileCount: 2 })).toBeUndefined();
  });

  it('reports nothing where a batch larger than the declared count collected files', () => {
    expect(shapeFault({ declaredWorkers: 4, fileCount: 40 })).toBeUndefined();
  });

  it('reports nothing where a run that collected no file declared no worker', () => {
    expect(shapeFault({ declaredWorkers: 0, fileCount: 0 })).toBeUndefined();
  });

  it('reports a fault where a many-worker run held one direct child throughout', () => {
    expect(shapeFault({ declaredWorkers: 24, fileCount: 900, peakRunnerChildren: 1 })).toMatch(
      /one direct child/
    );
  });

  it('reports nothing where the run held as many children as it declared workers', () => {
    expect(
      shapeFault({ declaredWorkers: 24, fileCount: 900, peakRunnerChildren: 24 })
    ).toBeUndefined();
  });

  it('reports nothing where the process table stated no child at all', () => {
    expect(
      shapeFault({ declaredWorkers: 24, fileCount: 900, peakRunnerChildren: 0 })
    ).toBeUndefined();
  });

  it('reports nothing where the run that held one child declared one worker', () => {
    expect(
      shapeFault({ declaredWorkers: 1, fileCount: 900, peakRunnerChildren: 1 })
    ).toBeUndefined();
  });

  it('reports nothing where the run that held one child collected one file', () => {
    expect(
      shapeFault({ declaredWorkers: 24, fileCount: 1, peakRunnerChildren: 1 })
    ).toBeUndefined();
  });
});

describe('createRunSplitRecorder with no runner', () => {
  it('charges nothing as a worker, and does not ask which children a runner has', async () => {
    let asked = 0;
    const recorder = createRunSplitRecorder(undefined, {
      listWorkers: () => {
        asked += 1;
        return [11];
      },
      sample: (_treeRootPid, rootPids) =>
        Promise.resolve({ rootsKb: new Map(rootPids.map((pid) => [pid, 900])), remainderKb: 70 }),
    });
    await recorder.sample(400);
    await recorder.sample(400);
    expect(asked).toBe(0);
    expect(recorder.stop().fixedKb).toBe(70);
  });

  it('counts no direct child, because it charged nothing as a worker', async () => {
    const recorder = createRunSplitRecorder(undefined, {
      listWorkers: () => [11],
      sample: () => Promise.resolve({ rootsKb: new Map(), remainderKb: 70 }),
    });
    await recorder.sample(400);
    expect(recorder.peakRunnerChildren()).toBe(0);
  });
});

describe('trackRunSplit', () => {
  const RUNNER = 500;
  const TREE = 400;

  afterEach(() => {
    vi.useRealTimers();
  });

  function deps(readings: readonly number[]): RunSplitDeps {
    const queue = [...readings];
    return {
      listWorkers: () => [11],
      sample: () => {
        const rootKb = queue.shift() ?? 0;
        return Promise.resolve({
          rootsKb: new Map([[11, rootKb]]),
          remainderKb: 10,
        });
      },
    };
  }

  it('samples once up front, so a run shorter than the interval still reads its tree', async () => {
    vi.useFakeTimers();
    const tracker = trackRunSplit(
      { treeRootPid: TREE, runnerPid: RUNNER, intervalMs: 250 },
      deps([70])
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(tracker.stop().peakRssKb).toBe(80);
  });

  it("carries out the baseline the readings measured as the run's fixed cost", async () => {
    // Every other figure the same stop answers with is a different number here,
    // so this fails for a fixed cost taken from any of them. What the row the
    // recorder feeds prices the next run's projection against is this figure,
    // and a tree total standing in for it reads as a machine whose whole
    // footprint is overhead.
    vi.useFakeTimers();
    const tracker = trackRunSplit(
      { treeRootPid: TREE, runnerPid: RUNNER, intervalMs: 250 },
      deps([70])
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(tracker.stop().split).toEqual({ fixedRssKb: 10 });
  });

  it('keeps the highest tree total it sampled', async () => {
    vi.useFakeTimers();
    const tracker = trackRunSplit(
      { treeRootPid: TREE, runnerPid: RUNNER, intervalMs: 250 },
      deps([70, 900, 80])
    );
    await vi.advanceTimersByTimeAsync(600);
    expect(tracker.stop().peakRssKb).toBe(910);
  });

  it('skips a tick while a sample it already asked for is outstanding', async () => {
    vi.useFakeTimers();
    let asked = 0;
    const tracker = trackRunSplit(
      { treeRootPid: TREE, runnerPid: RUNNER, intervalMs: 250 },
      {
        listWorkers: () => [11],
        sample: () => {
          asked += 1;
          return new Promise(() => undefined);
        },
      }
    );
    await vi.advanceTimersByTimeAsync(1000);
    tracker.stop();
    expect(asked).toBe(1);
  });

  it('drops a reading that lands after the tracker stopped', async () => {
    vi.useFakeTimers();
    let land: (reading: AttributedTreePssKb) => void = (_reading) => undefined;
    const tracker = trackRunSplit(
      { treeRootPid: TREE, runnerPid: RUNNER, intervalMs: 250 },
      {
        listWorkers: () => [11],
        sample: () =>
          new Promise<AttributedTreePssKb>((resolve) => {
            land = resolve;
          }),
      }
    );
    await vi.advanceTimersByTimeAsync(0);
    tracker.stop();
    land({ rootsKb: new Map([[11, 900]]), remainderKb: 5 });
    await vi.advanceTimersByTimeAsync(0);
    expect(tracker.stop().peakRssKb).toBeUndefined();
  });

  it('files no width off a reading its peak did not come out of', async () => {
    // The loop drops a reading that lands after the stop. Whatever answers for
    // the width has to drop the same one, or the row pairs a width read at one
    // moment with a peak read at another — and a heavy peak filed at a narrow
    // width pins a low rung high and costs lanes at every wider count.
    vi.useFakeTimers();
    let land: (reading: AttributedTreePssKb) => void = (_reading) => undefined;
    const widths = [
      [11, 12],
      [11, 12, 13, 14, 15, 16],
    ];
    let taken = 0;
    const tracker = trackRunSplit(
      { treeRootPid: TREE, runnerPid: RUNNER, intervalMs: 250 },
      {
        listWorkers: () => widths[taken] ?? [],
        sample: () => {
          const index = taken;
          taken += 1;
          if (index === 0) {
            return Promise.resolve({ rootsKb: new Map([[11, 100]]), remainderKb: 10 });
          }
          return new Promise<AttributedTreePssKb>((resolve) => {
            land = resolve;
          });
        },
      }
    );
    await vi.advanceTimersByTimeAsync(250);
    tracker.stop();
    land({ rootsKb: new Map([[11, 900]]), remainderKb: 5 });
    await vi.advanceTimersByTimeAsync(0);
    const tracked = tracker.stop();
    expect(tracked.peakRssKb).toBe(110);
    expect(tracked.lanesAtPeak).toBe(2);
  });

  it('names no lanes where nothing in the tree could be read at all', async () => {
    vi.useFakeTimers();
    const tracker = trackRunSplit(
      { treeRootPid: TREE, runnerPid: RUNNER, intervalMs: 250 },
      {
        listWorkers: () => [],
        sample: () => Promise.resolve({ rootsKb: new Map(), remainderKb: undefined }),
      }
    );
    await vi.advanceTimersByTimeAsync(600);
    expect(tracker.stop().lanesAtPeak).toBeUndefined();
  });

  it('names no lanes for a reading it kept no peak from', async () => {
    vi.useFakeTimers();
    let land: (reading: AttributedTreePssKb) => void = (_reading) => undefined;
    const tracker = trackRunSplit(
      { treeRootPid: TREE, runnerPid: RUNNER, intervalMs: 250 },
      {
        listWorkers: () => [11],
        sample: () =>
          new Promise<AttributedTreePssKb>((resolve) => {
            land = resolve;
          }),
      }
    );
    await vi.advanceTimersByTimeAsync(0);
    tracker.stop();
    land({ rootsKb: new Map([[11, 900]]), remainderKb: 5 });
    await vi.advanceTimersByTimeAsync(0);
    expect(tracker.stop().lanesAtPeak).toBeUndefined();
  });

  it('carries out the lanes that were live when it took its highest reading', async () => {
    vi.useFakeTimers();
    const samples = [
      { workers: [11, 12, 13, 14, 15], totalKb: 70 },
      { workers: [11, 12], totalKb: 900 },
    ];
    const queue = [...samples];
    let current = samples[0] as { workers: readonly number[]; totalKb: number };
    const tracker = trackRunSplit(
      { treeRootPid: TREE, runnerPid: RUNNER, intervalMs: 250 },
      {
        listWorkers: () => {
          current = queue.shift() ?? current;
          return current.workers;
        },
        sample: () =>
          Promise.resolve({ rootsKb: new Map([[11, current.totalKb]]), remainderKb: 0 }),
      }
    );
    await vi.advanceTimersByTimeAsync(600);
    expect(tracker.stop().lanesAtPeak).toBe(2);
  });

  it('carries the most direct children it saw out with the rest of the readings', async () => {
    vi.useFakeTimers();
    const tracker = trackRunSplit(
      { treeRootPid: TREE, runnerPid: RUNNER, intervalMs: 250 },
      deps([70])
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(tracker.stop().peakRunnerChildren).toBe(1);
  });

  it('takes no further sample once stopped', async () => {
    vi.useFakeTimers();
    const tracker = trackRunSplit(
      { treeRootPid: TREE, runnerPid: RUNNER, intervalMs: 250 },
      deps([70, 900])
    );
    await vi.advanceTimersByTimeAsync(0);
    const stopped = tracker.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(stopped.peakRssKb).toBe(80);
  });
});

describe('repoRelativeTestFile', () => {
  it('keys a file by its path within the repository, spelled one way on every platform', () => {
    expect(
      repoRelativeTestFile(path.join('a', 'repo'), path.join('a', 'repo', 'pkg', 'x.test.ts'))
    ).toBe('pkg/x.test.ts');
  });
});

describe('measureTestFiles', () => {
  const REPO_ROOT = path.join(path.sep, 'repo');
  function entry(name: string, wallMs: number): NonNullable<VitestJsonReport['testResults']>[0] {
    return { name: path.join(REPO_ROOT, name), startTime: 1000, endTime: 1000 + wallMs };
  }

  it('keys a file on its path within the repository', () => {
    const measured = measureTestFiles(REPO_ROOT, { testResults: [entry('pkg/a.test.ts', 40)] });
    expect(measured.map((file) => file.file)).toEqual(['pkg/a.test.ts']);
  });

  it('carries the wall the report weighed the file at', () => {
    const measured = measureTestFiles(REPO_ROOT, { testResults: [entry('pkg/a.test.ts', 40)] });
    expect(measured[0]?.wallMs).toBe(40);
  });

  it('sums the walls of a file its run collected under more than one project', () => {
    const measured = measureTestFiles(REPO_ROOT, {
      testResults: [entry('pkg/a.test.ts', 40), entry('pkg/a.test.ts', 60)],
    });
    expect(measured).toEqual([{ file: 'pkg/a.test.ts', wallMs: 100 }]);
  });

  it('leaves a file the report could not weigh out of the set', () => {
    const measured = measureTestFiles(REPO_ROOT, {
      testResults: [{ name: path.join(REPO_ROOT, 'pkg/a.test.ts'), status: 'passed' }],
    });
    expect(measured).toEqual([]);
  });

  it('passes over a report entry the runner wrote without naming a file', () => {
    const measured = measureTestFiles(REPO_ROOT, {
      testResults: [{ startTime: 1000, endTime: 1040 }, entry('pkg/a.test.ts', 40)],
    });
    expect(measured.map((file) => file.file)).toEqual(['pkg/a.test.ts']);
  });

  it('measures no file where the report carries no result at all', () => {
    expect(measureTestFiles(REPO_ROOT, {})).toEqual([]);
  });

  it('measures no file where the run wrote no report', () => {
    const report: VitestJsonReport | undefined = undefined;
    expect(measureTestFiles(REPO_ROOT, report)).toEqual([]);
  });

  it('weighs the same population the run-wide wall total is taken over', () => {
    const report: VitestJsonReport = {
      testResults: [
        entry('pkg/a.test.ts', 40),
        entry('pkg/b.test.ts', 60),
        { name: path.join(REPO_ROOT, 'pkg/c.test.ts'), status: 'passed' },
      ],
    };
    const total = measureTestFiles(REPO_ROOT, report).reduce((sum, f) => sum + f.wallMs, 0);
    expect(total).toBe(sumFileWallMs(report));
  });
});
