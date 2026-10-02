import path from 'node:path';
import { createReadStream, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { defaultClientConditions, type Plugin } from 'vite';
import { chromium, type Browser } from '@playwright/test';

import { MODEL_WEIGHTS_VERSION, modelWeightsRoutePath } from '@hushbox/shared/model-weights';
import { startFixtureServer, type FixtureServer } from '@/test-utils/fixture-server';

import {
  ORT_EXTERN_WASM_CONDITION,
  PREDICTION_WORKER_SCAN_ENTRY,
  ortAssetsPlugin,
} from '../../../../../scripts/lib/bundling/seam';
import {
  MODEL_WEIGHTS_CACHE_ROOT,
  artifactCachePath,
  predictionArtifacts,
} from '../../../../../scripts/lib/model-weights/manifest';
import { CANARY_EXPECTED_TOKENS } from './prediction.worker';

/**
 * Runs the prediction worker's load-time canary against the real ONNX Runtime
 * build and the real weights, in a real browser engine.
 *
 * Every other test of this worker drives it through doubles, which is what a
 * library contract cannot be checked against: the model class extends a
 * callable base whose constructor returns a function, so a guard written for a
 * plain object type-checks, lints, passes a full unit suite against an object
 * literal, and rejects every real model at load. The runtime half is the same
 * shape — a wasm SIMD miscompile returns wrong numbers rather than throwing —
 * and the feature is silent by design, so neither reaches a user as anything
 * but absent autocomplete. Only the real library, the real runtime and the real
 * weights separate those states, which is what this file is.
 *
 * `@vitest/browser` is not installed. This follows the repo's established
 * pattern for driving real Playwright from ordinary Vitest: a Vite server
 * rooted at a committed fixture directory, started through `startFixtureServer`
 * (`src/test-utils/fixture-server.ts`), plus `@playwright/test` launched
 * directly. Chromium alone: the pinned sequence is a claim about one ORT build,
 * and all engines run the same self-hosted binary single-threaded, so a second
 * engine measures the same thing twice.
 *
 * The worker is loaded exactly as the app loads it. The server is shaped to the
 * worker rather than the other way round: it serves the self-hosted runtime
 * under `ORT_WASM_PATH` and the model's objects under the route
 * `modelWeightsRoutePath` builds, so the page origin is a legitimate
 * `apiOrigin` and nothing in the worker is test-aware.
 */

const PREDICTION_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(PREDICTION_DIR, 'prediction-canary-fixture');

/** The app's own source root, which its `@/` alias addresses. */
const WEB_SRC = path.resolve(PREDICTION_DIR, '..', '..');

/** Downloading and loading ~136 MB of weights, then generating greedily on wasm. */
const CANARY_TIMEOUT_MS = 600_000;

/** Every object the worker fetches, addressed as the route serves it. */
const ARTIFACT_BY_ROUTE: ReadonlyMap<string, string> = new Map(
  predictionArtifacts().map((artifact) => [
    modelWeightsRoutePath(artifact.model, MODEL_WEIGHTS_VERSION, artifact.file),
    artifactCachePath(MODEL_WEIGHTS_CACHE_ROOT, artifact),
  ])
);

/**
 * The prediction objects the download cache does not hold. The weights are
 * gitignored and are not something `pnpm install` delivers, so a checkout that
 * has never seeded them reaches this rather than a 404 inside the browser,
 * where the feature's own silence would swallow it.
 */
function missingArtifacts(): string[] {
  return [...ARTIFACT_BY_ROUTE.values()].filter((filePath) => !existsSync(filePath));
}

/** Serves the cached model objects at the addresses the worker asks for. */
function modelWeightsPlugin(): Plugin {
  return {
    name: 'model-weights',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const filePath = ARTIFACT_BY_ROUTE.get((req.url ?? '').split('?')[0] ?? '');
        if (filePath === undefined) {
          next();
          return;
        }
        res.setHeader(
          'Content-Type',
          filePath.endsWith('.json') ? 'application/json' : 'application/octet-stream'
        );
        createReadStream(filePath).pipe(res);
      });
    },
  };
}

/** The fixture server, shaped to serve the worker exactly as the app does. */
function startCanaryServer(): Promise<FixtureServer> {
  return startFixtureServer({
    root: FIXTURE_DIR,
    plugins: [ortAssetsPlugin(), modelWeightsPlugin()],
    resolve: {
      // The worker's own graph reaches app modules through the `@/` alias, so a
      // server that serves the worker defines it exactly as the app's config
      // does; without it the worker fails to resolve and never loads.
      alias: { '@': WEB_SRC },
      // The app's own resolution, because the variant it selects is the one
      // whose wasm is self-hosted rather than emitted beside the bundle; the
      // spread is load-bearing, since `conditions` replaces Vite's defaults.
      conditions: [ORT_EXTERN_WASM_CONDITION, ...defaultClientConditions],
    },
    optimizeDeps: {
      // The scanner does not cross a `new Worker(new URL(…))` edge, so without
      // the worker named here the inference library is discovered on the first
      // worker fetch and the prebundle changes under the page mid-load.
      entries: ['**/*.html', PREDICTION_WORKER_SCAN_ENTRY],
    },
  });
}

/** What the fixture page reports: `ready`, or `failed: <the worker's reason>`. */
async function readOutcome(browser: Browser, origin: string): Promise<string> {
  const page = await browser.newPage();
  try {
    await page.goto(`${origin}/prediction-canary.html`);
    await page.waitForFunction(
      () => (document.querySelector('#outcome')?.textContent ?? '') !== '',
      undefined,
      { timeout: CANARY_TIMEOUT_MS }
    );
    return await page.evaluate(() => document.querySelector('#outcome')?.textContent ?? '');
  } finally {
    await page.close();
  }
}

/**
 * The token sequence this runtime produced, spelled as the worker spells it.
 * The worker posts the tokens it saw only when they differ from the pin — a
 * match is reported as `ready` and nothing else — so its mismatch message is
 * the one channel the produced sequence travels on, and this reads it back out
 * of that message. Coupled to the text that canary throws; a reason in any
 * other shape is returned whole, so an unrelated failure is reported rather
 * than read as a token list.
 */
const MISMATCH = /^failed: canary token mismatch: produced \[([^\]]*)\]/u;
function producedSequence(outcome: string): string {
  if (outcome === 'ready') return CANARY_EXPECTED_TOKENS.join(', ');
  return MISMATCH.exec(outcome)?.[1] ?? outcome;
}

describe('the prediction canary against the real runtime', () => {
  let server: FixtureServer | undefined;
  let browser: Browser | undefined;
  let outcome: string;

  beforeAll(async () => {
    const missing = missingArtifacts();
    if (missing.length > 0) {
      throw new Error(
        `the prediction model is not in the download cache (${String(missing.length)} objects ` +
          `missing, including ${path.basename(missing[0] ?? '')}), so there is no runtime to ` +
          `check. Run \`pnpm weights:seed\` and run this again.`
      );
    }
    server = await startCanaryServer();
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    outcome = await readOutcome(browser, server.url);
  }, CANARY_TIMEOUT_MS);

  afterAll(async () => {
    // The missing-weights throw in `beforeAll` leaves both unassigned, and that
    // path exists to print one actionable message a teardown crash would hide.
    await browser?.close();
    await server?.close();
  });

  it('loads the model through the real library and reports a live session', () => {
    expect(outcome).toBe('ready');
  });

  it('generates the pinned token sequence, which only this ONNX Runtime build produces', () => {
    expect(producedSequence(outcome)).toBe(CANARY_EXPECTED_TOKENS.join(', '));
  });
});
