// A module the runner is told to load before a test runs is named here as a
// path string, which no linter follows and no compiler resolves. Deleting such
// a module leaves the declaration naming nothing, and vitest fails collection
// rather than degrading — so every test file resolving this configuration
// stops collecting at once, in every package, and the first report of it is a
// suite that will not run. This asserts the one property that would have
// caught that at its source: the paths the declaration names are on disk.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import rootConfig from './vitest.config.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The declared value as the list it may also be spelled as a single string of. */
function declaredPaths(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Which of the declared modules are not on disk, named relative to the
 * repository so the failure reads the same on every machine.
 */
function missing(value) {
  return declaredPaths(value)
    .filter((modulePath) => !existsSync(modulePath))
    .map((modulePath) => path.relative(REPO_ROOT, modulePath).split(path.sep).join('/'));
}

describe('the modules the shared configuration loads before a test', () => {
  it('names per-worker setup modules that are all on disk', () => {
    const { setupFiles } = rootConfig.test;

    expect(declaredPaths(setupFiles).length).toBeGreaterThan(0);
    expect(missing(setupFiles)).toEqual([]);
  });

  it('names global setup modules that are all on disk', () => {
    const { globalSetup } = rootConfig.test;

    expect(declaredPaths(globalSetup).length).toBeGreaterThan(0);
    expect(missing(globalSetup)).toEqual([]);
  });
});
