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

// Real-browser tests: each drives a spawned Playwright browser from Node, so it runs in
// the `web-browser` project's Node realm. A DOM emulator installed there sends real
// requests to its own origin for code the test process loads. Named by both the
// `web-browser` include and the `web` exclude, so each file runs in exactly one project.
const REAL_BROWSER_TEST_FILES = ['src/**/*.browser.test.{ts,tsx}'];

// defineConfig (not defineProject) so the `coverage` keys below are honored:
// `vitest run --coverage` reads root-level `test.coverage`, which defineProject
// strips. Env/alias/setup from the previous defineProject shape are preserved.
export default mergeConfig(
  rootConfig,
  defineConfig({
    plugins: [react()],
    test: {
      globals: true,
      coverage: {
        // Package level, outside `projects`: coverage is root-only in vitest 4, and
        // both projects below have this package as their root, so the one scope
        // measures every file either of them reaches.
        //
        // Static inclusion over the real product-source globs. The v8 provider
        // only reports files a test imported, so without `include` a
        // never-imported file passes the gate silently. With it, vitest merges
        // unimported matches into the report at 0%, where the shared config's
        // per-file gate fails them. (Root-config excludes still apply: tests,
        // `**/index.ts` barrels, `*.config.*`, `*.d.ts`, mocks, fixtures.)
        include: ['src/**/*.ts', 'src/**/*.tsx'],
        exclude: [
          // Generated router tree — not authored code.
          '**/*.gen.ts',
          // Test-only scaffolding: helpers imported solely by tests.
          'src/test-utils/**',
          // Real-browser test fixtures: served over HTTP to a spawned Playwright
          // browser by their sibling `*.browser.test.ts`, never imported by the
          // Node test process, so V8 coverage instrumentation structurally cannot
          // observe them executing.
          'src/**/*-fixture/**',
        ],
        thresholds: {
          ...COVERAGE_GATE,
        },
      },
      // Both projects extend this file's resolved root config, so every option it
      // settles — plugins, aliases, globals, the shared setup file — applies to each.
      projects: [
        {
          extends: true,
          test: {
            name: 'web',
            environment: BROWSER_TEST_ENVIRONMENT,
            // DOM-only: its polyfills patch `Element.prototype`, which a Node realm lacks.
            setupFiles: ['./src/test.setup.ts'],
            exclude: REAL_BROWSER_TEST_FILES,
          },
        },
        {
          extends: true,
          test: {
            name: 'web-browser',
            environment: 'node',
            include: REAL_BROWSER_TEST_FILES,
          },
        },
      ],
    },
    resolve: {
      alias: {
        '@': resolve(import.meta.dirname, './src'),
      },
    },
  })
);
