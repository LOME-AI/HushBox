import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  coverageSection,
  describeLastRun,
  formatReport,
  LANE_DECLARATION_PATTERN,
  LANE_MECHANISMS,
  LANE_SITE_SCOPE,
  memoryAccount,
  memorySection,
  poolNote,
  poolTaskEstimates,
  packageVitestTaskStatus,
  playwrightTaskStatus,
  poolTaskStatus,
  rowObservationNote,
  vitestTaskStatus,
  summariseRuns,
  type LaneMechanism,
  type MachineSummary,
  type MemoryAccount,
  type MemoryAccountInput,
  type TaskStatus,
} from './concurrency-report.js';
import {
  derivationBasis,
  deriveConcurrency,
  type PoolTaskEstimate,
  type RunObservation,
} from './schedule.js';
import {
  describeVitestDerivation,
  deriveVitestWorkers,
  type VitestWorkerDerivation,
} from '../vitest/workers.js';

function run(concurrency: number, makespanSec: number, peakRssKb?: number): RunObservation {
  return {
    concurrency,
    taskCount: 18,
    sumWallMs: 1_274_000,
    longestWallMs: 299_000,
    makespanMs: makespanSec * 1000,
    ...(peakRssKb === undefined ? {} : { peakRssKb }),
  };
}

const MACHINE: MachineSummary = {
  fingerprint: '4c739291c467',
  cpuModel: '13th Gen Intel(R) Core(TM) i9-13900H',
  threads: 20,
  cores: 6,
  totalMemBytes: 33_259_417_600,
};

describe('summariseRuns', () => {
  it('counts runs per lane count, highest first', () => {
    expect(summariseRuns([run(10, 324), run(5, 300), run(5, 305)])).toBe('N=10 x1, N=5 x2');
  });

  it('is a dash when nothing has been recorded', () => {
    expect(summariseRuns([])).toBe('—');
  });
});

describe('describeLastRun', () => {
  it('reports the most recent run, not the best one', () => {
    expect(describeLastRun([run(10, 324, 25_880_000), run(5, 300, 16_820_000)])).toBe(
      '300s / 17.2 GB'
    );
  });

  it('says so when the platform could not measure a peak', () => {
    expect(describeLastRun([run(5, 300)])).toContain('peak unmeasured');
  });

  it('is a dash when nothing has been recorded', () => {
    expect(describeLastRun([])).toBe('—');
  });
});

describe('poolNote', () => {
  it('reports how full the last run held its lanes, and over how many tasks', () => {
    const note = poolNote({ bound: 'work' }, [run(10, 324)]);
    expect(note).toContain('0.39');
    expect(note).toContain('18 task(s)');
    expect(note).toContain('N=10');
  });

  it('distinguishes a number read off recorded walls from the ceiling', () => {
    expect(poolNote({ bound: 'work' }, [run(5, 300)])).toMatch(/recorded walls/);
    expect(poolNote({ bound: 'ceiling' }, [run(5, 300)])).toMatch(/ceiling/);
  });

  it('names the projection where the descent is what set the count', () => {
    expect(poolNote({ bound: 'memory' }, [run(5, 300)])).toMatch(/memory-bound/);
  });

  it('says nothing has held any width where no run is on record', () => {
    expect(poolNote({ bound: 'unmeasured' }, [])).toMatch(/no run on record/);
    expect(poolNote({ bound: 'unmeasured' }, [])).toMatch(/has held/);
  });

  it('opens a first run’s clause with the same word the state column prints', () => {
    for (const bound of ['work', 'ceiling', 'memory', 'unmeasured'] as const) {
      expect(poolNote({ bound }, []).startsWith(derivationBasis({ bound }))).toBe(true);
    }
  });

  /**
   * The note and the state column are one claim seen twice, so the note opens
   * with the column's own word rather than with prose that agrees with it today.
   */
  it('opens with the word the state column prints for the same count', () => {
    for (const bound of ['work', 'ceiling', 'memory', 'unmeasured'] as const) {
      expect(poolNote({ bound }, [run(5, 300)]).startsWith(derivationBasis({ bound }))).toBe(true);
    }
  });
});

describe('poolTaskEstimates', () => {
  it("carries each entry's walls, which is every figure a bound still reads off a unit", () => {
    expect(poolTaskEstimates({ a: { wallsMs: [100_000] } })).toEqual([
      { name: 'a', wallsMs: [100_000] },
    ]);
  });
});

describe('poolTaskStatus', () => {
  /** A handed-down share four of the peaks below overrun, and three fit. */
  const SHARE_KB = 16_000_000;

  /** A task set with walls on record, so the work bound has something to schedule. */
  function measured(count: number): PoolTaskEstimate[] {
    return Array.from({ length: count }, (_, index) => ({
      name: `package-${String(index)}`,
      wallsMs: [100_000],
    }));
  }

  /** A width on record that overran the share, so the descent has a rung to read. */
  const WITH_FIXED: RunObservation = {
    ...run(8, 300, 24_000_000),
    fixedRssKb: 1_000_000,
    lanesAtPeak: 4,
  };

  it('caps a count against a width the record says overran the budget, and says so', () => {
    const status = poolTaskStatus({
      task: 'lint',
      tasks: measured(8),
      runs: [WITH_FIXED],
      ceiling: 8,
      memoryBudgetKb: SHARE_KB,
    });
    // The one rung is four lanes wide at 24.0GB over a 1.0GB baseline, so the
    // line below it prices three lanes at 18.25GB — over the share — and two
    // at 12.5GB, which fits.
    expect(status.concurrency).toBe(2);
    expect(status.state).toBe('memory-bound');
  });

  it('leaves a task set with no peak on record at the count its work shape asks for', () => {
    const status = poolTaskStatus({
      task: 'lint',
      tasks: [],
      runs: [],
      ceiling: 8,
      memoryBudgetKb: SHARE_KB,
    });
    expect(status.concurrency).toBe(8);
    expect(status.state).toBe('cold-start');
  });

  it('names the ceiling for a count no wall shaped and the projection admitted', () => {
    const status = poolTaskStatus({
      task: 'lint',
      tasks: measured(8).map((task) => ({ ...task, wallsMs: [] })),
      runs: [{ ...run(8, 300, 2_000_000), fixedRssKb: 1_000_000, lanesAtPeak: 8 }],
      ceiling: 8,
      memoryBudgetKb: SHARE_KB,
    });
    expect(status.state).toBe('ceiling');
  });

  it('answers an unnamed task set with what a run over that many unmeasured packages derives', () => {
    const ceiling = 8;
    const unmeasured: PoolTaskEstimate[] = Array.from({ length: ceiling }, (_, index) => ({
      name: `package-${String(index)}`,
    }));
    const real = deriveConcurrency({
      tasks: unmeasured,
      observations: [],
      maxConcurrency: ceiling,
      memoryBudgetKb: SHARE_KB,
    });
    const reported = poolTaskStatus({
      task: 'lint',
      tasks: [],
      runs: [],
      ceiling,
      memoryBudgetKb: SHARE_KB,
    });
    expect(reported.concurrency).toBe(real.concurrency);
  });

  it('still opens the ceiling for an unnamed task set the budget leaves room for', () => {
    const status = poolTaskStatus({
      task: 'typecheck',
      tasks: [],
      runs: [],
      ceiling: 4,
      memoryBudgetKb: 100_000_000,
    });
    expect(status.concurrency).toBe(4);
    expect(status.state).toBe('cold-start');
  });

  it('reads the walls a ledger does name instead of standing in for them', () => {
    const status = poolTaskStatus({
      task: 'lint',
      tasks: [
        { name: 'a', wallsMs: [100_000] },
        { name: 'b', wallsMs: [100_000] },
      ],
      runs: [],
      ceiling: 8,
      memoryBudgetKb: 100_000_000,
    });
    expect(status.concurrency).toBe(2);
    expect(status.state).toBe('work-bound');
  });

  it('carries a memory account naming the budget its count was checked against', () => {
    const status = poolTaskStatus({
      task: 'lint',
      tasks: measured(8),
      runs: [WITH_FIXED],
      ceiling: 8,
      memoryBudgetKb: SHARE_KB,
    });
    expect(status.memory?.budgetKb).toBe(SHARE_KB);
    expect(status.memory?.rungs.map(({ rung }) => rung.lanes)).toEqual([4]);
  });

  it('carries the task name and its ledger runs into the row that reports them', () => {
    const runs = [run(5, 300, 16_820_000)];
    const status = poolTaskStatus({ task: 'lint', tasks: [], runs, ceiling: 4 });
    expect(status.task).toBe('lint');
    expect(status.runs).toBe(runs);
    expect(status.tuned).toBe(true);
    expect(status.note).toContain('N=5');
  });
});

