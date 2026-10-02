import { defineConfig, mergeConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import rootConfig, { BROWSER_TEST_ENVIRONMENT } from '@hushbox/config/vitest';

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
    plugins: [react()],
    test: {
      name: 'ui',
      environment: BROWSER_TEST_ENVIRONMENT,
      globals: true,
      setupFiles: ['./src/test.setup.ts'],
      coverage: {
        // Static inclusion over the source globs: the v8 provider only reports
        // files some test imported, so without `include` a never-imported
        // source file passes the gate silently. With it, vitest merges
        // unimported matches into the report at 0% and the shared config's
        // per-file thresholds fail on them. (Root-config excludes still apply
        // after `include`: tests, `**/index.ts` barrels, `*.d.ts`, configs.)
        include: ['src/**/*.{ts,tsx}'],
        thresholds: {
          ...COVERAGE_GATE,
        },
      },
    },
    resolve: {
      alias: {
        '@': resolve(import.meta.dirname, './src'),
      },
    },
  })
);
