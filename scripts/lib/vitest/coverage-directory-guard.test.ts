import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { cancelCoverageReports, coverageDirectoryRefusal } from './coverage-directory-guard.js';
import { COVERAGE_RUN_ROUTES } from '../test-run/test-routes.js';

const RUN_ID = 'a-b';
const RUN_SCOPED = path.join(path.sep, 'repo', 'coverage', `run-${RUN_ID}`);
const SHARED = path.join(path.sep, 'repo', 'coverage');

describe('coverageDirectoryRefusal', () => {
  it('permits a run whose coverage is off, whatever directory it names', () => {
    expect(
      coverageDirectoryRefusal({ enabled: false, reportsDirectory: SHARED, runId: RUN_ID })
    ).toBeUndefined();
  });

  it('permits a coverage run writing the directory its own claim keys', () => {
    expect(
      coverageDirectoryRefusal({ enabled: true, reportsDirectory: RUN_SCOPED, runId: RUN_ID })
    ).toBeUndefined();
  });

  it('refuses a coverage run writing the shared directory', () => {
    const refusal = coverageDirectoryRefusal({
      enabled: true,
      reportsDirectory: SHARED,
      runId: RUN_ID,
    });
    expect(refusal).toContain('SHARED COVERAGE DIRECTORY');
  });

  it('names the offending directory so the invocation can be found', () => {
    const refusal = coverageDirectoryRefusal({
      enabled: true,
      reportsDirectory: SHARED,
      runId: RUN_ID,
    });
    expect(refusal).toContain(SHARED);
  });

  it('names the run-scoped directory the invocation should have written', () => {
    const refusal = coverageDirectoryRefusal({
      enabled: true,
      reportsDirectory: SHARED,
      runId: RUN_ID,
    });
    expect(refusal).toContain(`run-${RUN_ID}`);
  });

  it('refuses a coverage run writing another run’s directory', () => {
    const foreign = path.join(path.sep, 'repo', 'coverage', 'run-c-d');
    expect(
      coverageDirectoryRefusal({ enabled: true, reportsDirectory: foreign, runId: RUN_ID })
    ).toContain('SHARED COVERAGE DIRECTORY');
  });

  it('refuses a coverage run holding no claim at all', () => {
    const refusal = coverageDirectoryRefusal({
      enabled: true,
      reportsDirectory: RUN_SCOPED,
      runId: null,
    });
    expect(refusal).toContain('NO RUN CLAIM');
  });

  it('tells a claimless run which entry point takes the claim', () => {
    const refusal = coverageDirectoryRefusal({
      enabled: true,
      reportsDirectory: RUN_SCOPED,
      runId: null,
    });
    expect(refusal).toContain('with-env');
  });

  it.each([
    ['no claim', { enabled: true, reportsDirectory: RUN_SCOPED, runId: null }],
    [
      'a directory its claim does not key',
      { enabled: true, reportsDirectory: SHARED, runId: RUN_ID },
    ],
  ] as const)('cites the one clause naming the supported routes for %s', (_case, request) => {
    expect(coverageDirectoryRefusal(request)).toContain(COVERAGE_RUN_ROUTES);
  });
});

describe('cancelCoverageReports', () => {
  it('leaves no report writer to run once the refusal has been raised', () => {
    const coverage = { reporter: ['text', 'json'] };
    cancelCoverageReports(coverage);
    expect(coverage.reporter).toEqual([]);
  });
});