describe('vitestTaskStatus', () => {
  const DERIVATION: VitestWorkerDerivation = {
    workers: 19,
    state: 'derived',
    bound: 'work',
    memoryCapped: false,
    memoryGuarded: true,
    units: 800,
  };

  /**
   * The vocabulary a row about this count may not carry, asserted as a class
   * rather than against the one wording that once broke: the count had a
   * coefficient, the coefficient was deleted, and every text describing it
   * survived because each was spelled identically in source and in test, which
   * pins the two to each other and to nothing the code does.
   */
  const SCALED_COUNT = /coefficient|matrix|scal|tuned|multipl|factor/i;

  /** A recorded batch over `taskCount` packages, carrying whatever figures it measured. */
  function batch(taskCount: number, figures: Partial<RunObservation> = {}): RunObservation {
    return {
      concurrency: 19,
      taskCount,
      sumWallMs: 180_000,
      longestWallMs: 180_000,
      makespanMs: 180_000,
      peakRssKb: 6_000_000,
      ...figures,
    };
  }

  function status(runs: readonly RunObservation[]): TaskStatus {
    return vitestTaskStatus({ derivation: DERIVATION, runs, memoryBudgetKb: 20_000_000 });
  }

  it('names itself for the consolidated run, so the package-rooted row is a separate one', () => {
    expect(status([]).task).toBe('vitest-batch');
  });

  it('names what the count is taken from, so the row answers where it came from', () => {
    expect(status([]).note).toContain('one test file is one unit');
  });

  it('says how many units the count was derived over', () => {
    expect(status([]).note).toContain('800 test file(s) as units');
  });

  it('leaves the row, as it renders, claiming nothing arrived at the count by scaling', () => {
    const rendered = formatReport(MACHINE, [status([batch(12, { sumFileWallMs: 3_800_000 })])]);
    expect(rendered).not.toMatch(SCALED_COUNT);
  });

  it('reports the count it was handed, as a count the pool derives', () => {
    const reported = status([]);
    expect(reported.concurrency).toBe(19);
    expect(reported.tuned).toBe(true);
  });

  it('says so where nothing checked the count against a memory projection', () => {
    const reported = vitestTaskStatus({
      derivation: { ...DERIVATION, memoryGuarded: false },
      runs: [],
      memoryBudgetKb: 20_000_000,
    });
    expect(reported.note).toContain('memory-unguarded');
  });

  it('says so where the memory projection is what set the count', () => {
    const reported = vitestTaskStatus({
      derivation: { ...DERIVATION, bound: 'memory', memoryCapped: true },
      runs: [],
      memoryBudgetKb: 20_000_000,
    });
    expect(reported.state).toBe('memory-bound');
  });

  it("reports a recorded run's test work per worker, from the recorded total", () => {
    expect(status([batch(12, { sumFileWallMs: 3_800_000 })]).note).toContain(
      '200s of test work per worker'
    );
  });

  /**
   * The roster a row covered decides nothing here any more: the ladder files a
   * peak by the lanes live when it was set and compares across set sizes on
   * purpose, so a run over one package is evidence beside a run over twelve.
   */
  it('reads a run whatever roster it covered, rather than the rows matching one size', () => {
    expect(status([batch(1, { sumFileWallMs: 3_800_000 })]).note).toContain(
      '200s of test work per worker'
    );
  });

  it('says so where no recorded run carries any test work at all', () => {
    expect(status([batch(12)]).note).toContain('no recorded run carries any test work');
  });

  it('spans the recorded runs that disagree about the work behind them', () => {
    const reported = status([
      batch(12, { sumFileWallMs: 190_000 }),
      batch(12, { sumFileWallMs: 3_800_000 }),
    ]);
    expect(reported.note).toContain('10s to 200s of test work per worker');
    expect(reported.note).toContain('the newest of them 200s');
  });

  /**
   * One store holds every vitest invocation, so the span runs over single-file
   * runs as well as consolidated ones. Left unqualified on this row, a reader
   * takes the low end for a fast consolidated run rather than for a run of one
   * file.
   */
  it('says its columns and its work span every shape of run, not the consolidated one alone', () => {
    const reported = status([
      batch(12, { sumFileWallMs: 190_000 }),
      batch(12, { sumFileWallMs: 3_800_000 }),
    ]);
    expect(reported.note).toContain('are every shape of run rather than this row’s alone');
  });

  it('reads the newest run that carries work, not the newest run', () => {
    expect(status([batch(12, { sumFileWallMs: 3_800_000 }), batch(1)]).note).toContain(
      '200s of test work per worker'
    );
  });

  it("takes the run's work from its recorded total, never from the mean and the file count", () => {
    const divergent = batch(1, {
      concurrency: 1,
      perFileWallMs: 900,
      fileCount: 3,
      sumFileWallMs: 900,
    });
    expect(status([divergent]).note).toContain('1s of test work per worker');
  });

  it('is unmoved by a file count wider than the population the run could weigh', () => {
    const weighed = { concurrency: 1, perFileWallMs: 900, sumFileWallMs: 900 };
    expect(status([batch(1, { ...weighed, fileCount: 3 })]).note).toBe(
      status([batch(1, { ...weighed, fileCount: 300 })]).note
    );
  });
});

