import { defineConfig, mergeConfig } from 'vitest/config';
import rootConfig from '@hushbox/config/vitest';

// This file runs in its own `crypto-noopt` project with the SSR dep optimizer
// disabled. It uses `vi.importActual('otplib')` on an external ESM dep; the
// optimizer rewrites that import through a malformed `&v=` cache URL that fails
// to resolve, so it fails even on a fresh cache. The optimizer stays on for
// every other crypto test. Referenced by both the `crypto-noopt` include and
// the `crypto` exclude so the path lives once and the file executes exactly once.
const OPTIMIZER_OFF_FILES = ['src/totp.test.ts'];

export default mergeConfig(
  rootConfig,
  defineConfig({
    test: {
      // Appended to the root setup list, not replacing it. Both projects below
      // extend this block, so the pinned seed and case count reach each.
      setupFiles: ['@hushbox/shared/property-tests.setup'],
      coverage: {
        // Static inclusion over the runtime source tree: the v8 provider only
        // reports files a test imported, so without `include` a never-imported
        // file escapes the report entirely. With it, vitest merges unimported
        // matches in at 0% and the per-file gate catches them. (Root-config
        // excludes still apply: tests, `**/index.ts` barrels, configs.)
        //
        // Package level, outside `projects`: coverage is root-only in vitest 4,
        // and both projects below have this package as their root, so the one
        // scope measures every file either of them reaches.
        include: ['src/**/*.ts'],
      },
      // Both projects extend this file's resolved root config (rootConfig
      // merged with the test options here), so every option it settles —
      // timeouts, setup files, the exclude list — applies to each.
      projects: [
        {
          extends: true,
          test: {
            name: 'crypto',
            environment: 'node',
            testTimeout: 30_000,
            // OPTIMIZER_OFF_FILES run under `crypto-noopt` — exclude them here
            // so they don't double-run.
            exclude: ['**/dist/**', '**/node_modules/**', ...OPTIMIZER_OFF_FILES],
          },
        },
        {
          // See OPTIMIZER_OFF_FILES above: this runs with the SSR dep optimizer
          // disabled so its `vi.importActual` of an external ESM dep resolves
          // normally instead of through the optimizer's malformed cache URL.
          extends: true,
          test: {
            name: 'crypto-noopt',
            environment: 'node',
            testTimeout: 30_000,
            include: OPTIMIZER_OFF_FILES,
            deps: { optimizer: { ssr: { enabled: false } } },
          },
        },
      ],
    },
  })
);
