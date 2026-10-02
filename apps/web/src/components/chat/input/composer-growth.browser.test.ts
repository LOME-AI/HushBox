import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, firefox, type Browser, type Page } from '@playwright/test';

import { startFixtureServer, type FixtureServer } from '@/test-utils/fixture-server';

/**
 * Drives the real composer `Textarea` (packages/ui/src/components/primitives/textarea.tsx)
 * in a real browser and asserts it grows. The grid-replica sizing mechanism
 * that primitive uses exists specifically because `field-sizing: content` (its
 * predecessor) has never worked on Firefox; this test is the one place that
 * claim is checked against a real Firefox engine rather than assumed.
 *
 * `@vitest/browser` is not installed. This follows the repo's established
 * pattern for driving real Playwright from ordinary Vitest (apps/sandbox's
 * `embed-harness.ts` / `browser-harness.ts`): a plain dev server plus
 * `@playwright/test`, launched here directly rather than through the ordinary
 * Playwright `playwright.config.ts` runner apps/web has none of.
 *
 * The fixture (`composer-growth-fixture/`) renders two elements: the shipped
 * composer's exact `Textarea` configuration, and a hand-built reconstruction of
 * the sizing mechanism it replaced (a raw textarea with Tailwind's
 * `field-sizing-content` utility, no grid wrapper, no replica). Both expose
 * their measured `clientHeight` through the global `__growth`.
 *
 * The directory is deliberately not named `__test-fixtures-*__` — that pattern
 * is reserved (`.gitignore`) for vitest-generated, per-test-run scratch content
 * cleaned up in `afterEach`, and is gitignored repo-wide outside two allowlisted
 * exceptions neither of which is this. This fixture is hand-written, committed
 * source that must persist, so it stays lint-visible like `apps/sandbox`'s
 * harness files rather than exempted like a scratch fixture; it is excluded
 * from coverage separately (`apps/web/vitest.config.ts`), since it runs only
 * inside a spawned browser process V8 coverage cannot instrument.
 */

const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'composer-growth-fixture'
);

// Progressively longer content, driven far past the composer's 7-line clamp
// (11.5rem) so every engine's growth curve is fully exercised: floor, mid-growth,
// and plateau.
const GROWTH_STEPS = [0, 2, 8, 16, 28, 42, 60, 90, 130].map((repeats) => 'lorem '.repeat(repeats));

type EngineName = 'chromium' | 'firefox';
const ENGINES: readonly EngineName[] = ['chromium', 'firefox'];

async function openFixturePage(browser: Browser, origin: string): Promise<Page> {
  const page = await browser.newPage();
  await page.goto(`${origin}/composer-growth.html`);
  await page.waitForFunction(() => __growth !== undefined);
  return page;
}

/** Drives one element's controlled value through {@link GROWTH_STEPS} and records `clientHeight` at each step, entirely in-page. */
async function measureGrowth(
  page: Page,
  setter: 'setShipped' | 'setLegacy',
  elementId: string
): Promise<number[]> {
  return page.evaluate(
    ({ setter, elementId, steps }) => {
      if (__growth === undefined) throw new Error('__growth not ready');
      const heights: number[] = [];
      for (const value of steps) {
        __growth[setter](value);
        heights.push(__growth.heightOf(elementId));
      }
      return heights;
    },
    { setter, elementId, steps: GROWTH_STEPS }
  );
}

/** Narrows a `measureGrowth` reading at `index`: every index below {@link GROWTH_STEPS}'s length is always populated. */
function requireHeight(heights: readonly number[], index: number): number {
  const value = heights[index];
  if (value === undefined) throw new Error(`missing height reading at index ${String(index)}`);
  return value;
}

async function computedMaxHeight(page: Page, elementId: string): Promise<number> {
  return page.evaluate((elementId) => {
    const el = document.querySelector(`#${elementId}`);
    if (el === null) throw new Error(`missing element ${elementId}`);
    return Number.parseFloat(getComputedStyle(el).maxHeight);
  }, elementId);
}

describe('composer growth (real browser)', () => {
  let server: FixtureServer;
  const browsers: Partial<Record<EngineName, Browser>> = {};

  beforeAll(async () => {
    server = await startFixtureServer({ root: FIXTURE_DIR, plugins: [react(), tailwindcss()] });
    const [chromiumBrowser, firefoxBrowser] = await Promise.all([
      chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] }),
      firefox.launch(),
    ]);
    browsers.chromium = chromiumBrowser;
    browsers.firefox = firefoxBrowser;
  }, 60_000);

  afterAll(async () => {
    await Promise.all(Object.values(browsers).map((browser) => browser.close()));
    await server.close();
  });

  function requireBrowser(engine: EngineName): Browser {
    const browser = browsers[engine];
    if (browser === undefined) throw new Error(`${engine} did not launch`);
    return browser;
  }

  it.each(ENGINES)(
    'shipped composer clientHeight strictly increases past two lines and clamps at max-height, on %s',
    async (engine) => {
      const page = await openFixturePage(requireBrowser(engine), server.url);
      try {
        const heights = await measureGrowth(page, 'setShipped', 'shipped-composer');
        const floor = requireHeight(heights, 0);

        // Non-decreasing at every step, and strictly greater than the floor
        // somewhere along the way: this is what "grows" means for a `clientHeight`
        // trace, and the only claim this test makes.
        for (let index = 1; index < heights.length; index += 1) {
          expect(requireHeight(heights, index)).toBeGreaterThanOrEqual(
            requireHeight(heights, index - 1)
          );
        }
        expect(heights.some((height) => height > floor)).toBe(true);

        // Stops increasing at the max-height clamp: the last two measured
        // steps sit at the element's own computed max-height, not merely below it.
        const maxHeightPx = await computedMaxHeight(page, 'shipped-composer');
        const [secondLast, last] = heights.slice(-2);
        expect(secondLast).toBeCloseTo(maxHeightPx, 0);
        expect(last).toBeCloseTo(maxHeightPx, 0);
        for (const height of heights) expect(height).toBeLessThanOrEqual(maxHeightPx + 1);
      } finally {
        await page.close();
      }
    },
    30_000
  );

  // The discrimination proof: the shipped primitive cannot be reverted to its
  // predecessor, so this reconstructs the configuration it replaced and shows
  // growth breaks on Firefox specifically — established by running the identical
  // `measureGrowth` trace against `#legacy-composer` instead of
  // `#shipped-composer`, on the same engine, in the same run.
  it('legacy field-sizing-content textarea does not grow on Firefox — the discrimination proof', async () => {
    const page = await openFixturePage(requireBrowser('firefox'), server.url);
    try {
      const heights = await measureGrowth(page, 'setLegacy', 'legacy-composer');
      const floor = requireHeight(heights, 0);
      expect(heights.every((height) => height === floor)).toBe(true);
    } finally {
      await page.close();
    }
  }, 30_000);

  // Control: the same legacy configuration DOES grow on Chromium (which
  // implements `field-sizing: content`), proving the Firefox result above is
  // Firefox's real lack of support and not a broken fixture.
  it('legacy field-sizing-content textarea grows on Chromium — control for the discrimination proof', async () => {
    const page = await openFixturePage(requireBrowser('chromium'), server.url);
    try {
      const heights = await measureGrowth(page, 'setLegacy', 'legacy-composer');
      const floor = requireHeight(heights, 0);
      expect(heights.some((height) => height > floor)).toBe(true);
    } finally {
      await page.close();
    }
  }, 30_000);
});
