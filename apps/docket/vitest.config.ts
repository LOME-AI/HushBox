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

// Mirrors apps/admin/vitest.config.ts: defineConfig (not defineProject) so the
// `coverage` keys are honored, static `include` under the shared config's
// per-file gate so a never-imported source file fails the gate instead of
// escaping the report.
export default mergeConfig(
  rootConfig,
  defineConfig({
    plugins: [react()],
    test: {
      name: 'docket-console',
      environment: BROWSER_TEST_ENVIRONMENT,
      globals: true,
      setupFiles: ['./src/test.setup.ts'],
      coverage: {
        include: ['src/**/*.ts', 'src/**/*.tsx'],
        exclude: [
          // Test-only scaffolding: helpers imported solely by tests.
          'src/test-utils/**',
        ],
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