describe('formatReport', () => {
  // The real row rather than a hand-written stand-in: a fixture spelling the
  // wording out a second time is what let the untuned row's text go on
  // describing a mechanism the code had stopped having.
  const VITEST_ROW = vitestTaskStatus({
    derivation: {
      workers: 16,
      state: 'derived',
      bound: 'work',
      memoryCapped: false,
      memoryGuarded: true,
      units: 800,
    },
    runs: [],
    memoryBudgetKb: 20_000_000,
  });
  const statuses: readonly TaskStatus[] = [
    {
      task: 'lint',
      concurrency: 5,
      state: 'derived',
      tuned: true,
      runs: [run(10, 324, 25_880_000), run(5, 300, 16_820_000)],
      note: 'derived from recorded walls — last run held 0.85 of its lanes',
    },
    VITEST_ROW,
  ];

  /**
   * The lane count a run was started with and the lane count its peak was held
   * at are different figures, and the memory section reports the second. A
   * header calling the first "observations" invites a reader to read the two
   * sections as one set of rows.
   */
  it('heads the launched-width column for what it holds, not for the widths held', () => {
    const report = formatReport(MACHINE, statuses);
    expect(report).toContain('launched at');
    expect(report).not.toContain('observations');
  });

  it('names the machine its numbers belong to', () => {
    const report = formatReport(MACHINE, statuses);
    expect(report).toContain('4c739291c467');
    expect(report).toContain('20 threads / 6 cores');
  });

  it('gives every task a row carrying its resolved lane count', () => {
    const report = formatReport(MACHINE, statuses);
    const lintRow = report.split('\n').find((line) => line.startsWith('lint '));
    expect(lintRow).toContain('derived');
    expect(lintRow).toContain('N=10 x1, N=5 x1');
  });

  it('shows an untuned check alongside the tuned ones rather than hiding it', () => {
    expect(formatReport(MACHINE, statuses)).toContain('vitest');
  });

  it('keeps a value that overruns its column separated from the next one', () => {
    const row = formatReport(MACHINE, [{ ...statuses[0]!, state: 'cold-start, capped', runs: [] }])
      .split('\n')
      .find((line) => line.startsWith('lint '));
    expect(row).toMatch(/cold-start, capped +—/);
  });

  it('lines the columns up across task names of different lengths', () => {
    const rendered = formatReport(MACHINE, [
      { ...statuses[0]!, task: 'lint' },
      { ...statuses[0]!, task: 'vitest-batch' },
    ]).split('\n');
    const lint = rendered.find((line) => line.startsWith('lint'));
    const batch = rendered.find((line) => line.startsWith('vitest-batch'));
    expect(lint?.indexOf('N=')).toBe(batch?.indexOf('N='));
  });

  it('does not truncate a task whose name overruns its column', () => {
    const wide = formatReport(MACHINE, [{ ...statuses[0]!, task: 'a-very-long-task-name' }]);
    expect(wide).toContain('a-very-long-task-name');
  });

  it('carries every mechanism no row reports into the rendered report', () => {
    const report = formatReport(MACHINE, statuses);
    for (const mechanism of LANE_MECHANISMS.filter((entry) => entry.rows.length === 0)) {
      expect(report, mechanism.site).toContain(mechanism.site);
      expect(report, mechanism.site).toContain(mechanism.decides);
    }
  });

  it('explains each task below the table', () => {
    const report = formatReport(MACHINE, statuses);
    expect(report).toContain('lint: derived from recorded walls');
    expect(report).toContain(`${VITEST_ROW.task}: ${VITEST_ROW.note}`);
  });
});

describe('playwrightTaskStatus', () => {
  it('reports the count it was handed under a task name of its own', () => {
    const status = playwrightTaskStatus({ workers: 12, personaPoolSize: 12 });
    expect(status.task).toBe('playwright');
    expect(status.concurrency).toBe(12);
  });

  it('names the per-CPU registry the count is answered from', () => {
    expect(playwrightTaskStatus({ workers: 12, personaPoolSize: 12 }).note).toMatch(
      /per-CPU worker registry/
    );
  });

  it('reads the persona pool it was handed rather than the worker count', () => {
    const note = playwrightTaskStatus({ workers: 12, personaPoolSize: 14 }).note;
    expect(note).toContain('14');
    expect(note).not.toContain('12');
  });

  it('says a project may cap itself below the count, and that this command does not read that', () => {
    expect(playwrightTaskStatus({ workers: 12, personaPoolSize: 12 }).note).toMatch(
      /lower cap of its own.*does not read/
    );
  });

  it('carries no observations, and says so rather than leaving the column to speak', () => {
    const status = playwrightTaskStatus({ workers: 12, personaPoolSize: 12 });
    expect(status.runs).toEqual([]);
    expect(status.note).toMatch(/no.*observation/i);
  });
});

