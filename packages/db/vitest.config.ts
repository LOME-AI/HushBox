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
  // defineConfig (not defineProject) because the coverage carve-out below is
  // a root-level key; the standalone `vitest run --coverage` invocation reads it.
  defineConfig({
    test: {
      name: 'db',
      environment: 'node',
      // The root excludes already cover dist, node_modules, and
      // *.workers.test.ts (the workers files run under workerd via
      // vitest.workers.config.ts / pnpm test:workers; they import
      // cloudflare:workers and cannot load here).
      coverage: {
        // Static inclusion over the real runtime source globs: the v8 provider
        // only reports files some test imported, so without `include` a
        // never-imported source file passes the gate silently. With it, vitest
        // merges unimported matches into the report at 0% and the per-file
        // thresholds below catch them. (Root-config excludes still apply after
        // `include`: tests, `**/index.ts` barrels, `**/__tests__/**`, *.d.ts.)
        include: [
          'src/schema/**/*.ts',
          'src/client.ts',
          'src/evidence.ts',
          'src/local-host-url.ts',
          'src/migration-rehearsal.ts',
          'src/schema-drift.ts',
          'src/test-db.ts',
          'src/workers-validation/txn-executor.ts',
          'src/workers-validation/settlement-executor.ts',
        ],
        exclude: [
          // Fishery test-data builders are test infrastructure, not product
          // source — exercised by the suites they seed, never gated themselves.
          'src/factories/**',
          // Environment resolution and a live connection wrapped around
          // `schema-drift.ts`, which the gate above measures; the wiring itself
          // is proven by running the migration step, not by a unit test.
          'src/verify-schema-drift.ts',
          // The DO worker entry imports `cloudflare:workers` and cannot load in
          // this node-environment project; the finalize logic it delegates to
          // lives in the covered `txn-executor.ts` neighbor (included above).
          'src/workers-validation/test-worker.ts',
        ],
        thresholds: {
          'src/schema/**/*.ts': COVERAGE_GATE,
          'src/client.ts': COVERAGE_GATE,
          'src/evidence.ts': COVERAGE_GATE,
          'src/local-host-url.ts': COVERAGE_GATE,
          'src/migration-rehearsal.ts': COVERAGE_GATE,
          'src/schema-drift.ts': COVERAGE_GATE,
          'src/test-db.ts': COVERAGE_GATE,
          'src/workers-validation/txn-executor.ts': COVERAGE_GATE,
          'src/workers-validation/settlement-executor.ts': COVERAGE_GATE,
        },
      },
    },
  })
);
