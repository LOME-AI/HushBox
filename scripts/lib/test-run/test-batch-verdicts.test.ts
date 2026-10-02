import { describe, expect, it } from 'vitest';

import { computeVerdicts, parseThresholdFailures } from './test-batch-verdicts.js';
import { noTestFilesCollectedReason, partialCoverageReason } from '../vitest/coverage-scope.js';
import type { VitestJsonReport } from './test-report.js';

const REPO_ROOT = '/repo';
const COVERAGE_DIR = '/repo/coverage/run-1';
const API = {
  package: '@hushbox/api',
  dir: '/repo/apps/api',
  coverageInclude: ['apps/api/src/**'],
};
const DB = {
  package: '@hushbox/db',
  dir: '/repo/packages/db',
  coverageInclude: ['packages/db/src/**'],
};

/** A map in which both fixture packages measured a file, as a healthy run leaves. */
function fullCoverageMap(): Record<string, unknown> {
  return { '/repo/apps/api/src/a.ts': {}, '/repo/packages/db/src/b.ts': {} };
}

function passingReport(): VitestJsonReport {
  return {
    testResults: [
      { name: '/repo/apps/api/a.test.ts', startTime: 0, endTime: 10, status: 'passed' },
      { name: '/repo/packages/db/b.test.ts', startTime: 0, endTime: 10, status: 'passed' },
    ],
  };
}

describe('parseThresholdFailures', () => {
  it('extracts the file from each per-file threshold error line', () => {
    const output = [
      'ERROR: Coverage for branches (90%) does not meet global threshold (95%) for scripts/lib/cli/pushed-range.ts',
      'ERROR: Coverage for lines (88.23%) does not meet global threshold (95%) for apps/api/src/app.ts',
      'unrelated line',
    ].join('\n');
    expect(parseThresholdFailures(output)).toEqual([
      'scripts/lib/cli/pushed-range.ts',
      'apps/api/src/app.ts',
    ]);
  });

  it('returns nothing for output without threshold errors', () => {
    expect(parseThresholdFailures('all good\n')).toEqual([]);
  });
});

