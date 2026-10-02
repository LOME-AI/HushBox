import path from 'node:path';

import { describe, expect, it } from 'vitest';
import percent from 'istanbul-lib-coverage/lib/percent.js';

import {
  coverageFigures,
  coverageIncludeFor,
  emptyMapOutcome,
  exitCodeFor,
  lowerBoundReport,
  moduleUnderTest,
  modulesUnderTest,
  type CoverageFigure,
  type ModuleFs,
} from './file-coverage.js';
import { partialCoverageReason } from '../vitest/coverage-scope.js';

const DIR = path.join(path.sep, 'repo', 'apps', 'web', 'src');

/** The directory listing the derivation reads, and nothing else about a disk. */
describe('moduleUnderTest', () => {
  it('takes the sibling module sharing the test file’s own extension', () => {
    expect(
      moduleUnderTest(path.join(DIR, 'api-client.test.ts'), ['api-client.test.ts', 'api-client.ts'])
    ).toBe(path.join(DIR, 'api-client.ts'));
  });

  it('takes a sibling written in another module extension', () => {
    expect(
      moduleUnderTest(path.join(DIR, 'audit-table.test.ts'), [
        'audit-table.test.ts',
        'audit-table.tsx',
      ])
    ).toBe(path.join(DIR, 'audit-table.tsx'));
  });

  it('prefers the sibling whose extension the test file itself is written in', () => {
    expect(
      moduleUnderTest(path.join(DIR, 'panel.test.tsx'), ['panel.test.tsx', 'panel.ts', 'panel.tsx'])
    ).toBe(path.join(DIR, 'panel.tsx'));
  });

  it('drops a qualifier segment the module’s own name does not carry', () => {
    expect(
      moduleUnderTest(path.join(DIR, 'payments.integration.test.ts'), [
        'payments.integration.test.ts',
        'payments.ts',
      ])
    ).toBe(path.join(DIR, 'payments.ts'));
  });

  it('never answers with the test file itself', () => {
    expect(() => moduleUnderTest(path.join(DIR, 'retry.test.ts'), ['retry.test.ts'])).toThrow(
      /--source/
    );
  });

  it('names the test file that has no sibling module', () => {
    expect(() =>
      moduleUnderTest(path.join(DIR, 'root-scripts.test.ts'), ['root-scripts.test.ts'])
    ).toThrow(/root-scripts\.test\.ts/);
  });

  it('leaves a sibling carrying a further name segment out of the answer', () => {
    expect(() =>
      moduleUnderTest(path.join(DIR, 'retry.test.ts'), ['retry.test.ts', 'retry.fixtures.ts'])
    ).toThrow(/--source/);
  });
});

