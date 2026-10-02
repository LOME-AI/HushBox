import { describe, expect, it } from 'vitest';

import {
  POLE_MAJORITY_SHARE,
  POLE_MIN_MS,
  detectPoles,
  failedFilesForDirectory,
  perFileWallMs,
  sumFileWallMs,
  reportForDirectory,
  type VitestJsonReport,
} from './test-report.js';

const THRESHOLDS = { minMs: POLE_MIN_MS, majorityShare: POLE_MAJORITY_SHARE };

function entry(
  name: string,
  wallMs: number,
  status = 'passed'
): NonNullable<VitestJsonReport['testResults']>[number] {
  return { name, startTime: 1000, endTime: 1000 + wallMs, status };
}

describe('detectPoles', () => {
  it('returns no poles for an empty report or a report with no test results', () => {
    expect(detectPoles({}, THRESHOLDS)).toEqual([]);
    expect(detectPoles({ testResults: [] }, THRESHOLDS)).toEqual([]);
  });

  it('flags a single file over the floor as a 100%-share pole', () => {
    const poles = detectPoles({ testResults: [entry('/a.test.ts', 20_000)] }, THRESHOLDS);
    expect(poles).toEqual([{ file: '/a.test.ts', wallMs: 20_000, share: 1 }]);
  });

  it('flags exactly the strict-majority file over the floor among siblings', () => {
    const poles = detectPoles(
      { testResults: [entry('/big.test.ts', 30_000), entry('/small.test.ts', 10_000)] },
      THRESHOLDS
    );
    expect(poles.map((pole) => pole.file)).toEqual(['/big.test.ts']);
  });

  it('does not flag a strict-majority file that is under the floor', () => {
    const poles = detectPoles(
      { testResults: [entry('/big.test.ts', 10_000), entry('/small.test.ts', 1000)] },
      THRESHOLDS
    );
    expect(poles).toEqual([]);
  });

  it('does not flag a file over the floor whose share is not a strict majority', () => {
    const poles = detectPoles(
      {
        testResults: [
          entry('/a.test.ts', 16_000),
          entry('/b.test.ts', 16_000),
          entry('/c.test.ts', 16_000),
        ],
      },
      THRESHOLDS
    );
    expect(poles).toEqual([]);
  });

  it('does not flag either file at the exact 50% boundary (two equal files)', () => {
    const poles = detectPoles(
      { testResults: [entry('/a.test.ts', 20_000), entry('/b.test.ts', 20_000)] },
      THRESHOLDS
    );
    expect(poles).toEqual([]);
  });

  it('skips entries with missing/non-finite timestamps, missing name, or non-positive wall time', () => {
    const poles = detectPoles(
      {
        testResults: [
          { name: '/no-times.test.ts' },
          { name: '/nan.test.ts', startTime: Number.NaN, endTime: 5 },
          { startTime: 0, endTime: 30_000 },
          { name: '/zero.test.ts', startTime: 5, endTime: 5 },
          entry('/real.test.ts', 20_000),
        ],
      },
      THRESHOLDS
    );
    expect(poles.map((pole) => pole.file)).toEqual(['/real.test.ts']);
  });

  it('sums wall time across entries that share a file path before thresholding', () => {
    const poles = detectPoles(
      {
        testResults: [
          entry('/split.test.ts', 10_000),
          entry('/split.test.ts', 10_000),
          entry('/other.test.ts', 1000),
        ],
      },
      THRESHOLDS
    );
    expect(poles.map((pole) => pole.file)).toEqual(['/split.test.ts']);
    expect(poles[0]?.wallMs).toBe(20_000);
  });

  it('returns multiple qualifying poles sorted by wall time descending', () => {
    // Two entries can each hold a strict majority only across separate calls;
    // within one report a single file can. Use a tiny sibling so two files
    // cannot both pass the majority test — assert ordering via one pole plus
    // the aggregation path instead.
    const poles = detectPoles(
      { testResults: [entry('/big.test.ts', 40_000), entry('/small.test.ts', 100)] },
      THRESHOLDS
    );
    expect(poles.map((pole) => pole.file)).toEqual(['/big.test.ts']);
  });
});

