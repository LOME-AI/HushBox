// Every package's vitest config merges this one, so its coverage defaults are
// what a package that declares nothing gets. Per-file checking is the safe
// setting and therefore the inherited one: an aggregate threshold lets a small
// completely untested file disappear into the average of the covered ones.
//
// `perFile` is a single top-level flag read once per run and applied to every
// threshold group — the global one and each glob one alike (vitest's
// `checkThresholds` reads `options.thresholds.perFile`, not the group's). That
// is why one inherited flag covers a package's own glob thresholds and why no
// package needs to restate it.
import { globSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig, mergeConfig } from 'vitest/config';
import { describe, expect, it } from 'vitest';
import { BaseCoverageProvider } from 'vitest/node';
import rootConfig from './vitest.config.ts';
import { UNKEYED_COVERAGE_DIRECTORY } from '../../scripts/lib/vitest/coverage-directory.ts';

describe('shared coverage defaults', () => {
  it('gates coverage per file', () => {
    expect(rootConfig.test.coverage.thresholds.perFile).toBe(true);
  });

  // A run that reaches vitest outside the runners inherits this directory, and
  // the provider empties it before global setup can refuse the run. Naming the
  // parent here is what let such a run remove every concurrent run's coverage
  // directory, so the default has to stay a level below it.
  it('writes a run the runners did not key below the directory their run-keyed ones sit in', () => {
    expect(rootConfig.test.coverage.reportsDirectory).toBe(UNKEYED_COVERAGE_DIRECTORY);
  });

  // One consolidated run covers every batched package, so a single red file
  // used to suppress the map for all of them — including packages with nothing
  // failing, which then reported no coverage verdict at all. The figures a
  // red run yields are partial and the runners say so; no figures at all is
  // what one developer's failure must not cost another.
  it('writes the coverage map even when a test file failed', () => {
    expect(rootConfig.test.coverage.reportOnFailure).toBe(true);
  });

  // The property that lets a package delete its own `perFile` rather than
  // restate it: a package declaring its own thresholds object still inherits
  // the flag, because mergeConfig merges into that object instead of replacing
  // it. If this ever stopped holding, every package's gate would silently fall
  // back to aggregate.
  it('keeps the per-file gate for a package declaring its own threshold globs', () => {
    const packageConfig = mergeConfig(
      rootConfig,
      defineConfig({
        test: {
          coverage: {
            include: ['src/**/*.ts'],
            thresholds: { 'src/**/*.ts': { lines: 95 } },
          },
        },
      })
    );

    expect(packageConfig.test.coverage.thresholds.perFile).toBe(true);
  });
});

const slash = (file) => file.replaceAll('\\', '/');

// Vitest matches coverage globs with picomatch `contains: true` — no
// end-anchoring — so a barrel exclude spelled `**/index.ts` also swallows an
// `index.tsx`. Every other matcher reading this same list is anchored:
// tinyglobby's `ignore` when the provider hunts untested files, and
// `fs.globSync` in the coverage-scope guard. A barrel exclude that reads
// differently under the two is a file one of them measures and the other does
// not, so both readings are pinned here.
describe('shared barrel exclude', () => {
  const barrelExclude = rootConfig.test.coverage.exclude;
  const FIXTURE_ROOT = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '__test-fixtures-coverage-globs__'
  );
  // The unanchored reading is taken over a stand-in package root rather than
  // the fixture directory: that directory's own name is swallowed by the
  // shared `__test-fixtures-*__` exclude under exactly the matcher under test,
  // which would hide both files for the wrong reason.
  const PACKAGE_ROOT = '/package-root';

  /** Vitest's own matcher, as the v8 provider calls it on every file. */
  const measuredByVitest = (file) => {
    const provider = new BaseCoverageProvider();
    provider.options = { include: ['src/**/*.ts', 'src/**/*.tsx'], exclude: barrelExclude };
    return provider.isIncluded(`${PACKAGE_ROOT}/${file}`, PACKAGE_ROOT);
  };

  /** The anchored matcher the coverage-scope guard resolves the same list with. */
  const excludedOnDisk = new Set(
    globSync([...barrelExclude], { cwd: FIXTURE_ROOT }).map((file) => slash(file))
  );

  it('drops an index.ts barrel from the coverage universe', () => {
    expect(measuredByVitest('src/lib/index.ts')).toBe(false);
  });

  it('keeps an index.tsx route in the coverage universe', () => {
    expect(measuredByVitest('src/routes/index.tsx')).toBe(true);
  });

  it('drops the same index.ts barrel under the anchored matcher', () => {
    expect(excludedOnDisk.has('src/lib/index.ts')).toBe(true);
  });

  it('keeps the same index.tsx route under the anchored matcher', () => {
    expect(excludedOnDisk.has('src/routes/index.tsx')).toBe(false);
  });
});

// A test-setup module is test infrastructure whatever it is written in, and the
// anchored matcher is where a `.ts`-only spelling of that says otherwise: the
// unanchored one lets `.setup.ts` swallow a `.setup.tsx` on its own, so a list
// naming one extension reads as covering both until the coverage-scope guard
// resolves it and disagrees.
describe('shared test-file exclude', () => {
  const FIXTURE_ROOT = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '__test-fixtures-coverage-globs__'
  );
  const excludedOnDisk = new Set(
    globSync([...rootConfig.test.coverage.exclude], { cwd: FIXTURE_ROOT }).map((file) =>
      slash(file)
    )
  );

  it('drops a test-setup module written outside .ts under the anchored matcher', () => {
    expect(excludedOnDisk.has('src/lib/seeding.setup.tsx')).toBe(true);
  });
});

// The shared exclude names the build-config families it means. Matching
// `.config.` anywhere in a name instead drops product source that follows the
// same naming convention — the environment-variable registry is such a file,
// and the convention that makes it findable is what removed it from the gate.
// Both readings are pinned here: a file one matcher measures and the other
// does not is a gate that depends on which run you took.
describe('shared build-config exclude', () => {
  const configExclude = rootConfig.test.coverage.exclude;
  const FIXTURE_ROOT = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '__test-fixtures-coverage-globs__'
  );
  const PACKAGE_ROOT = '/package-root';

  const measuredByVitest = (file) => {
    const provider = new BaseCoverageProvider();
    provider.options = { include: ['src/**/*.ts', '*.ts'], exclude: configExclude };
    return provider.isIncluded(`${PACKAGE_ROOT}/${file}`, PACKAGE_ROOT);
  };

  const excludedOnDisk = new Set(
    globSync([...configExclude], { cwd: FIXTURE_ROOT }).map((file) => slash(file))
  );

  it('keeps a source module named for the config convention in the coverage universe', () => {
    expect(measuredByVitest('src/env/env.config.ts')).toBe(true);
  });

  it('drops a build config named for its tool from the coverage universe', () => {
    expect(measuredByVitest('vite.config.ts')).toBe(false);
  });

  it('keeps the same source module under the anchored matcher', () => {
    expect(excludedOnDisk.has('src/env/env.config.ts')).toBe(false);
  });

  it('drops the same build config under the anchored matcher', () => {
    expect(excludedOnDisk.has('vite.config.ts')).toBe(true);
  });
});