describe('packageVitestTaskStatus', () => {
  const PACKAGE_DERIVATION: VitestWorkerDerivation = {
    workers: 24,
    state: 'derived',
    bound: 'work',
    memoryCapped: false,
    memoryGuarded: true,
    units: 4,
  };

  it('reports the count it was handed under a task name of its own', () => {
    const status = packageVitestTaskStatus({
      derivation: PACKAGE_DERIVATION,
      runs: [],
      memoryBudgetKb: 20_000_000,
    });
    expect(status.task).toBe('vitest-pkg');
    expect(status.concurrency).toBe(24);
  });

  it('carries the derivation it was handed rather than a count of its own', () => {
    expect(
      packageVitestTaskStatus({
        derivation: PACKAGE_DERIVATION,
        runs: [],
        memoryBudgetKb: 20_000_000,
      }).note
    ).toContain(describeVitestDerivation(PACKAGE_DERIVATION));
  });

  it('says so where the memory projection is what set its count', () => {
    expect(
      packageVitestTaskStatus({
        derivation: { ...PACKAGE_DERIVATION, bound: 'memory', memoryCapped: true },
        runs: [],
        memoryBudgetKb: 20_000_000,
      }).state
    ).toBe('memory-bound');
  });

  it('says the count covers every file on record, not the files an invocation names', () => {
    expect(
      packageVitestTaskStatus({
        derivation: PACKAGE_DERIVATION,
        runs: [],
        memoryBudgetKb: 20_000_000,
      }).note
    ).toMatch(/the test files the invocation names/);
  });

  it('says the row derives over every file on record, not over a store of its own', () => {
    const note = packageVitestTaskStatus({
      derivation: PACKAGE_DERIVATION,
      runs: [],
      memoryBudgetKb: 20_000_000,
    }).note;
    expect(note).toMatch(/every file on record/);
    expect(note).not.toMatch(/its own store/);
  });

  it('claims of no more than the invocations that do that they narrow their unit set', () => {
    // A package's own test run derives over every file on record, exactly as
    // this row does, so that scoping it to one package cannot slow it. Only
    // the watch and single-file paths name a set of their own.
    const note = packageVitestTaskStatus({
      derivation: PACKAGE_DERIVATION,
      runs: [],
      memoryBudgetKb: 20_000_000,
    }).note;
    expect(note).toMatch(/watch or single-file/);
    expect(note).not.toMatch(/a real invocation names a narrower set/);
  });

  it('claims no file reaches its unit set from the batch store', () => {
    const note = packageVitestTaskStatus({
      derivation: PACKAGE_DERIVATION,
      runs: [],
      memoryBudgetKb: 20_000_000,
    }).note;
    expect(note).not.toMatch(/either store|both stores|batch store/);
  });

  it('names the ceiling for a count no wall shaped and the projection admitted', () => {
    const status = packageVitestTaskStatus({
      derivation: { ...PACKAGE_DERIVATION, state: 'cold-start', bound: 'ceiling' },
      runs: [],
      memoryBudgetKb: 20_000_000,
    });
    expect(status.state).toBe('ceiling');
  });

  it('names the projection where it is also what lowered that count', () => {
    const status = packageVitestTaskStatus({
      derivation: {
        ...PACKAGE_DERIVATION,
        state: 'cold-start',
        bound: 'memory',
        memoryCapped: true,
      },
      runs: [],
      memoryBudgetKb: 20_000_000,
    });
    expect(status.state).toBe('memory-bound');
  });

  it('still calls a count nothing on record reached a cold start', () => {
    const status = packageVitestTaskStatus({
      derivation: {
        ...PACKAGE_DERIVATION,
        state: 'cold-start',
        bound: 'unmeasured',
        memoryGuarded: false,
      },
      runs: [],
      memoryBudgetKb: 20_000_000,
    });
    expect(status.state).toBe('cold-start');
  });

  it('states its observations from the rows it carries rather than from a sentence of its own', () => {
    const status = packageVitestTaskStatus({
      derivation: PACKAGE_DERIVATION,
      runs: [],
      memoryBudgetKb: 20_000_000,
    });
    expect(status.note).toContain(rowObservationNote(status.runs));
  });

  it('names the one store every vitest invocation records into, not a ledger task of its own', () => {
    const note = packageVitestTaskStatus({
      derivation: PACKAGE_DERIVATION,
      runs: [],
      memoryBudgetKb: 20_000_000,
    }).note;
    expect(note).toMatch(/every vitest invocation records into one store/);
    expect(note).not.toMatch(/ledger task/);
  });

  /**
   * One store means this row and the consolidated one read the same history, so
   * a reader shown two counts would otherwise take them for two measurements.
   * What still separates them is the unit set, and the row says so itself.
   */
  it('says the units are what separate its count from the consolidated row’s', () => {
    expect(
      packageVitestTaskStatus({
        derivation: PACKAGE_DERIVATION,
        runs: [],
        memoryBudgetKb: 20_000_000,
      }).note
    ).toMatch(/differ only in the units they derive over/);
  });

  it('carries the rows it is handed rather than an empty set of its own', () => {
    const rows = [run(1, 4), run(1, 5)];
    expect(
      packageVitestTaskStatus({
        derivation: PACKAGE_DERIVATION,
        runs: rows,
        memoryBudgetKb: 20_000_000,
      }).runs
    ).toEqual(rows);
  });

  it('states its observations from the rows it carries, where it carries some', () => {
    const rows = [run(1, 4), run(1, 5)];
    const status = packageVitestTaskStatus({
      derivation: PACKAGE_DERIVATION,
      runs: rows,
      memoryBudgetKb: 20_000_000,
    });
    expect(status.note).toContain(rowObservationNote(status.runs));
  });
});

/**
 * The finding this vocabulary came from: the package-rooted row derives over
 * thousands of files of which a handful carry a wall, the work bound imputes
 * the largest known wall to every wall-less unit, and the count it lands on can
 * never bind — so the ceiling sets the count while the row called itself
 * wall-derived.
 */
describe('a row whose count rests on no recorded wall', () => {
  const WALL_LESS = Array.from({ length: 500 }, (_, index) => ({
    name: `unmeasured-${String(index)}.test.ts`,
  }));
  const ONE_WALL: PoolTaskEstimate[] = [
    { name: 'measured.test.ts', wallsMs: [10_000, 10_000, 10_000] },
    ...WALL_LESS,
  ];

  function rowOver(files: readonly PoolTaskEstimate[]): TaskStatus {
    return packageVitestTaskStatus({
      derivation: deriveVitestWorkers({ maxParallelism: 24, files }),
      runs: [],
      memoryBudgetKb: 20_000_000,
    });
  }

  it('names the ceiling as what set its count', () => {
    expect(rowOver(ONE_WALL).state).toBe('ceiling');
  });

  it('does not describe that count as wall-derived, in the column or in the note', () => {
    const status = rowOver(ONE_WALL);
    expect(status.state).not.toMatch(/derived/);
    expect(status.note).not.toContain('(derived)');
  });

  it('reports the same count it always did, since only the description was wrong', () => {
    expect(rowOver(ONE_WALL).concurrency).toBe(24);
    expect(rowOver(ONE_WALL).concurrency).toBe(rowOver(WALL_LESS).concurrency);
  });
});

describe('the state word, across every row that prints one', () => {
  const BOUNDS = ['work', 'ceiling', 'memory', 'unmeasured'] as const;

  const DERIVATION: VitestWorkerDerivation = {
    workers: 19,
    state: 'derived',
    bound: 'work',
    memoryCapped: false,
    memoryGuarded: true,
    units: 800,
  };

  it('is the vocabulary’s word for the bound, on both vitest rows', () => {
    for (const bound of BOUNDS) {
      const derivation = { ...DERIVATION, bound };
      const word = derivationBasis({ bound });
      expect(vitestTaskStatus({ derivation, runs: [], memoryBudgetKb: 20_000_000 }).state).toBe(
        word
      );
      expect(
        packageVitestTaskStatus({ derivation, runs: [], memoryBudgetKb: 20_000_000 }).state
      ).toBe(word);
    }
  });

  it('is the vocabulary’s word for the bound the pool row’s own derivation reached', () => {
    const shapes: readonly { readonly tasks: PoolTaskEstimate[]; readonly ceiling: number }[] = [
      { tasks: [{ name: 'a' }, { name: 'b' }], ceiling: 8 },
      { tasks: [{ name: 'a', wallsMs: [100_000] }], ceiling: 8 },
      {
        tasks: Array.from({ length: 20 }, (_, index) => ({
          name: `p${String(index)}`,
          wallsMs: [100_000],
        })),
        ceiling: 4,
      },
    ];
    for (const { tasks, ceiling } of shapes) {
      const derived = deriveConcurrency({ tasks, observations: [], maxConcurrency: ceiling });
      const status = poolTaskStatus({ task: 'lint', tasks, runs: [], ceiling });
      expect(status.state).toBe(derivationBasis(derived));
    }
  });
});

describe('rowObservationNote', () => {
  it('says a row carries no observation where it holds none', () => {
    expect(rowObservationNote([])).toMatch(/no observation/);
  });

  it('counts the rows a row holds rather than going on reporting none', () => {
    expect(rowObservationNote([run(4, 9), run(4, 10)])).toMatch(/2 run/);
  });

  /**
   * The rows reaching this note come from the one store every vitest
   * invocation records into, so they are every shape's; a note calling them one
   * shape's would be counting a history the row does not have.
   */
  it('counts every run on record rather than claiming they share one shape', () => {
    expect(rowObservationNote([run(4, 9)])).not.toMatch(/that shape/);
    expect(rowObservationNote([])).not.toMatch(/that shape/);
  });
});

