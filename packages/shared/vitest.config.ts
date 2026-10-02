import { defineConfig, mergeConfig } from 'vitest/config';
import rootConfig from '@hushbox/config/vitest';

const COVERAGE_GATE = {
  lines: 95,
  branches: 95,
  functions: 95,
  statements: 95,
};

export default mergeConfig(
  rootConfig,
  // defineConfig (not defineProject) because the coverage keys below are
  // root-level: the standalone `vitest run --coverage` invocation reads them.
  // defineProject silently drops `coverage`, so a never-imported file would
  // pass the gate unseen.
  defineConfig({
    test: {
      name: 'shared',
      environment: 'node',
      // Appended to the root setup list, not replacing it.
      setupFiles: ['./src/testing/property-tests.setup.ts'],
      exclude: ['**/dist/**', '**/node_modules/**'],
      coverage: {
        // Static inclusion over the runtime source tree: the v8 provider only
        // reports files some test imported, so without `include` a
        // never-imported file escapes the report entirely. With it, vitest
        // merges unimported matches in at 0% and the per-file gate catches
        // them. (Root-config excludes still apply after `include`: tests,
        // `**/index.ts` barrels, configs, `*.d.ts`.)
        include: ['src/**/*.ts'],
        exclude: [
          // Test infrastructure, exported for other packages' suites — not
          // product runtime. The base config already drops barrels, test/spec
          // files, and configs; these are the remaining in-repo test helpers.
          'src/__tests__/**',
          'src/testing/test-utilities.ts',
          'src/testing/test-polyfills.ts',
          'src/testing/test-ids.ts',
          'src/testing/test-signals.ts',
        ],
        thresholds: {
          ...COVERAGE_GATE,
        },
      },
    },
  })
);