describe('computeVerdicts', () => {
  it('passes every package on a clean run', () => {
    const verdicts = computeVerdicts({
      repoRoot: REPO_ROOT,
      packages: [API, DB],
      vitestExitCode: 0,
      report: passingReport(),
      errorOutput: '',
      offsetDivergences: [],
      coverageMap: fullCoverageMap(),
      coverageReportsDirectory: COVERAGE_DIR,
    });
    expect(verdicts.get(API.package)).toEqual({ ok: true, reasons: [] });
    expect(verdicts.get(DB.package)).toEqual({ ok: true, reasons: [] });
  });

  it('fails every package when the run wrote no report', () => {
    const verdicts = computeVerdicts({
      repoRoot: REPO_ROOT,
      packages: [API, DB],
      vitestExitCode: 1,
      report: undefined,
      errorOutput: '',
      offsetDivergences: [],
      coverageMap: fullCoverageMap(),
      coverageReportsDirectory: COVERAGE_DIR,
    });
    expect(verdicts.get(API.package)?.ok).toBe(false);
    expect(verdicts.get(DB.package)?.ok).toBe(false);
  });

  it('attributes a failed test file to its package only', () => {
    const report = passingReport();
    const verdicts = computeVerdicts({
      repoRoot: REPO_ROOT,
      packages: [API, DB],
      vitestExitCode: 1,
      report: {
        testResults: [
          ...(report.testResults ?? []),
          { name: '/repo/apps/api/broken.test.ts', startTime: 0, endTime: 10, status: 'failed' },
        ],
      },
      errorOutput: '',
      offsetDivergences: [],
      coverageMap: fullCoverageMap(),
      coverageReportsDirectory: COVERAGE_DIR,
    });
    expect(verdicts.get(API.package)?.ok).toBe(false);
    expect(verdicts.get(API.package)?.reasons[0]).toContain('broken.test.ts');
    expect(verdicts.get(DB.package)?.reasons.join('\n')).not.toContain('broken.test.ts');
  });

  it('marks the coverage numbers of a package whose test file failed as partial', () => {
    const report = passingReport();
    const verdicts = computeVerdicts({
      repoRoot: REPO_ROOT,
      packages: [API, DB],
      vitestExitCode: 1,
      report: {
        testResults: [
          ...(report.testResults ?? []),
          { name: '/repo/apps/api/broken.test.ts', startTime: 0, endTime: 10, status: 'failed' },
        ],
      },
      errorOutput: '',
      offsetDivergences: [],
      coverageMap: fullCoverageMap(),
      coverageReportsDirectory: COVERAGE_DIR,
    });
    expect(verdicts.get(API.package)?.reasons).toContain(partialCoverageReason(1));
  });

  it('fails a package nothing attributed when another package’s failure explained the exit', () => {
    const report = passingReport();
    const verdicts = computeVerdicts({
      repoRoot: REPO_ROOT,
      packages: [API, DB],
      vitestExitCode: 1,
      report: {
        testResults: [
          ...(report.testResults ?? []),
          { name: '/repo/apps/api/broken.test.ts', startTime: 0, endTime: 10, status: 'failed' },
        ],
      },
      errorOutput: '',
      offsetDivergences: [],
      coverageMap: fullCoverageMap(),
      coverageReportsDirectory: COVERAGE_DIR,
    });
    expect(verdicts.get(API.package)?.ok).toBe(false);
    expect(verdicts.get(DB.package)?.ok).toBe(false);
    expect(verdicts.get(DB.package)?.reasons.join('\n')).toContain(DB.package);
  });

  it('states the partial line ahead of the coverage shortfalls it qualifies', () => {
    const verdicts = computeVerdicts({
      repoRoot: REPO_ROOT,
      packages: [API],
      vitestExitCode: 1,
      report: {
        testResults: [
          { name: '/repo/apps/api/broken.test.ts', startTime: 0, endTime: 10, status: 'failed' },
        ],
      },
      errorOutput:
        'ERROR: Coverage for lines (10%) does not meet global threshold (95%) for apps/api/src/a.ts',
      offsetDivergences: [],
      coverageMap: fullCoverageMap(),
      coverageReportsDirectory: COVERAGE_DIR,
    });
    const reasons = verdicts.get(API.package)?.reasons ?? [];
    expect(
      reasons.filter(
        (reason) =>
          reason === partialCoverageReason(1) || reason.includes('coverage threshold not met')
      )
    ).toEqual([partialCoverageReason(1), 'coverage threshold not met: /repo/apps/api/src/a.ts']);
  });

  it('fails every batched package when the run wrote no coverage map', () => {
    const report = passingReport();
    const verdicts = computeVerdicts({
      repoRoot: REPO_ROOT,
      packages: [API, DB],
      vitestExitCode: 1,
      report: {
        testResults: [
          ...(report.testResults ?? []),
          { name: '/repo/apps/api/broken.test.ts', startTime: 0, endTime: 10, status: 'failed' },
        ],
      },
      errorOutput: '',
      offsetDivergences: [],
      coverageMap: undefined,
      coverageReportsDirectory: COVERAGE_DIR,
    });
    expect(verdicts.get(DB.package)?.ok).toBe(false);
    expect(verdicts.get(DB.package)?.reasons.join('\n')).toContain('COVERAGE NOT EVALUATED');
    expect(verdicts.get(API.package)?.reasons.join('\n')).toContain('COVERAGE NOT EVALUATED');
  });

  it('attributes a coverage-threshold shortfall by its repo-relative path', () => {
    const verdicts = computeVerdicts({
      repoRoot: REPO_ROOT,
      packages: [API, DB],
      vitestExitCode: 1,
      report: passingReport(),
      errorOutput:
        'ERROR: Coverage for lines (10%) does not meet global threshold (95%) for packages/db/src/x.ts',
      offsetDivergences: [],
      coverageMap: fullCoverageMap(),
      coverageReportsDirectory: COVERAGE_DIR,
    });
    expect(verdicts.get(DB.package)?.ok).toBe(false);
    expect(verdicts.get(API.package)?.reasons.join('\n')).not.toContain(
      'coverage threshold not met'
    );
  });

  it('attributes a pole to the package whose files majority-share it', () => {
    const verdicts = computeVerdicts({
      repoRoot: REPO_ROOT,
      packages: [API, DB],
      vitestExitCode: 0,
      report: {
        testResults: [
          { name: '/repo/apps/api/huge.test.ts', startTime: 0, endTime: 60_000, status: 'passed' },
          { name: '/repo/apps/api/tiny.test.ts', startTime: 0, endTime: 100, status: 'passed' },
          { name: '/repo/packages/db/b.test.ts', startTime: 0, endTime: 10, status: 'passed' },
        ],
      },
      errorOutput: '',
      offsetDivergences: [],
      coverageMap: fullCoverageMap(),
      coverageReportsDirectory: COVERAGE_DIR,
    });
    expect(verdicts.get(API.package)?.ok).toBe(false);
    expect(verdicts.get(API.package)?.reasons[0]).toContain('POLE TEST FILE');
    expect(verdicts.get(DB.package)?.ok).toBe(true);
  });

  it('attributes an offset divergence through its file url', () => {
    const verdicts = computeVerdicts({
      repoRoot: REPO_ROOT,
      packages: [API, DB],
      vitestExitCode: 0,
      report: passingReport(),
      errorOutput: '',
      offsetDivergences: [
        { url: 'file:///repo/packages/db/src/store.ts', offsets: [] },
        { url: 'not-a-file-url', offsets: [] },
      ],
      coverageMap: fullCoverageMap(),
      coverageReportsDirectory: COVERAGE_DIR,
    });
    expect(verdicts.get(DB.package)?.ok).toBe(false);
    expect(verdicts.get(API.package)?.ok).toBe(true);
  });

  it('fails every package on a non-zero exit that nothing attributes', () => {
    const verdicts = computeVerdicts({
      repoRoot: REPO_ROOT,
      packages: [API, DB],
      vitestExitCode: 1,
      report: passingReport(),
      errorOutput: '',
      offsetDivergences: [],
      coverageMap: fullCoverageMap(),
      coverageReportsDirectory: COVERAGE_DIR,
    });
    expect(verdicts.get(API.package)?.ok).toBe(false);
    expect(verdicts.get(DB.package)?.ok).toBe(false);
    expect(verdicts.get(API.package)?.reasons[0]).toContain(
      `no failure attributed to ${API.package}`
    );
  });

  it('treats a missing offset scan as no offset evidence, not a failure', () => {
    const verdicts = computeVerdicts({
      repoRoot: REPO_ROOT,
      packages: [API],
      vitestExitCode: 0,
      report: passingReport(),
      errorOutput: '',
      offsetDivergences: undefined,
      coverageMap: fullCoverageMap(),
      coverageReportsDirectory: COVERAGE_DIR,
    });
    expect(verdicts.get(API.package)?.ok).toBe(true);
  });
});

