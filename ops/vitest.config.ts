import { defineConfig, mergeConfig } from 'vitest/config';
import rootConfig from '@hushbox/config/vitest';

const COVERAGE_GATE = {
  lines: 95,
  branches: 95,
  functions: 95,
  statements: 95,
};

// defineConfig (not defineProject): the coverage gate below is a root-level
// key, and a standalone `vitest run --coverage` invocation reads it.
export default mergeConfig(
  rootConfig,
  defineConfig({
    test: {
      name: 'ops',
      environment: 'node',
      exclude: ['**/dist/**', '**/node_modules/**'],
      coverage: {
        // Static inclusion over the real source: the v8 provider only reports
        // files some test imported, so without `include` a never-imported
        // module — the label-to-deploy-script mapping among them — passes the
        // gate silently. With it, vitest merges unimported matches into the
        // report at 0% and the thresholds below fail on them.
        // (Root-config excludes — tests, *.config.*, *.d.ts, index.ts — still
        // apply.) `include` is a hard filter, not additive, so it is the whole
        // package rather than today's directories: `ops/<domain>/<verb>.ts`
        // grows new domains, and an enumerated list would leave each new one
        // outside the report entirely.
        include: ['**/*.ts'],
        thresholds: {
          'identity/**/*.ts': COVERAGE_GATE,
          'lib/**/*.ts': COVERAGE_GATE,
          'r2/**/*.ts': COVERAGE_GATE,
        },
      },
    },
  })
);
