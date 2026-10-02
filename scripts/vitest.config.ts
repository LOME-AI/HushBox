import { defineConfig, mergeConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import rootConfig from '@hushbox/config/vitest';

const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url));

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
      name: 'scripts',
      environment: 'node',
      exclude: ['**/dist/**', '**/node_modules/**'],
      // Appended to the shared config's list rather than replacing it. Every
      // suite that registers a run of its own has to start from no claim, so
      // this package is where the variable gets cleared and where a hook can
      // leave it cleared; the module states what that costs and why the
      // runner's own environment restoration does not cover it.
      setupFiles: [path.join(PACKAGE_ROOT, 'lib/vitest/run-claim-restored.setup.ts')],
      coverage: {
        // Static inclusion over the real script source: the v8 provider only
        // reports files some test imported, so without `include` a
        // never-imported script passes the gate silently. With it, vitest
        // merges unimported matches into the report at 0% and the per-file
        // thresholds below fail on them. (Root-config excludes — tests,
        // *.config.*, *.d.ts, index.ts — still apply.)
        include: [
          '*.ts',
          'lib/**/*.ts',
          'readme/**/*.ts',
          'linear/**/*.ts',
          'skills/**/*.ts',
          'cards/**/*.ts',
          'records/**/*.ts',
          'release/**/*.ts',
          'publication/**/*.ts',
        ],
        exclude: [
          // Vitest-run infrastructure: these execute inside the very vitest
          // host and forks doing the measuring (the coverage provider and its
          // merge threads, the file sequencer), so a coverage run cannot
          // observe them the way it observes product code; their behaviour is
          // pinned against the stock provider by the test-batch fixtures.
          'lib/vitest/coverage-provider.ts',
          'lib/vitest/coverage-provider-host.ts',
          'lib/vitest/coverage-merge-worker.ts',
          'lib/vitest/lpt-sequencer.ts',
        ],
        thresholds: {
          '*.ts': COVERAGE_GATE,
          'lib/**/*.ts': COVERAGE_GATE,
          'readme/**/*.ts': COVERAGE_GATE,
          'linear/**/*.ts': COVERAGE_GATE,
          'skills/**/*.ts': COVERAGE_GATE,
          'cards/**/*.ts': COVERAGE_GATE,
          'records/**/*.ts': COVERAGE_GATE,
          'release/**/*.ts': COVERAGE_GATE,
          'publication/**/*.ts': COVERAGE_GATE,
        },
      },
    },
  })
);