describe('coverageFigures', () => {
  const FILE = path.join(DIR, 'api-client.ts');

  /** One istanbul file entry, with only the fields the figures are read from. */
  function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      statementMap: { '0': { start: { line: 1 } }, '1': { start: { line: 2 } } },
      s: { '0': 1, '1': 0 },
      fnMap: { '0': {} },
      f: { '0': 3 },
      branchMap: { '0': {} },
      b: { '0': [1, 0] },
      ...overrides,
    };
  }

  it('reports each metric as a percentage of what the file holds', () => {
    const [figure] = coverageFigures({ [FILE]: entry() }, path.dirname(DIR));
    expect(figure).toEqual({
      file: path.join('src', 'api-client.ts'),
      statements: 50,
      branches: 50,
      functions: 100,
      lines: 50,
    } satisfies CoverageFigure);
  });

  it('reports every metric as the coverage library’s own percentage of covered to total', () => {
    const counters = (total: number, covered: number): Record<string, number> =>
      Object.fromEntries(
        Array.from({ length: total }, (_, index) => [String(index), index < covered ? 1 : 0])
      );
    const [figure] = coverageFigures(
      {
        [FILE]: entry({
          statementMap: Object.fromEntries(
            Array.from({ length: 7 }, (_, index) => [String(index), { start: { line: index } }])
          ),
          s: counters(7, 3),
          f: counters(7, 3),
          b: { '0': [1, 1, 1, 0, 0, 0, 0] },
        }),
      },
      path.dirname(DIR)
    );
    expect(figure).toEqual({
      file: path.join('src', 'api-client.ts'),
      statements: percent(3, 7),
      branches: percent(3, 7),
      functions: percent(3, 7),
      lines: percent(3, 7),
    } satisfies CoverageFigure);
  });

  it('counts a line covered when any statement on it ran', () => {
    const [figure] = coverageFigures(
      {
        [FILE]: entry({
          statementMap: { '0': { start: { line: 7 } }, '1': { start: { line: 7 } } },
          s: { '0': 0, '1': 4 },
        }),
      },
      path.dirname(DIR)
    );
    expect(figure?.lines).toBe(100);
  });

  it('reads a file holding none of a metric as complete on it', () => {
    const [figure] = coverageFigures(
      { [FILE]: entry({ branchMap: {}, b: {}, fnMap: {}, f: {} }) },
      path.dirname(DIR)
    );
    expect(figure?.branches).toBe(100);
    expect(figure?.functions).toBe(100);
  });

  it('truncates to two decimals, the way the coverage tooling beside it reports', () => {
    const [figure] = coverageFigures(
      {
        [FILE]: entry({
          statementMap: Object.fromEntries(
            Array.from({ length: 87 }, (_, index) => [String(index), { start: { line: index } }])
          ),
          s: Object.fromEntries(
            Array.from({ length: 87 }, (_, index) => [String(index), index < 75 ? 1 : 0])
          ),
        }),
      },
      path.dirname(DIR)
    );
    expect(figure?.lines).toBe(86.2);
  });

  it('reports a whole percentage the coverage tooling reports whole, not a hundredth below', () => {
    const [figure] = coverageFigures(
      {
        [FILE]: entry({
          statementMap: Object.fromEntries(
            Array.from({ length: 100 }, (_, index) => [String(index), { start: { line: index } }])
          ),
          s: Object.fromEntries(
            Array.from({ length: 100 }, (_, index) => [String(index), index < 57 ? 1 : 0])
          ),
        }),
      },
      path.dirname(DIR)
    );
    expect(figure?.lines).toBe(57);
  });

  it('reads an entry carrying no counters at all as complete on every metric', () => {
    const [figure] = coverageFigures({ [FILE]: {} }, path.dirname(DIR));
    expect(figure).toEqual({
      file: path.join('src', 'api-client.ts'),
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    } satisfies CoverageFigure);
  });

  it('skips a statement the map records no position for', () => {
    const [figure] = coverageFigures(
      { [FILE]: entry({ statementMap: { '0': {} }, s: { '0': 0 } }) },
      path.dirname(DIR)
    );
    expect(figure?.lines).toBe(100);
  });

  it('counts a statement the map records no execution count for as unexecuted', () => {
    const [figure] = coverageFigures(
      { [FILE]: entry({ statementMap: { '0': { start: { line: 3 } } }, s: {} }) },
      path.dirname(DIR)
    );
    expect(figure?.lines).toBe(0);
  });

  it('answers with nothing for a map that measured nothing', () => {
    expect(coverageFigures({}, path.dirname(DIR))).toEqual([]);
  });
});