describe('coverageSection', () => {
  const CARRIED: LaneMechanism = { site: 'a.config.ts', decides: 'the a count', rows: ['a'] };
  const UNCARRIED: LaneMechanism = { site: 'b.config.ts', decides: 'the b count', rows: [] };

  it('names a mechanism no row carries, and what that mechanism decides', () => {
    const text = coverageSection([CARRIED, UNCARRIED]);
    expect(text).toContain('b.config.ts');
    expect(text).toContain('the b count');
  });

  it('leaves out a mechanism a row already carries', () => {
    expect(coverageSection([CARRIED, UNCARRIED])).not.toContain('a.config.ts');
  });

  it('still says the set was not derived when every mechanism has a row', () => {
    const text = coverageSection([CARRIED]);
    expect(text).toMatch(/derive/);
    expect(text).not.toContain('b.config.ts');
  });

  it('names the scope its gate sweeps, so a reader can see what it would not catch', () => {
    expect(coverageSection([CARRIED])).toContain(LANE_SITE_SCOPE.describes);
  });

  it('names every directory the sweep does not enter, so the stated reach is the real one', () => {
    const text = coverageSection([CARRIED]);
    for (const directory of LANE_SITE_SCOPE.unswept) expect(text, directory).toContain(directory);
  });
});

describe('the printed scope against the predicate that enforces it', () => {
  /**
   * Names wide enough to hold the scope in both directions — several the
   * sentence could claim and several it does not — so what the case checks is
   * set equality and not a count.
   */
  const CANDIDATES = [
    'vitest.config.ts',
    'packages/config/vitest.config.mts',
    'a/b/tool.config.mjs',
    'eslint.config.js',
    'stryker.config.json',
    'deep/nested/thing.config.jsonc',
    'svc.config.yml',
    'svc.config.yaml',
    'turbo.json',
    'package.json',
    '.github/workflows/ci.yml',
    'scripts/lib/backup/postgres.ts',
  ];

  /**
   * What the sentence the report prints claims, read back out of that sentence
   * — so a case can fail when the words and the predicate accept different
   * sets, without either being quoted into it.
   */
  function acceptedBySentence(): (candidate: string) => boolean {
    const globs = coverageSection([]).match(/\*[^\s,]+/g) ?? [];
    expect(globs, 'the printed scope names no file name a reader could check').not.toEqual([]);
    expect(
      globs.every((glob) => glob.startsWith('*')),
      globs.join(' ')
    ).toBe(true);
    return (candidate) => {
      const name = candidate.slice(candidate.lastIndexOf('/') + 1);
      return globs.some((glob) => name.endsWith(glob.slice(1)));
    };
  }

  // The instrument before the verdict: two sides that accept nothing agree
  // perfectly, and would read as a pass.
  it('sweeps a grid both sides split, so their agreement cannot be vacuous', () => {
    expect(CANDIDATES.filter((candidate) => LANE_SITE_SCOPE.matches(candidate))).not.toEqual([]);
    expect(CANDIDATES.filter((candidate) => !LANE_SITE_SCOPE.matches(candidate))).not.toEqual([]);
  });

  it('accepts by its predicate exactly the names its printed sentence claims', () => {
    const bySentence = acceptedBySentence();
    expect(CANDIDATES.filter((candidate) => bySentence(candidate))).toEqual(
      CANDIDATES.filter((candidate) => LANE_SITE_SCOPE.matches(candidate))
    );
  });
});

describe('LANE_MECHANISMS as a claim about the repository', () => {
  const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

  /** The directories the report says its sweep does not enter, read from it. */
  const PRUNED = new Set<string>(LANE_SITE_SCOPE.unswept);

  /** Every file in the swept scope, as a repo-relative path. */
  function scopedFiles(directory: string, prefix: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (PRUNED.has(entry.name)) continue;
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        found.push(...scopedFiles(path.join(directory, entry.name), relative));
      } else if (LANE_SITE_SCOPE.matches(relative)) {
        found.push(relative);
      }
    }
    return found;
  }

  function declaringFiles(): string[] {
    return scopedFiles(REPO_ROOT, '').filter((file) =>
      LANE_DECLARATION_PATTERN.test(readFileSync(path.join(REPO_ROOT, file), 'utf8'))
    );
  }

  // The instrument before the verdict: a sweep that matches nothing reads
  // exactly like a tree with nothing to find, so it is made to return something
  // first and only then trusted for what it does not return.
  it('reaches a file that does declare a lane count', () => {
    expect(declaringFiles()).toContain('playwright.config.ts');
  });

  it('names a mechanism for every file in the swept scope that declares a lane count', () => {
    const named = new Set(LANE_MECHANISMS.map((mechanism) => mechanism.site));
    expect(declaringFiles().filter((file) => !named.has(file))).toEqual([]);
  });

  // The gate reaches configuration files by name, so a lane count declared
  // anywhere else survives only by being written down. These are the ones this
  // report was corrected to carry after a reader found them outside its reach.
  it('names the process counts pnpm mutation and pnpm backup open, which the gate cannot reach', () => {
    const named = new Map(LANE_MECHANISMS.map((mechanism) => [mechanism.site, mechanism]));
    for (const site of [
      'stryker.config.json',
      'scripts/lib/backup/postgres.ts',
      'scripts/lib/backup/drill.ts',
    ]) {
      expect(named.get(site), site).toBeDefined();
      expect(named.get(site)?.rows, site).toEqual([]);
      expect(LANE_SITE_SCOPE.matches(site), site).toBe(false);
    }
  });

  /**
   * The one entry whose subject is a file declaring nothing. It is carried
   * because a reader who counts workerd projects finds three and this report
   * named two, and reads the missing one as an oversight; what its entry
   * records is that silence, so the drift that would falsify it is the
   * opposite of every other entry's — a count appearing there, not one
   * disappearing.
   */
  const UNDECLARED_SITE = 'apps/api/vitest.workers.config.ts';

  it('names the workerd project the other two workerd entries leave out', () => {
    const named = new Map(LANE_MECHANISMS.map((mechanism) => [mechanism.site, mechanism]));
    expect(named.get(UNDECLARED_SITE), UNDECLARED_SITE).toBeDefined();
    expect(named.get(UNDECLARED_SITE)?.rows, UNDECLARED_SITE).toEqual([]);
  });

  it('reads every named site the way its own entry describes it', () => {
    for (const { site } of LANE_MECHANISMS) {
      const file = path.join(REPO_ROOT, site);
      expect(existsSync(file), site).toBe(true);
      expect(LANE_DECLARATION_PATTERN.test(readFileSync(file, 'utf8')), site).toBe(
        site !== UNDECLARED_SITE
      );
    }
  });
});

