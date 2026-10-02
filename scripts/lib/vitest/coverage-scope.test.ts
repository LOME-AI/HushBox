import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  collectedNoTestFile,
  coverageNotEvaluatedReason,
  emptyCoverageScopeReason,
  measuredNoFile,
  noTestFilesCollectedReason,
  partialCoverageReason,
  underDirectory,
} from './coverage-scope.js';

const PACKAGE_DIR = path.join(path.sep, 'repo', 'apps', 'api');
const MEASURED_FILE = path.join(PACKAGE_DIR, 'src', 'a.ts');
const TEST_FILE = path.join(PACKAGE_DIR, 'src', 'a.test.ts');

describe('underDirectory', () => {
  it('accepts a file inside the directory', () => {
    expect(underDirectory(MEASURED_FILE, PACKAGE_DIR)).toBe(true);
  });

  it('rejects a sibling directory whose name starts with the same characters', () => {
    const sibling = path.join(path.sep, 'repo', 'apps', 'api-docs', 'a.ts');
    expect(underDirectory(sibling, PACKAGE_DIR)).toBe(false);
  });

  it('accepts a file inside a directory already given with a trailing separator', () => {
    expect(underDirectory(MEASURED_FILE, `${PACKAGE_DIR}${path.sep}`)).toBe(true);
  });
});

describe('measuredNoFile', () => {
  it('is true when no measured file lies inside the package', () => {
    const elsewhere = path.join(path.sep, 'repo', 'packages', 'db', 'src', 'b.ts');
    expect(measuredNoFile({ [elsewhere]: {} }, PACKAGE_DIR)).toBe(true);
  });

  it('is false when a measured file lies inside the package', () => {
    expect(measuredNoFile({ [MEASURED_FILE]: {} }, PACKAGE_DIR)).toBe(false);
  });
});

describe('emptyCoverageScopeReason', () => {
  it('names every glob the scope was in force with', () => {
    expect(emptyCoverageScopeReason(['apps/api/src/**', 'apps/api/bin/**'])).toContain(
      '(apps/api/src/**, apps/api/bin/**)'
    );
  });
});

describe('coverageNotEvaluatedReason', () => {
  it('names the directory no coverage map arrived in', () => {
    expect(coverageNotEvaluatedReason('/repo/coverage/run-1')).toContain('/repo/coverage/run-1');
  });

  it('says coverage went unevaluated rather than that it passed', () => {
    const reason = coverageNotEvaluatedReason('/repo/coverage/run-1');
    expect(reason).toContain('COVERAGE NOT EVALUATED');
    expect(reason).not.toContain('EMPTY COVERAGE SCOPE');
  });
});

describe('collectedNoTestFile', () => {
  it('is true when every executed test file lies outside the package', () => {
    const elsewhere = path.join(path.sep, 'repo', 'packages', 'db', 'src', 'b.test.ts');
    expect(collectedNoTestFile({ testResults: [{ name: elsewhere }] }, PACKAGE_DIR)).toBe(true);
  });

  it('is false when an executed test file lies inside the package', () => {
    expect(collectedNoTestFile({ testResults: [{ name: TEST_FILE }] }, PACKAGE_DIR)).toBe(false);
  });

  it('is true for a report carrying no test-result list at all', () => {
    expect(collectedNoTestFile({}, PACKAGE_DIR)).toBe(true);
  });

  it('is true for a result entry carrying no file name', () => {
    expect(collectedNoTestFile({ testResults: [{}] }, PACKAGE_DIR)).toBe(true);
  });
});

describe('noTestFilesCollectedReason', () => {
  it('says the verdict proves nothing rather than that the package passed', () => {
    const reason = noTestFilesCollectedReason();
    expect(reason).toContain('NO TEST FILES COLLECTED');
    expect(reason).toContain('proves nothing');
  });

  it('states the fact without prescribing which cause produced it', () => {
    expect(noTestFilesCollectedReason()).not.toContain('fault');
  });
});

describe('partialCoverageReason', () => {
  it('names how many test files failed rather than only that some did', () => {
    expect(partialCoverageReason(3)).toContain('3 test files failed');
  });

  it('says the map is partial in the word a reader scans for', () => {
    expect(partialCoverageReason(3)).toContain('PARTIAL COVERAGE');
  });

  it('counts a single failed file in the singular', () => {
    expect(partialCoverageReason(1)).toContain('1 test file failed');
  });
});