describe('lowerBoundReport', () => {
  const FIGURE: CoverageFigure = {
    file: path.join('src', 'api-client.ts'),
    statements: 100,
    branches: 100,
    functions: 100,
    lines: 100,
  };
  const THIN: CoverageFigure = {
    ...FIGURE,
    statements: 3.7,
    branches: 0,
    functions: 0,
    lines: 3.84,
  };

  function report(
    outcome: Parameters<typeof lowerBoundReport>[0]['outcome'],
    figures: readonly CoverageFigure[] = [FIGURE],
    failedTestFiles = 1
  ): string {
    return lowerBoundReport({
      outcome,
      figures,
      failedTestFiles,
      packageName: '@hushbox/web',
      reportsDirectory: path.join(path.sep, 'repo', 'apps', 'web', 'coverage', 'run-a-b'),
      coverageInclude: ['src/api-client.ts'],
      packageDir: path.join(path.sep, 'repo', 'apps', 'web'),
      rootDir: path.join(path.sep, 'repo'),
    }).join('\n');
  }

  it('prints every measured file with its four figures', () => {
    const lines = report('thresholds-met', [FIGURE, THIN]);
    expect(lines).toContain(path.join('src', 'api-client.ts'));
    expect(lines).toContain('3.7');
    expect(lines).toContain('3.84');
  });

  it('calls a run that met the thresholds a conclusive pass', () => {
    expect(report('thresholds-met')).toContain('CONCLUSIVE PASS');
  });

  it('says why a met threshold settles the question on its own', () => {
    expect(report('thresholds-met')).toMatch(/lower bound/i);
  });

  it('leaves a package run out of the conclusive case, which needs nothing further', () => {
    expect(report('thresholds-met')).not.toContain('pnpm test:pkg');
  });

  it('calls a run that missed the thresholds inconclusive rather than failing', () => {
    expect(report('thresholds-unmet', [THIN])).toContain('INCONCLUSIVE');
  });

  it('says a shortfall is not a verdict on the module', () => {
    expect(report('thresholds-unmet', [THIN])).toMatch(/not a verdict/i);
  });

  it('names the package run as the way to settle an inconclusive result', () => {
    expect(report('thresholds-unmet', [THIN])).toContain('pnpm test:pkg @hushbox/web');
  });

  it('prints the figures a run whose tests failed did measure', () => {
    expect(report('tests-failed', [THIN])).toContain('COVERAGE LOWER BOUND');
  });

  it('marks those figures partial in the wording every runner states it in', () => {
    expect(report('tests-failed', [THIN], 2)).toContain(partialCoverageReason(2));
  });

  it('withholds a threshold verdict from figures a failing exit code cannot speak for', () => {
    expect(report('tests-failed', [THIN])).toContain('NO THRESHOLD VERDICT');
  });

  it('withholds every coverage conclusion from a run whose tests failed', () => {
    const lines = report('tests-failed', []);
    expect(lines).not.toContain('CONCLUSIVE PASS');
    expect(lines).not.toContain('INCONCLUSIVE');
    expect(lines).toMatch(/failed/i);
  });

  it('states the absent map in the wording every runner states it in', () => {
    expect(report('not-evaluated', [])).toContain('COVERAGE NOT EVALUATED');
  });

  it('states an empty scope in the wording every runner states it in', () => {
    expect(report('measured-nothing', [])).toContain('EMPTY COVERAGE SCOPE');
  });

  it('names the empty scope from the repo root, which is where that wording stands', () => {
    expect(report('measured-nothing', [])).toContain('apps/web/src/api-client.ts');
  });

  it('states an excluded scope in its own wording rather than the empty-scope refusal', () => {
    expect(report('excluded-from-coverage', [])).toContain('NOTHING TO MEASURE');
  });

  it('keeps the failure wording off a scope this repository excludes from coverage', () => {
    expect(report('excluded-from-coverage', [])).not.toContain('EMPTY COVERAGE SCOPE');
  });

  it('names the excluded scope from the repo root, the way its reader stands', () => {
    expect(report('excluded-from-coverage', [])).toContain('apps/web/src/api-client.ts');
  });

  it('names the barrel as the shape that reaches the excluded case', () => {
    expect(report('excluded-from-coverage', [])).toMatch(/barrel/i);
  });

  it('names the scope as given when the package the run scoped to is the repo itself', () => {
    expect(
      lowerBoundReport({
        outcome: 'measured-nothing',
        figures: [],
        failedTestFiles: 0,
        packageName: '@hushbox/root',
        reportsDirectory: path.join(path.sep, 'repo', 'coverage', 'run-a-b'),
        coverageInclude: ['scripts/test-watch.ts'],
        packageDir: path.join(path.sep, 'repo'),
        rootDir: path.join(path.sep, 'repo'),
      }).join('\n')
    ).toContain('(scripts/test-watch.ts)');
  });
});

describe('emptyMapOutcome', () => {
  it('reads a scope inside the package as one this repository excludes from coverage', () => {
    expect(emptyMapOutcome(['src/index.ts'])).toBe('excluded-from-coverage');
  });

  it('reads a scope reaching outside the package as a run that measured nothing', () => {
    expect(emptyMapOutcome(['../shared/src/estimate.ts'])).toBe('measured-nothing');
  });

  it('reads one module outside the package as enough to make the whole scope wrong', () => {
    expect(emptyMapOutcome(['src/index.ts', '../shared/src/estimate.ts'])).toBe('measured-nothing');
  });
});

describe('exitCodeFor', () => {
  it('fails a run that measured nothing, which vitest itself exits clean on', () => {
    expect(exitCodeFor('measured-nothing', 0)).toBe(1);
  });

  it('fails a run that produced no coverage map at all, which vitest itself exits clean on', () => {
    expect(exitCodeFor('not-evaluated', 0)).toBe(1);
  });

  it('leaves a run whose scope this repository excludes from coverage green', () => {
    expect(exitCodeFor('excluded-from-coverage', 0)).toBe(0);
  });

  it('hands back the code vitest exited with for a run that measured something', () => {
    expect(exitCodeFor('thresholds-unmet', 1)).toBe(1);
  });

  it('leaves a failing run failing rather than restating its code', () => {
    expect(exitCodeFor('measured-nothing', 2)).toBe(2);
  });
});