describe('memoryAccount', () => {
  /** One recorded run, carrying whichever of the ladder's three figures it was given. */
  function held(figures: Partial<RunObservation>): RunObservation {
    return {
      concurrency: 8,
      taskCount: 18,
      sumWallMs: 400_000,
      longestWallMs: 100_000,
      makespanMs: 100_000,
      ...figures,
    };
  }

  /** A row that prices the width it names. */
  function priced(
    lanes: number,
    peakRssKb: number,
    figures: Partial<RunObservation> = {}
  ): RunObservation {
    return held({ lanesAtPeak: lanes, peakRssKb, fixedRssKb: 1_000_000, ...figures });
  }

  function account(
    runs: readonly RunObservation[],
    over: Partial<MemoryAccountInput> = {}
  ): MemoryAccount {
    return memoryAccount({
      runs,
      concurrency: 8,
      bound: 'work',
      memoryGuarded: true,
      budgetKb: 20_000_000,
      ...over,
    });
  }

  it('files every recorded width at the worst total peak recorded there', () => {
    const rungs = account([
      priced(4, 8_000_000),
      priced(4, 11_000_000),
      priced(6, 9_000_000),
    ]).rungs;
    expect(rungs.map(({ rung }) => [rung.lanes, rung.peakRssKb])).toEqual([
      [4, 11_000_000],
      [6, 9_000_000],
    ]);
  });

  it('counts the rows filed at a width, whether or not each set the rung', () => {
    const rungs = account([priced(4, 8_000_000), priced(4, 11_000_000)]).rungs;
    expect(rungs[0]?.rung.rows).toBe(2);
  });

  it('counts the retained rows standing after the newest row at a width', () => {
    const rungs = account([priced(4, 8_000_000), priced(6, 9_000_000), priced(6, 7_000_000)]).rungs;
    expect(rungs.find(({ rung }) => rung.lanes === 4)?.rowsAfter).toBe(2);
    expect(rungs.find(({ rung }) => rung.lanes === 6)?.rowsAfter).toBe(0);
  });

  /**
   * The store's age window is per shape — a rung falls off once its own shape
   * has run far enough past it — so an age counted across every shape in the
   * list would answer a question the store never asks.
   */
  it('counts only rows of the width’s own shape, never every row after it', () => {
    const rungs = account([
      priced(4, 8_000_000, { shape: 'batch' }),
      priced(6, 9_000_000, { shape: 'package' }),
      priced(6, 9_000_000, { shape: 'package' }),
      priced(8, 9_000_000, { shape: 'batch' }),
    ]).rungs;
    const four = rungs.find(({ rung }) => rung.lanes === 4);
    expect(four?.shape).toBe('batch');
    expect(four?.rowsAfter).toBe(1);
  });

  it('names the shape of the newest row at a width, so the age has a population', () => {
    expect(account([priced(4, 8_000_000, { shape: 'batch' })]).rungs[0]?.shape).toBe('batch');
  });

  it('files a row the store stamped with no shape at all under one that reads', () => {
    expect(account([priced(4, 8_000_000, { shape: '' })]).rungs[0]?.shape).toBe('unstamped');
    expect(account([priced(4, 8_000_000, { shape: '' })]).fixedCosts).toEqual([
      { shape: 'unstamped', fixedRssKb: 1_000_000 },
    ]);
  });

  it('dates a width by a row the ladder files there, never by one it rejects', () => {
    const rungs = account([
      priced(4, 8_000_000),
      held({ lanesAtPeak: 4, peakRssKb: 9_000_000 }),
    ]).rungs;
    expect(rungs[0]?.rowsAfter).toBe(1);
  });

  it('has no width to report where no row carries all three figures', () => {
    expect(account([held({ peakRssKb: 8_000_000, fixedRssKb: 1_000_000 })]).rungs).toEqual([]);
  });

  it('carries the newest baseline recorded under each shape', () => {
    const costs = account([
      priced(4, 8_000_000, { shape: 'batch', fixedRssKb: 3_000_000 }),
      priced(4, 8_000_000, { shape: 'package', fixedRssKb: 400_000 }),
      priced(4, 8_000_000, { shape: 'batch', fixedRssKb: 3_900_000 }),
    ]).fixedCosts;
    expect(costs).toEqual([
      { shape: 'batch', fixedRssKb: 3_900_000 },
      { shape: 'package', fixedRssKb: 400_000 },
    ]);
  });

  it('files a row recorded before the stamp existed under a shape that says so', () => {
    expect(account([priced(4, 8_000_000)]).fixedCosts).toEqual([
      { shape: 'unstamped', fixedRssKb: 1_000_000 },
    ]);
  });

  it('carries the budget, the count and the bound it was handed', () => {
    const built = account([], { concurrency: 5, bound: 'memory', budgetKb: 12_345 });
    expect(built.budgetKb).toBe(12_345);
    expect(built.concurrency).toBe(5);
    expect(built.bound).toBe('memory');
  });
});

