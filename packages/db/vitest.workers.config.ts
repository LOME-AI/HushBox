import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

import { HOOK_TIMEOUT_MS } from '@hushbox/config/vitest';

// Per the redesign's test-placement rules this project exists only for
// platform behavior (here: the DO-finalize validation), runs single-worker
// without isolation, and carries no coverage — all logic lives in plain
// modules covered by the node-environment project.
//
// Deliberately not merged with the shared vitest config: its setupFiles run
// node-only code (the per-worker database provisioning) that cannot execute
// under workerd. The hook budget is the one thing taken from it, imported so
// this project runs on the measured number rather than on a second spelling of
// it or on the runner's default.
//
// It files no run row of its own, and that is not a hole in the memory ladder
// those rows feed: a command that samples a run roots the sampled tree at its
// own process and launches this suite inside that tree, as a sibling of the
// vitest runner rather than one of its workers, so the partition in
// `scripts/lib/pool/memory.ts` charges it to the run's fixed cost and its
// memory is already inside the peak that run files. What sits inside nobody's
// peak is this suite run on its own, with no sampling command around it.

// DATABASE_URL is the local neon-proxy in every mode but production — what the
// environment registry resolves it to — so that is the engine this project's
// assertions run against, in CI as locally. Targeting the managed provider
// instead, to cover its pooling and proxy layer, is permanently out of scope,
// not pending: the reason and its re-entry condition are in `docs/DECISIONS.md`.
//
// The binding is read at config load, in the main process, so the vitest setup
// file's per-worker rewrite can never reach it and `VITEST_POOL_ID` does not
// exist yet. `scripts/run-workers-tests.ts` therefore gives this phase one
// run-scoped database and retargets DATABASE_URL before vitest starts; it runs
// serially with parallelism off, so one database covers every file in it.
const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) {
  throw new Error('vitest.workers.config: DATABASE_URL is required (run via scripts/with-env.ts)');
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './src/workers-validation/test-worker.ts',
      miniflare: {
        compatibilityDate: '2026-03-01',
        compatibilityFlags: ['nodejs_compat'],
        durableObjects: { DB_TXN_RUNNER: 'DbTxnRunnerDO' },
        bindings: { DATABASE_URL: databaseUrl },
      },
    }),
  ],
  test: {
    name: 'db-workers',
    include: ['src/workers-validation/**/*.workers.test.ts'],
    testTimeout: 15000,
    hookTimeout: HOOK_TIMEOUT_MS,
    isolate: false,
    fileParallelism: false,
  },
});
