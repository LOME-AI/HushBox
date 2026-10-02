import { defineConfig, mergeConfig, type ViteUserConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import rootConfig, { BROWSER_TEST_ENVIRONMENT } from '@hushbox/config/vitest';

const COVERAGE_GATE = {
  lines: 95,
  branches: 95,
  functions: 95,
  statements: 95,
};

const merged: ViteUserConfig = mergeConfig(
  rootConfig,
  defineConfig({
    plugins: [react()],
    test: {
      name: 'crawler-view',
      environment: BROWSER_TEST_ENVIRONMENT,
      globals: true,
      setupFiles: ['./src/test.setup.ts'],
      coverage: {
        include: ['src/**/*.{ts,tsx}'],
        exclude: ['**/__fixtures__/**'],
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

export default merged;