describe('computeVerdicts — empty coverage scope', () => {
  it('fails a package whose files are absent from the coverage map', () => {
    const verdicts = computeVerdicts({
      repoRoot: REPO_ROOT,
      packages: [API, DB],
      vitestExitCode: 0,
      report: passingReport(),
      errorOutput: '',
      offsetDivergences: [],
      coverageMap: { '/repo/packages/db/src/b.ts': {} },
      coverageReportsDirectory: COVERAGE_DIR,
    });
    expect(verdicts.get(API.package)?.ok).toBe(false);
    expect(verdicts.get(API.package)?.reasons.join('\n')).toContain('EMPTY COVERAGE SCOPE');
    expect(verdicts.get(DB.package)).toEqual({ ok: true, reasons: [] });
  });

  it('names the scope that was in force', () => {
    const verdicts = computeVerdicts({
      repoRoot: REPO_ROOT,
      packages: [API],
      vitestExitCode: 0,
      report: passingReport(),
      errorOutput: '',
      offsetDivergences: [],
      coverageMap: {},
      coverageReportsDirectory: COVERAGE_DIR,
    });
    expect(verdicts.get(API.package)?.reasons.join('\n')).toContain('apps/api/src/**');
  });

  it('reports an absent coverage map as unevaluated rather than as an empty scope', () => {
    const verdicts = computeVerdicts({
      repoRoot: REPO_ROOT,
      packages: [API, DB],
      vitestExitCode: 0,
      report: passingReport(),
      errorOutput: '',
      offsetDivergences: [],
      coverageMap: undefined,
      coverageReportsDirectory: COVERAGE_DIR,
    });
    const reasons = verdicts.get(API.package)?.reasons.join('\n') ?? '';
    expect(reasons).toContain('COVERAGE NOT EVALUATED');
    expect(reasons).not.toContain('EMPTY COVERAGE SCOPE');
  });

  it('names the directory the absent coverage map was expected in', () => {
    const verdicts = computeVerdicts({
      repoRoot: REPO_ROOT,
      packages: [API],
      vitestExitCode: 0,
      report: passingReport(),
      errorOutput: '',
      offsetDivergences: [],
      coverageMap: undefined,
      coverageReportsDirectory: COVERAGE_DIR,
    });
    expect(verdicts.get(API.package)?.reasons.join('\n')).toContain(COVERAGE_DIR);
  });

  it('fails a green batch that evaluated no coverage, so nothing caches as a pass', () => {
    const verdicts = computeVerdicts({
      repoRoot: REPO_ROOT,
      packages: [API, DB],
      vitestExitCode: 0,
      report: passingReport(),
      errorOutput: '',
      offsetDivergences: [],
      coverageMap: undefined,
      coverageReportsDirectory: COVERAGE_DIR,
    });
    expect(verdicts.get(API.package)?.ok).toBe(false);
    expect(verdicts.get(DB.package)?.ok).toBe(false);
  });

  it('keeps the unattributable-exit reason alongside the unevaluated one', () => {
    const verdicts = computeVerdicts({
      repoRoot: REPO_ROOT,
      packages: [API],
      vitestExitCode: 7,
      report: passingReport(),
      errorOutput: '',
      offsetDivergences: [],
      coverageMap: undefined,
      coverageReportsDirectory: COVERAGE_DIR,
    });
    const reasons = verdicts.get(API.package)?.reasons.join('\n') ?? '';
    expect(reasons).toContain('COVERAGE NOT EVALUATED');
    expect(reasons).toContain(`exited 7 with no failure attributed to ${API.package}`);
  });

  it('says coverage went unevaluated even when no json report was written either', () => {
    const verdicts = computeVerdicts({
      repoRoot: REPO_ROOT,
      packages: [API],
      vitestExitCode: 1,
      report: undefined,
      errorOutput: '',
      offsetDivergences: [],
      coverageMap: undefined,
      coverageReportsDirectory: COVERAGE_DIR,
    });
    const reasons = verdicts.get(API.package)?.reasons.join('\n') ?? '';
    expect(reasons).toContain('COVERAGE NOT EVALUATED');
    expect(reasons).toContain('no json report');
  });
});

