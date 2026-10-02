import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

import { HOOK_TIMEOUT_MS } from '@hushbox/config/vitest';

// Per the redesign's test-placement rules this project exists only for
// platform behavior (hibernatable-WS round-trips, the deadline alarm,
// eviction through a real DO), runs single-worker without isolation, and
// carries no coverage — all logic lives in the plain modules the
// node-environment project covers.
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

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './src/workers-validation/test-worker.ts',
      miniflare: {
        compatibilityDate: '2026-03-01',
        compatibilityFlags: ['nodejs_compat'],
        durableObjects: {
          CONVERSATION_ROOM: 'TestConversationRoom',
          JOB_DISPATCHER: 'TestJobDispatcher',
        },
      },
    }),
  ],
  test: {
    name: 'realtime-workers',
    include: ['src/workers-validation/**/*.workers.test.ts'],
    testTimeout: 15000,
    hookTimeout: HOOK_TIMEOUT_MS,
    isolate: false,
    fileParallelism: false,
  },
});