describe('memorySection', () => {
  function priced(
    lanes: number,
    peakRssKb: number,
    figures: Partial<RunObservation> = {}
  ): RunObservation {
    return {
      concurrency: 8,
      taskCount: 18,
      sumWallMs: 400_000,
      longestWallMs: 100_000,
      makespanMs: 100_000,
      lanesAtPeak: lanes,
      peakRssKb,
      fixedRssKb: 1_000_000,
      ...figures,
    };
  }

  function row(task: string, over: Partial<MemoryAccountInput> = {}): TaskStatus {
    return {
      task,
      concurrency: over.concurrency ?? 8,
      state: 'work-bound',
      tuned: true,
      runs: over.runs ?? [],
      note: 'a note',
      memory: memoryAccount({
        runs: [],
        concurrency: 8,
        bound: 'work',
        memoryGuarded: true,
        budgetKb: 20_000_000,
        ...over,
      }),
    };
  }

  const LADDER = [priced(4, 11_000_000), priced(6, 18_000_000)];

  it('prints, per tool, every width that has held and what it held', () => {
    const text = memorySection([row('lint', { runs: LADDER })]);
    expect(text).toContain('lint');
    expect(text).toContain('4 lane(s) have held 11.3 GB');
    expect(text).toContain('6 lane(s) have held 18.4 GB');
  });

  it('says how many rows stand at a width and how many stand after the newest', () => {
    const text = memorySection([row('lint', { runs: [priced(4, 9_000_000), ...LADDER] })]);
    expect(text).toContain(
      '2 row(s) filed here, the newest with 1 retained unstamped row(s) after it'
    );
    expect(text).toContain('1 row(s) filed here, the newest is the latest retained unstamped row');
  });

  /**
   * An age here counts rows the store kept, and it keeps at most a few per
   * width per shape — so the figure is a floor on the runs behind a rung, and a
   * reader told only the number would read it as the distance to expiry.
   */
  it('says what an age counts, so the figure is not read as a run count', () => {
    expect(memorySection([row('lint', { runs: LADDER })])).toContain(
      'Ages count rows the store kept'
    );
  });

  it('names the budget the count was checked against', () => {
    expect(memorySection([row('lint', { runs: LADDER })])).toContain('budget: 20.5 GB');
  });

  it('says beside the figure what the budget was derived from', () => {
    expect(memorySection([row('lint', { runs: LADDER })])).toContain(
      'budget: 20.5 GB — a share of the memory free when this count was derived'
    );
  });

  /**
   * Every count reads the budget for itself, so one report carries as many
   * readings as it has derivations and they disagree whenever the machine's
   * free memory moved between them. A reader who takes the figure for a machine
   * property reads that disagreement as a bug — the misreading this section
   * exists to close.
   */
  it('says two rows naming different budgets are two readings', () => {
    expect(memorySection([row('lint', { runs: LADDER })])).toContain(
      'naming different budgets are two readings, not a disagreement'
    );
  });

  it('says so where no budget could be read', () => {
    const text = memorySection([row('lint', { runs: LADDER, budgetKb: undefined })]);
    expect(text).toContain('budget: none could be read');
  });

  it('names the newest baseline recorded under each shape', () => {
    const text = memorySection([
      row('lint', { runs: [priced(4, 11_000_000, { shape: 'batch', fixedRssKb: 3_900_000 })] }),
    ]);
    expect(text).toContain('fixed cost, newest per shape: batch 4.0 GB');
  });

  it('says so where no run recorded a baseline at all', () => {
    expect(memorySection([row('lint')])).toContain('fixed cost, newest per shape: none on record');
  });

  it('names the width whose rung the count was held against', () => {
    const text = memorySection([row('lint', { runs: LADDER, concurrency: 6 })]);
    expect(text).toContain('held against 18.4 GB');
    expect(text).toContain('the most any width at or below 6 lanes has held, set at 6 lane(s)');
  });

  it('names the narrower width whose rung outprices every wider one below the count', () => {
    const narrowHigh = [priced(4, 20_000_000), priced(6, 18_000_000)];
    expect(memorySection([row('lint', { runs: narrowHigh, concurrency: 6 })])).toContain(
      'set at 4 lane(s)'
    );
  });

  it('says a count above the widest width on record is held flat past it', () => {
    const text = memorySection([row('lint', { runs: LADDER, concurrency: 8 })]);
    expect(text).toContain('above the widest width on record (6 lanes)');
    expect(text).toContain('the projection holds that figure flat');
  });

  /**
   * The figure is the worst rung on the ladder, which need not be the widest
   * one the count passed. Naming the widest as the one that set it is a
   * sentence whose figure lands two gigabytes under the one beside it, which is
   * the reading the landing clause exists to prevent.
   */
  it('names the width that set the figure, not the widest width the count passed', () => {
    const narrowHigh = [priced(4, 20_000_000), priced(6, 18_000_000)];
    const text = memorySection([row('lint', { runs: narrowHigh, concurrency: 8 })]);
    expect(text).toContain('the most any width on record has held, set at 4 lane(s)');
    expect(text).toContain('above the widest width on record (6 lanes)');
  });

  it('prints a figure a reader rebuilds from the widths on record alone', () => {
    const narrowHigh = [
      priced(4, 20_000_000, { fixedRssKb: 1_000_000 }),
      priced(6, 18_000_000, { fixedRssKb: 1_000_000 }),
    ];
    const text = memorySection([row('lint', { runs: narrowHigh, concurrency: 8 })]);
    const gb = (kb: number): string => `${((kb * 1024) / 1e9).toFixed(1)} GB`;
    // Every rung is at or below a count past the widest width, so the
    // projection's maximum over the rungs at or below it is the whole ladder's.
    const rebuiltKb = Math.max(20_000_000, 18_000_000);
    expect(text).toContain(`held against ${gb(rebuiltKb)} — the most any width on record has held`);
  });

  /**
   * A count off a rung is priced on a line between rungs, so the figure is one
   * no width recorded and there is no width to name as having held it. Saying
   * a width held it folded an empty set into the clause and printed the fold's
   * own emptiness — `set at Infinity lane(s)` — at every count the ladder does
   * not carry a rung at.
   */
  it('names the figures at both ends of the line a count between two rungs sits on', () => {
    const text = memorySection([row('lint', { runs: LADDER, concurrency: 5 })]);
    expect(text).toContain('held against 14.8 GB');
    expect(text).toContain('read on the line from 11.3 GB at 4 lane(s) to 18.4 GB at 6 lane(s)');
    expect(text).not.toContain('Infinity');
  });

  /**
   * The line's lower end is the figure the projection stands at that width,
   * which a narrower dearer rung sets and the width's own rung does not — the
   * ladder's whole design. A reader handed the two widths rebuilds the figure
   * from the rung lines printed above, so naming the widths alone prints a
   * sentence whose arithmetic lands five gigabytes under the figure beside it.
   */
  it('names the figure the projection stands at the lower width, not the rung filed there', () => {
    const stepped = [priced(2, 20_000_000), priced(4, 10_000_000), priced(6, 30_000_000)];
    const text = memorySection([row('lint', { runs: stepped, concurrency: 5 })]);
    expect(text).toContain(
      'held against 25.6 GB — read on the line from 20.5 GB at 4 lane(s) to 30.7 GB at ' +
        '6 lane(s), each width standing at the worst figure it or any narrower width recorded'
    );
  });

  it('names the figures at both ends of the line below the narrowest rung', () => {
    const text = memorySection([row('lint', { runs: LADDER, concurrency: 2 })]);
    expect(text).toContain('held against 6.1 GB');
    expect(text).toContain('read on the line from 11.3 GB at 4 lane(s) to 1.0 GB at no lanes');
    expect(text).not.toContain('Infinity');
  });

  /**
   * A recorder samples a baseline and a tree peak independently, so a row can
   * carry a baseline above its own peak; the projection anchors the descent at
   * the lower of the two, because a line rising as lanes fall would answer
   * above the rung it descends from. Naming the row's own baseline prints a
   * line that rises, and a reader rebuilding it lands above the figure beside
   * it.
   */
  it('names the baseline the projection anchors at, not the one the row carries', () => {
    const overBaseline = [priced(4, 9_000_000, { fixedRssKb: 12_000_000 })];
    const text = memorySection([row('lint', { runs: overBaseline, concurrency: 3 })]);
    expect(text).toContain(
      'held against 9.2 GB — read on the line from 9.2 GB at 4 lane(s) to 9.2 GB at no ' +
        "lanes, the baseline that run held outside its lanes taken no higher than that rung's " +
        'own figure'
    );
  });

  it('says no width on record has held a figure read off a line', () => {
    const text = memorySection([row('lint', { runs: LADDER, concurrency: 5 })]);
    expect(text).toContain('no width on record has held it');
  });

  it('says so where nothing examined the count against what has been held', () => {
    const text = memorySection([row('lint', { runs: LADDER, memoryGuarded: false })]);
    expect(text).toContain('nothing examined it against what has been held');
  });

  it('says no width has a rung where no row prices one', () => {
    expect(memorySection([row('lint')])).toContain('no width has a rung');
  });

  /**
   * The store carries each figure on its own terms, so a row that recorded a
   * peak and the lanes live when it was set, and no baseline, is a row the
   * ladder rejects. A sentence naming only two of the three figures denies the
   * one thing such a row did record.
   */
  it('names every figure the ladder waited for where a row carried only some', () => {
    const noBaseline: RunObservation[] = [
      {
        concurrency: 8,
        taskCount: 18,
        sumWallMs: 400_000,
        longestWallMs: 100_000,
        makespanMs: 100_000,
        lanesAtPeak: 4,
        peakRssKb: 9_000_000,
      },
    ];
    expect(memorySection([row('lint', { runs: noBaseline })])).toContain(
      'all three of a peak, a baseline and the lanes'
    );
  });

  it('names the bound the count came out of, in the vocabulary the state column prints', () => {
    for (const bound of ['work', 'ceiling', 'memory', 'unmeasured'] as const) {
      expect(memorySection([row('lint', { runs: LADDER, bound })])).toContain(
        `(${derivationBasis({ bound })})`
      );
    }
  });

  /**
   * The founder's rule for this section: it reports what widths have held,
   * never what one will hold. Asserted as a class over the rendered text rather
   * than against one wording, because the wording is what drifts.
   */
  it('claims only what has been held, never what will be', () => {
    const text = memorySection([
      row('lint', { runs: LADDER, concurrency: 6 }),
      row('typecheck', { runs: LADDER, concurrency: 9 }),
      // Both vitest rows over the same rows, so the section's repeat line is
      // inside the class this asserts rather than outside it.
      row('vitest-batch', { runs: LADDER }),
      row('vitest-pkg', { runs: LADDER }),
    ]);
    expect(text).toContain('identical to the vitest-batch block above');
    expect(text).toMatch(/have held/);
    expect(text).not.toMatch(/will hold|would hold|will need|expects? to hold|going to hold/i);
  });

  it('leaves out a row carrying no memory account of its own', () => {
    const text = memorySection([
      row('lint', { runs: LADDER }),
      playwrightTaskStatus({ workers: 12, personaPoolSize: 12 }),
    ]);
    expect(text).not.toContain('playwright');
  });
});

