import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, devices, type Browser } from '@playwright/test';

import { startFixtureServer, type FixtureServer } from '@/test-utils/fixture-server';

/**
 * Taps the prediction hint on a touch phone. A tap is a pointer press followed, after the
 * release, by a click the browser hit-tests afresh: accepting the hint on the press re-lays
 * the page out, so that click can land on whatever control has moved under the finger. Only a
 * real engine generates that click, which is why this runs in one.
 *
 * `@vitest/browser` is not installed; this follows the repo's pattern for driving real
 * Playwright from ordinary Vitest: a dev server over a fixture directory plus `@playwright/test`
 * launched directly.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, 'prediction-overlay-fixture');
const SRC_DIR = path.resolve(HERE, '../../..');

/** One budget for the fixture's load; the first load compiles the app's whole stylesheet. */
const FIXTURE_LOAD_MS = 90_000;
/** Above the load budget, so a load that runs out reports its own diagnostic. */
const TEST_MS = FIXTURE_LOAD_MS + 30_000;

const HINT = '[data-slot="prediction-text"]';
const ACCEPTED = 'the quick brown fox jumps over the lazy dog.';

type TapReading = ReturnType<NonNullable<typeof globalThis.__predictionOverlayTap>['read']>;

describe('prediction hint tapped on a touch phone (real browser)', () => {
  let server: FixtureServer;
  let browser: Browser;
  let reading: TapReading;

  beforeAll(async () => {
    server = await startFixtureServer({
      root: FIXTURE_DIR,
      plugins: [react(), tailwindcss()],
      resolve: { alias: [{ find: /^@\/(.*)$/, replacement: path.join(SRC_DIR, '$1') }] },
    });
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const context = await browser.newContext(devices['Pixel 7']);
    const page = await context.newPage();
    await page.goto(`${server.url}/prediction-overlay-tap.html`, {
      waitUntil: 'commit',
      timeout: FIXTURE_LOAD_MS,
    });
    await page.locator(HINT).waitFor({ timeout: FIXTURE_LOAD_MS });
    await page.focus('#prompt-input');
    await page.locator(HINT).tap();
    // The click a tap generates follows the release in a later task. Its handlers finish within
    // the same dispatch that records it, so once it is recorded the reading holds what it did.
    await page.waitForFunction(
      () => (globalThis.__predictionOverlayTap?.read().clickTargets.length ?? 0) > 0,
      undefined,
      { timeout: FIXTURE_LOAD_MS }
    );
    reading = await page.evaluate(() => {
      if (globalThis.__predictionOverlayTap === undefined) throw new Error('fixture not ready');
      return globalThis.__predictionOverlayTap.read();
    });
    await context.close();
  }, TEST_MS);

  afterAll(async () => {
    await browser.close();
    await server.close();
  });

  it('runs at the width the phone failure was seen at', () => {
    expect(devices['Pixel 7'].viewport.width).toBe(412);
  });

  it('dispatches the follow-up click onto the model chip that rose under the finger', () => {
    // The precondition the other cases rest on: without it they would pass vacuously.
    expect(reading.clickTargets).toEqual(['model-chip']);
  });

  it('takes the hint into the composer', () => {
    expect(reading.value).toBe(ACCEPTED);
  });

  it('opens nothing from the click that followed the tap', () => {
    expect(reading.modelSelectorOpen).toBe(false);
  });

  it('leaves the composer focused', () => {
    expect(reading.focusedId).toBe('prompt-input');
  });
});