describe('computeVerdicts — no test file collected', () => {
  it('fails a package whose directory holds no collected test file', () => {
    const verdicts = computeVerdicts({
      repoRoot: REPO_ROOT,
      packages: [API, DB],
      vitestExitCode: 0,
      report: {
        testResults: [
          { name: '/repo/apps/api/a.test.ts', startTime: 0, endTime: 10, status: 'passed' },
        ],
      },
      errorOutput: '',
      offsetDivergences: [],
      coverageMap: fullCoverageMap(),
      coverageReportsDirectory: COVERAGE_DIR,
    });
    expect(verdicts.get(DB.package)?.ok).toBe(false);
    expect(verdicts.get(DB.package)?.reasons.join('\n')).toContain('NO TEST FILES COLLECTED');
    expect(verdicts.get(API.package)).toEqual({ ok: true, reasons: [] });
  });

  it('carries the shared reason verbatim rather than a wording of its own', () => {
    const verdicts = computeVerdicts({
      repoRoot: REPO_ROOT,
      packages: [API, DB],
      vitestExitCode: 0,
      report: {
        testResults: [
          { name: '/repo/apps/api/a.test.ts', startTime: 0, endTime: 10, status: 'passed' },
        ],
      },
      errorOutput: '',
      offsetDivergences: [],
      coverageMap: fullCoverageMap(),
      coverageReportsDirectory: COVERAGE_DIR,
    });
    expect(verdicts.get(DB.package)?.reasons).toContain(noTestFilesCollectedReason());
  });

  it('leaves a package that collected a test file unremarked', () => {
    const verdicts = computeVerdicts({
      repoRoot: REPO_ROOT,
      packages: [API, DB],
      vitestExitCode: 0,
      report: passingReport(),
      errorOutput: '',
      offsetDivergences: [],
      coverageMap: fullCoverageMap(),
      coverageReportsDirectory: COVERAGE_DIR,
    });
    expect(verdicts.get(API.package)?.reasons.join('\n')).not.toContain('NO TEST FILES COLLECTED');
    expect(verdicts.get(DB.package)?.reasons.join('\n')).not.toContain('NO TEST FILES COLLECTED');
  });

  it('fails every package when the report carries no test-result list at all', () => {
    const verdicts = computeVerdicts({
      repoRoot: REPO_ROOT,
      packages: [API, DB],
      vitestExitCode: 0,
      report: {},
      errorOutput: '',
      offsetDivergences: [],
      coverageMap: fullCoverageMap(),
      coverageReportsDirectory: COVERAGE_DIR,
    });
    expect(verdicts.get(API.package)?.reasons.join('\n')).toContain('NO TEST FILES COLLECTED');
    expect(verdicts.get(DB.package)?.reasons.join('\n')).toContain('NO TEST FILES COLLECTED');
  });

  it('counts a test-result entry naming no file as collecting nothing', () => {
    const verdicts = computeVerdicts({
      repoRoot: REPO_ROOT,
      packages: [API],
      vitestExitCode: 0,
      report: { testResults: [{ startTime: 0, endTime: 10, status: 'passed' }] },
      errorOutput: '',
      offsetDivergences: [],
      coverageMap: fullCoverageMap(),
      coverageReportsDirectory: COVERAGE_DIR,
    });
    expect(verdicts.get(API.package)?.reasons.join('\n')).toContain('NO TEST FILES COLLECTED');
  });

  it('leads the package reasons, ahead of the coverage shortfalls it accounts for', () => {
    const verdicts = computeVerdicts({
      repoRoot: REPO_ROOT,
      packages: [DB],
      vitestExitCode: 1,
      report: {
        testResults: [
          { name: '/repo/apps/api/a.test.ts', startTime: 0, endTime: 10, status: 'passed' },
        ],
      },
      errorOutput:
        'ERROR: Coverage for lines (0%) does not meet global threshold (95%) for packages/db/src/b.ts',
      offsetDivergences: [],
      coverageMap: fullCoverageMap(),
      coverageReportsDirectory: COVERAGE_DIR,
    });
    expect(verdicts.get(DB.package)?.reasons[0]).toContain('NO TEST FILES COLLECTED');
    expect(verdicts.get(DB.package)?.reasons.join('\n')).toContain('coverage threshold not met');
  });
});