describe('coverageIncludeFor', () => {
  const PACKAGE = path.join(path.sep, 'repo', 'apps', 'web');

  it('names each module relative to the package the run is scoped to', () => {
    expect(coverageIncludeFor([path.join(PACKAGE, 'src', 'api-client.ts')], PACKAGE)).toEqual([
      'src/api-client.ts',
    ]);
  });

  it('names a module once however many test files reached it', () => {
    const module = path.join(PACKAGE, 'src', 'api-client.ts');
    expect(coverageIncludeFor([module, module], PACKAGE)).toEqual(['src/api-client.ts']);
  });
});

/**
 * The scope a coverage run measures, and the refusals that stand between a
 * command line and one. They live here rather than in the entry point
 * because each is a decision about what gets measured, and the entry point is
 * excluded from measurement.
 */
describe('modulesUnderTest', () => {
  const PACKAGE = path.join(path.sep, 'repo', 'apps', 'web');
  /** A module in a sibling package, which an include resolved against PACKAGE can never match. */
  const OUTSIDE = path.join('..', 'shared', 'src', 'estimate.ts');

  function fakeFs(
    files: readonly string[],
    directories: readonly string[] = [],
    listings: Readonly<Record<string, readonly string[]>> = {}
  ): ModuleFs {
    const fileSet = new Set(files);
    const directorySet = new Set(directories);
    return {
      isFile: (p) => fileSet.has(p),
      isDirectory: (p) => directorySet.has(p),
      listDirectory: (dir) => listings[dir] ?? [],
    };
  }

  it('measures the module beside each test file the run named', () => {
    expect(
      modulesUnderTest(
        {
          sources: [],
          testFiles: [path.join(DIR, 'api-client.test.ts')],
          invocationDir: PACKAGE,
          packageDir: PACKAGE,
        },
        fakeFs([], [], { [DIR]: ['api-client.test.ts', 'api-client.ts'] })
      )
    ).toEqual([path.join(DIR, 'api-client.ts')]);
  });

  it('measures the module named explicitly instead of the sibling', () => {
    expect(
      modulesUnderTest(
        {
          sources: [path.join('src', 'root-manifest.ts')],
          testFiles: [path.join(DIR, 'api-client.test.ts')],
          invocationDir: PACKAGE,
          packageDir: PACKAGE,
        },
        fakeFs([path.join(DIR, 'root-manifest.ts')])
      )
    ).toEqual([path.join(DIR, 'root-manifest.ts')]);
  });

  it('refuses a run naming no test file, and names the whole-package route', () => {
    expect(() =>
      modulesUnderTest(
        { sources: [], testFiles: [], invocationDir: PACKAGE, packageDir: PACKAGE },
        fakeFs([])
      )
    ).toThrow(/name the test files to measure[\s\S]*pnpm test:pkg/);
  });

  it('refuses a directory, which names no test file to derive a module from', () => {
    expect(() =>
      modulesUnderTest(
        { sources: [], testFiles: [DIR], invocationDir: PACKAGE, packageDir: PACKAGE },
        fakeFs([], [DIR])
      )
    ).toThrow(/src is a directory/);
  });

  it('refuses a named module that is not on disk', () => {
    expect(() =>
      modulesUnderTest(
        { sources: ['typo.ts'], testFiles: [], invocationDir: PACKAGE, packageDir: PACKAGE },
        fakeFs([])
      )
    ).toThrow(/--source names no file: typo\.ts/);
  });

  it('refuses a named module it cannot measure beside one it can, naming the dropped module', () => {
    expect(() =>
      modulesUnderTest(
        {
          sources: [path.join('src', 'api-client.ts'), OUTSIDE],
          testFiles: [path.join(DIR, 'api-client.test.ts')],
          invocationDir: PACKAGE,
          packageDir: PACKAGE,
        },
        fakeFs([path.join(DIR, 'api-client.ts'), path.resolve(PACKAGE, OUTSIDE)])
      )
    ).toThrow(OUTSIDE);
  });

  it('leaves a scope it can measure no part of to the empty-scope refusal downstream', () => {
    expect(
      modulesUnderTest(
        {
          sources: [OUTSIDE],
          testFiles: [path.join(DIR, 'api-client.test.ts')],
          invocationDir: PACKAGE,
          packageDir: PACKAGE,
        },
        fakeFs([path.resolve(PACKAGE, OUTSIDE)])
      )
    ).toEqual([path.resolve(PACKAGE, OUTSIDE)]);
  });
});
