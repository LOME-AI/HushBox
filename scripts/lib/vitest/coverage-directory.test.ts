import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { coverageDirectory, coverageDirectoryRunId } from '../../run-package-tests.js';
import { UNKEYED_COVERAGE_DIRECTORY } from './coverage-directory.js';

describe('the coverage directory a run gets when nothing keyed one to its claim', () => {
  it('sits below the directory the run-keyed ones sit in, rather than being it', () => {
    const unkeyed = path.join('package', UNKEYED_COVERAGE_DIRECTORY);
    const parent = coverageDirectory('package');

    expect(path.dirname(unkeyed)).toBe(parent);
    expect(unkeyed).not.toBe(parent);
  });

  it('carries a name no run can be read out of', () => {
    expect(coverageDirectoryRunId(path.basename(UNKEYED_COVERAGE_DIRECTORY))).toBeUndefined();
  });
});
