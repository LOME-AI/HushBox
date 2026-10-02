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
      name: 'docket',
      environment: 'node',
      exclude: ['**/dist/**', '**/node_modules/**'],
      coverage: {
        // Static inclusion over the runtime source tree: the v8 provider only
        // reports files some test imported, so without `include` a
        // never-imported file escapes the report entirely. With it, vitest
        // merges unimported matches in at 0% and the per-file gate catches
        // them. (Root-config excludes still apply after `include`: tests,
        // `**/index.ts` barrels, configs, `*.d.ts`.)
        include: ['src/**/*.ts'],
        thresholds: {
          ...COVERAGE_GATE,
        },
      },
    },
  })
);
