import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfigFromFile } from 'vite';
import { defineConfig, mergeConfig } from 'vitest/config';
import type { ViteUserConfig } from 'vitest/config';

import type * as LptSequencerModule from './scripts/lib/vitest/lpt-sequencer.ts';

// Same constraint the shared base documents for vitest-cache.ts: a static
// relative .ts import can't carry its extension here, so the runtime import
// goes through an explicit URL and the type rides a type-only import.
const { LptSequencer } = (await import(
  new URL('scripts/lib/vitest/lpt-sequencer.ts', import.meta.url).href
)) as typeof LptSequencerModule;

/**
 * The consolidated test run: every forks-pool package as a project in one
 * vitest invocation, so a single global worker pool schedules all test files.
 * The three `*.workers.test.ts` suites (api, db, realtime) ride
 * `@cloudflare/vitest-pool-workers` — a different execution substrate — and
 * stay separate invocations.
 *
 * Each package's own vitest.config.ts remains the authority on how its tests
 * run; this file only lifts those configs into project entries. Configs are
 * loaded via runtime URL imports, never static imports: Vite would bundle a
 * static import into this file's compiled config, rewriting each config's
 * `import.meta.url` to the repo root and breaking every path derived from it.
 */

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));

// Same loading constraint as the sequencer import below: static relative .ts
// imports cannot carry their extension here, so the discovery module rides an
// explicit-URL runtime import.
const { discoverTestPackages } = (await import(
  new URL('scripts/lib/test-run/test-packages.ts', import.meta.url).href
)) as typeof import('./scripts/lib/test-run/test-packages.ts');
const { liftedCacheDir } = (await import(
  new URL('scripts/lib/vitest/vitest-cache.ts', import.meta.url).href
)) as typeof import('./scripts/lib/vitest/vitest-cache.ts');

type ProjectEntry = Readonly<Record<string, unknown>>;

/** Copy `source` without `keys`; a rest-destructure would bind each dropped key. */
function omit(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !keys.includes(key)));
}

/**
 * Lift one package config into inline project entries.
 *
 * - `globalSetup` is stripped: it runs once from this root config instead of
 *   once per project (17 serial executions at startup).
 * - `coverage` is stripped: root-only in vitest 4; the union lives below.
 * - `maxWorkers` is stripped: the global pool bound is this root config's.
 * - A package config with its own `projects` array (api, crypto) is flattened
 *   here, because vitest 4 silently ignores nested projects; each inner
 *   entry's `extends: true` against its package config is emulated by
 *   spreading the package-level test options under the inner overrides.
 * - `cacheDir` is moved beneath the lifted segment: a lifted project resolves
 *   its relative cache directory against the same root a package-rooted
 *   invocation does, and the two shapes bundle under different optimizer
 *   hashes, so sharing the directory means each deletes the other's bundle
 *   while it is being imported (`scripts/lib/vitest/vitest-cache.ts`).
 */
function liftProjects(dir: string, shortName: string, config: ViteUserConfig): ProjectEntry[] {
  const test = (config.test ?? {}) as Record<string, unknown>;
  const projects = test['projects'];
  const testRest = omit(test, ['projects', 'globalSetup', 'coverage', 'maxWorkers']);
  const viteRest = omit(config as Record<string, unknown>, ['test']);
  const root = path.join(REPO_ROOT, dir);
  const cacheDir = liftedCacheDir((config as { cacheDir?: string }).cacheDir, dir);
  if (Array.isArray(projects)) {
    return projects.map((entry) => {
      const inner = (entry as { test?: Record<string, unknown> }).test ?? {};
      // mergeConfig, not spread: `extends: true` concatenates arrays (the api
      // project's exclude list stacks on the base exclude list), and a spread
      // would replace them.
      return mergeConfig(
        { ...viteRest, root, cacheDir, test: testRest },
        { test: inner }
      ) as ProjectEntry;
    });
  }
  return [
    mergeConfig(
      { test: { name: shortName } },
      { ...viteRest, root, cacheDir, test: testRest }
    ) as ProjectEntry,
  ];
}

/** Remap a package-relative coverage glob list to repo-root-relative. */
function remapGlobs(dir: string, globs: readonly string[] | undefined): string[] {
  return (globs ?? []).map((glob) =>
    glob.startsWith('!') ? `!${path.posix.join(dir, glob.slice(1))}` : path.posix.join(dir, glob)
  );
}

const projects: ProjectEntry[] = [];
const coverageInclude: string[] = [];
const coverageExclude: string[] = [];

const CONFIG_ENV = { command: 'serve', mode: 'test' } as const;

async function loadPackageConfig(dir: string, configFile: string): Promise<ViteUserConfig> {
  const file = path.join(REPO_ROOT, dir, configFile);
  const loaded = await loadConfigFromFile(CONFIG_ENV, file, path.join(REPO_ROOT, dir));
  if (!loaded) {
    throw new Error(`failed to load ${file}`);
  }
  return loaded.config;
}

// Sequential deliberately: concurrent `loadConfigFromFile` calls in this
// context terminate the process silently with exit 0 mid-evaluation
// (reproduced on vite 8 — the run ends before vitest even banners, with no
// error), so the ~2s the serial loop costs buys a run that happens at all.
const loaded = [];
for (const testPackage of discoverTestPackages(REPO_ROOT)) {
  loaded.push({
    testPackage,
    config: await loadPackageConfig(testPackage.dir, testPackage.configFile),
  });
}
for (const { testPackage, config } of loaded) {
  const { dir } = testPackage;
  const shortName = dir.slice(dir.lastIndexOf('/') + 1);
  projects.push(...liftProjects(dir, shortName, config));
  const coverage = (
    config.test as { coverage?: { include?: string[]; exclude?: string[] } } | undefined
  )?.coverage;
  coverageInclude.push(...remapGlobs(dir, coverage?.include));
  coverageExclude.push(...remapGlobs(dir, coverage?.exclude));
}

const base = await loadPackageConfig('packages/config', 'vitest.config.ts');

const baseTest = (base.test ?? {}) as Record<string, unknown>;
const baseCoverage = (baseTest['coverage'] ?? {}) as Record<string, unknown>;

/**
 * The consolidated vitest config: the test runners name this file on vitest's
 * `--config`, so no module imports it.
 * @toolContract
 */
export default defineConfig({
  // Partitioned for the same reason each lifted project's is: this instance is
  // rooted at the repository and carries no project name, which is exactly what
  // a bare invocation from the repository root resolves to as well.
  cacheDir: liftedCacheDir((base as { cacheDir?: string }).cacheDir, 'packages/config'),
  test: {
    // The worker ceiling rides this spread: the shared base declares it from the
    // same derivation the batch coordinator calls for the value it passes on the
    // CLI, so a declaration here would be a second call to one decision.
    ...baseTest,
    sequence: { sequencer: LptSequencer },
    coverage: {
      ...baseCoverage,
      provider: 'custom',
      customProviderModule: path.join(REPO_ROOT, 'scripts/lib/vitest/coverage-provider.ts'),
      include: coverageInclude,
      exclude: [...((baseCoverage['exclude'] as string[] | undefined) ?? []), ...coverageExclude],
    },
    projects: projects as never,
  },
});
