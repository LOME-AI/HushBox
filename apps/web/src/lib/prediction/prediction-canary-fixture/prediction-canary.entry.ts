import { isPredictionWorkerOutbound } from '../prediction-worker-protocol';
import type { PredictionWorkerInbound } from '../prediction-worker-protocol';

/**
 * Real-browser fixture for `prediction-canary.browser.test.ts`. It spawns the
 * shipped prediction worker exactly as `prediction-session.ts` does — same
 * module, same module-worker type, no double anywhere — and reports the one
 * thing an init settles to into the DOM, where the driving test reads it.
 *
 * The page's own origin is handed over as the API origin: the server this page
 * is served from also serves the model objects, at the addresses the shared
 * artifact contract builds, so the worker needs nothing test-aware.
 *
 * Test infrastructure, not shipped runtime, and not exempted from lint — it is
 * served to a real browser and never imported by the Node test process, so V8
 * coverage instrumentation cannot observe it executing; `apps/web/vitest.config.ts`
 * excludes `src/**\/*-fixture/**` from the coverage gate for exactly that reason.
 */

const outcome = document.querySelector('#outcome');
if (outcome === null) throw new Error('the prediction canary fixture page has no outcome element');
const report = outcome;

const worker = new Worker(new URL('../prediction.worker.ts', import.meta.url), { type: 'module' });

// An init settles as `ready` or `failed` and nothing else, and the reason a
// `failed` carries is the only account the worker ever gives of itself — a
// canary mismatch names both token sequences there.
worker.addEventListener('message', (event: MessageEvent) => {
  const message: unknown = event.data;
  if (!isPredictionWorkerOutbound(message)) return;
  if (message.type === 'ready') report.textContent = 'ready';
  else if (message.type === 'failed') report.textContent = `failed: ${message.reason}`;
});

const init: PredictionWorkerInbound = {
  type: 'init',
  requestId: 'canary',
  apiOrigin: globalThis.location.origin,
};
worker.postMessage(init);