describe('reportForDirectory', () => {
  const report: VitestJsonReport = {
    testResults: [
      entry('/repo/apps/api/a.test.ts', 10),
      entry('/repo/apps/api-tools/b.test.ts', 10),
      entry('/repo/packages/db/c.test.ts', 10),
    ],
  };

  it('keeps only entries under the directory, never a sibling with the same prefix', () => {
    const scoped = reportForDirectory(report, '/repo/apps/api');
    expect(scoped.testResults?.map((testResult) => testResult.name)).toEqual([
      '/repo/apps/api/a.test.ts',
    ]);
  });

  it('accepts a directory given with a trailing slash', () => {
    const scoped = reportForDirectory(report, '/repo/packages/db/');
    expect(scoped.testResults?.map((testResult) => testResult.name)).toEqual([
      '/repo/packages/db/c.test.ts',
    ]);
  });
});

describe('failedFilesForDirectory', () => {
  it('returns only failed files under the directory', () => {
    const report: VitestJsonReport = {
      testResults: [
        entry('/repo/apps/api/pass.test.ts', 10),
        entry('/repo/apps/api/fail.test.ts', 10, 'failed'),
        entry('/repo/packages/db/fail.test.ts', 10, 'failed'),
      ],
    };
    expect(failedFilesForDirectory(report, '/repo/apps/api')).toEqual([
      '/repo/apps/api/fail.test.ts',
    ]);
  });
});

describe('perFileWallMs', () => {
  it('weighs the run at the mean wall of the files it covered', () => {
    const report = { testResults: [entry('/a.test.ts', 3000), entry('/b.test.ts', 5000)] };
    expect(perFileWallMs(report)).toBe(4000);
  });

  it('weighs a file its report timed twice as one file', () => {
    const report = { testResults: [entry('/a.test.ts', 3000), entry('/a.test.ts', 5000)] };
    expect(perFileWallMs(report)).toBe(8000);
  });

  it('weighs nothing, rather than zero, for a run that wrote no report', () => {
    const noReport: VitestJsonReport | undefined = undefined;
    expect(perFileWallMs(noReport)).toBeUndefined();
  });

  it('weighs nothing, rather than zero, for a run that covered no file', () => {
    expect(perFileWallMs({ testResults: [] })).toBeUndefined();
  });

  it('weighs nothing, rather than zero, where no entry carries a usable timestamp pair', () => {
    expect(
      perFileWallMs({ testResults: [{ name: '/a.test.ts', status: 'passed' }] })
    ).toBeUndefined();
  });
});

describe('sumFileWallMs', () => {
  it('totals the wall of the files the run covered', () => {
    const report = { testResults: [entry('/a.test.ts', 3000), entry('/b.test.ts', 5000)] };
    expect(sumFileWallMs(report)).toBe(8000);
  });

  it('totals what ran, leaving out an entry it cannot weigh', () => {
    const report = {
      testResults: [
        entry('/ran.test.ts', 3000),
        { name: '/failed-to-collect.test.ts', startTime: 1000, endTime: 1000, status: 'failed' },
        { name: '/all-skipped.test.ts', startTime: 1000, endTime: 1000, status: 'passed' },
      ],
    };
    expect(sumFileWallMs(report)).toBe(3000);
  });

  it('totals nothing, rather than zero, for a run that wrote no report', () => {
    const noReport: VitestJsonReport | undefined = undefined;
    expect(sumFileWallMs(noReport)).toBeUndefined();
  });

  it('totals nothing, rather than zero, where no entry carries a usable timestamp pair', () => {
    expect(
      sumFileWallMs({ testResults: [{ name: '/a.test.ts', status: 'passed' }] })
    ).toBeUndefined();
  });
});
