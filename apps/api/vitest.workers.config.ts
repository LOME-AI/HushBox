import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

import { HOOK_TIMEOUT_MS } from '@hushbox/config/vitest';

// A second project that exists only to pin runtime behavior the node-environment
// project cannot observe: node ships full-ICU, workerd does not, so anything the
// Worker relies on from the platform's own Intl/locale data has to be asserted
// inside workerd or it is not asserted at all. Carries no coverage — every
// module it touches is covered by the node project.
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
//
// This project declares no lane count at all, so it opens the runner's own
// default. That silence is what the entry for this file in
// `scripts/lib/pool/concurrency-report.ts` records, so a count declared here
// falsifies it and has to be carried there instead.
//
// The compatibility date and flags mirror wrangler.toml so a production runtime
// change shows up here as a failure rather than in delivered notifications.
/**
 * The `test:workers` script names this file on vitest's `--config`, so no
 * module imports it.
 * @toolContract
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: '2026-03-01',
        compatibilityFlags: ['nodejs_compat', 'web_socket_auto_reply_to_close'],
        serviceBindings: {
          // A responder on the far side of a real service boundary. It exists
          // so a test can obtain a `fetch`-derived response, whose headers
          // workerd marks immutable — the shape a Durable Object's answer to
          // an upgrade proxy has, and the one no in-process `new Response()`
          // can reproduce. The status is the DO-refusal case: a room declining
          // an upgrade rather than switching protocols.
          CROSS_BOUNDARY_RESPONDER: (): Response =>
            new Response('refused', { status: 403, headers: { 'content-type': 'text/plain' } }),
        },
      },
    }),
  ],
  test: {
    name: 'api-workers',
    include: ['src/**/*.workers.test.ts'],
    hookTimeout: HOOK_TIMEOUT_MS,
  },
});