describe('every row the report renders, against the ladder it now derives from', () => {
  const DERIVATION: VitestWorkerDerivation = {
    workers: 19,
    state: 'derived',
    bound: 'work',
    memoryCapped: false,
    memoryGuarded: true,
    units: 800,
  };

  function everyRow(): TaskStatus[] {
    const runs: RunObservation[] = [
      {
        concurrency: 6,
        taskCount: 18,
        sumWallMs: 400_000,
        longestWallMs: 100_000,
        makespanMs: 100_000,
        lanesAtPeak: 6,
        peakRssKb: 11_000_000,
        fixedRssKb: 1_000_000,
        sumFileWallMs: 3_800_000,
      },
    ];
    return [
      poolTaskStatus({
        task: 'lint',
        tasks: [{ name: 'a', wallsMs: [100_000] }],
        runs,
        ceiling: 8,
        memoryBudgetKb: 20_000_000,
      }),
      vitestTaskStatus({ derivation: DERIVATION, runs, memoryBudgetKb: 20_000_000 }),
      packageVitestTaskStatus({ derivation: DERIVATION, runs, memoryBudgetKb: 20_000_000 }),
      playwrightTaskStatus({ workers: 12, personaPoolSize: 12 }),
    ];
  }

  /**
   * The vocabulary the composition and its calibration left behind, plus the
   * per-unit charge they consumed: the ladder prices a width from whole-run
   * rows, so nothing reaches a unit for a memory figure and a count of the
   * units that carry one describes a mechanism the ladder removed.
   */
  const RETIRED =
    /calibrat|composed|composition|qualifying run|sample count|ratio of|recorded charge/i;

  it('renders no claim in the retired vocabulary of the composition', () => {
    expect(formatReport(MACHINE, everyRow())).not.toMatch(RETIRED);
  });

  /**
   * How the command came to print an `undefined ledger task`: a note
   * interpolated a constant another module deleted, which no test asserting a
   * wording could catch — every such test was satisfied by the words around the
   * hole. A rendered report has no legitimate `undefined` in it.
   */
  it('interpolates no value another module has stopped exporting', () => {
    expect(formatReport(MACHINE, everyRow())).not.toContain('undefined');
  });

  it('gives every row an account of its derivation beyond the state column word', () => {
    for (const status of everyRow()) {
      expect(status.note.length, status.task).toBeGreaterThan(status.state.length);
      expect(status.note, status.task).not.toBe(status.state);
    }
  });

  it('carries a memory account for every row the pool derives a count for', () => {
    const rows = everyRow();
    const tuned = rows.filter((status) => status.memory !== undefined).map((status) => status.task);
    expect(tuned).toEqual(['lint', 'vitest-batch', 'vitest-pkg']);
    const section = memorySection(rows);
    for (const task of tuned) expect(section, task).toContain(`\n  ${task}\n`);
  });

  /**
   * The two vitest blocks repeat because one derivation over one reading of one
   * store builds both rows. A reader meeting two identical ladders with nothing
   * said takes them for two measurements that agree, which is a stronger claim
   * than the report can make.
   */
  it('says the repeated vitest block is one computation rather than a second measurement', () => {
    expect(memorySection(everyRow())).toContain(
      'identical to the vitest-batch block above, line for line'
    );
  });

  it('says nothing of a repeat where the two vitest rows were derived apart', () => {
    const runs: RunObservation[] = [
      {
        concurrency: 6,
        taskCount: 18,
        sumWallMs: 400_000,
        longestWallMs: 100_000,
        makespanMs: 100_000,
        lanesAtPeak: 6,
        peakRssKb: 11_000_000,
        fixedRssKb: 1_000_000,
      },
    ];
    const text = memorySection([
      vitestTaskStatus({ derivation: DERIVATION, runs, memoryBudgetKb: 20_000_000 }),
      packageVitestTaskStatus({ derivation: DERIVATION, runs: [], memoryBudgetKb: 20_000_000 }),
    ]);
    expect(text).not.toContain('identical to the');
  });

  it('says nothing of a repeat where the block it would name was never printed', () => {
    const text = memorySection([
      packageVitestTaskStatus({ derivation: DERIVATION, runs: [], memoryBudgetKb: 20_000_000 }),
    ]);
    expect(text).not.toContain('identical to the');
  });
});

describe('the package configuration a vitest run can reach with no derivation of its own', () => {
  /**
   * `packages/config/vitest.config.ts` takes its ceiling from the shared
   * derivation as it loads: over every test file on record, the runs the store
   * holds, and a memory budget, bounded by the machine's parallelism. It stays
   * among the mechanisms no row carries because every row here reports a run
   * some launcher started, and this is the ceiling a run that reaches the
   * configuration with no launcher opens.
   */
  it('is carried by no row of this report', () => {
    const entry = LANE_MECHANISMS.find((site) => site.site === 'packages/config/vitest.config.ts');
    expect(entry?.rows).toEqual([]);
  });

  it('names the command that reaches it, so a reader can tell which run it sizes', () => {
    expect(coverageSection(LANE_MECHANISMS)).toContain('test:watch:ui');
  });
});
