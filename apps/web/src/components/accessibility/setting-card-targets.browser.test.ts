import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import {
  chromium,
  firefox,
  type Browser,
  type BrowserContextOptions,
  type Page,
} from '@playwright/test';

import { startFixtureServer, type FixtureServer } from '@/test-utils/fixture-server';

/**
 * Measures the accessibility setting card's arrow targets where a pointer actually lands,
 * in real engines: a round hit area drawn outside the layout is invisible to every
 * DOM this package's other tests run in, which report no geometry at all.
 *
 * `@vitest/browser` is not installed. This follows the repo's established pattern for
 * driving real Playwright from ordinary Vitest: a fixture server started through
 * `startFixtureServer` (`src/test-utils/fixture-server.ts`) plus `@playwright/test` launched
 * directly. It lives in this app rather than beside the card because the card's package
 * compiles no Tailwind of its own, and the classes under test only exist once an app
 * compiles them.
 *
 * Chromium and Firefox only: CI installs those two. Touch is emulated in Chromium alone,
 * the one engine whose Playwright touch emulation turns `(pointer: coarse)` on.
 */

const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'setting-card-targets-fixture'
);

type EngineName = 'chromium' | 'firefox';
const ENGINES: readonly EngineName[] = ['chromium', 'firefox'];

const ARROWS = ['setting-card-prev', 'setting-card-next'] as const;

/** The fine-pointer target, 2rem. */
const FINE_TARGET_REM = 2;
/** The touch target, 2.75rem. */
const TOUCH_TARGET_REM = 2.75;

/**
 * The two root sizes the app renders at: 16px below its 768px band, where the targets are
 * 32px and 44px, and 17px from it, where the same rems resolve to 34px and 46.75px.
 */
const VIEWPORTS = [
  { name: 'phone', rootPx: 16, viewport: { width: 390, height: 844 } },
  { name: 'desktop', rootPx: 17, viewport: { width: 1024, height: 768 } },
] as const;

type Band = (typeof VIEWPORTS)[number];

function fine(band: Band): BrowserContextOptions {
  return { viewport: band.viewport };
}

function touch(band: Band): BrowserContextOptions {
  return { viewport: band.viewport, hasTouch: true, isMobile: true };
}

/** The first load compiles the app's whole stylesheet, which a busy machine can make slow. */
const FIXTURE_LOAD_MS = 90_000;
const TEST_MS = FIXTURE_LOAD_MS + 30_000;

const ENGINE_BANDS = ENGINES.flatMap((engine) =>
  VIEWPORTS.map((band) => ({ engine, name: band.name, band }))
);

interface Extent {
  width: number;
  height: number;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Everything one fixture load yields, read in a single round trip. */
interface Reading {
  coarse: boolean;
  rootPx: number;
  extents: Extent[];
  shipped: Box[];
  reference: Box[];
}

/**
 * Loads the fixture once under the given context and reads every figure the tests assert.
 * Page loads, not the probing, are what cost time on a loaded machine, so each context
 * is loaded once and its reading shared across the tests that assert on it.
 */
async function readFixture(
  browser: Browser,
  origin: string,
  options: BrowserContextOptions
): Promise<Reading> {
  const context = await browser.newContext(options);
  try {
    const page: Page = await context.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') pageErrors.push(message.text());
    });
    await page.goto(`${origin}/setting-card-targets.html`);
    await page
      .waitForFunction(() => globalThis.__targets !== undefined, undefined, {
        timeout: FIXTURE_LOAD_MS,
      })
      .catch((error: unknown) => {
        throw new Error(`the fixture never mounted; page errors: ${pageErrors.join(' | ')}`, {
          cause: error,
        });
      });
    return await page.evaluate((arrows) => {
      if (__targets === undefined) throw new Error('__targets not ready');
      const targets = __targets;
      return {
        coarse: targets.pointerIsCoarse(),
        rootPx: targets.rootPx(),
        extents: arrows.map((arrow) => targets.hitExtent(arrow)),
        shipped: targets.restBoxes('shipped'),
        reference: targets.restBoxes('reference'),
      };
    }, ARROWS);
  } finally {
    await context.close();
  }
}

function expectSquareTarget(extent: Extent | undefined, size: number): void {
  expect(extent?.width).toBeGreaterThanOrEqual(size - 1);
  expect(extent?.width).toBeLessThanOrEqual(size + 1);
  expect(extent?.height).toBeGreaterThanOrEqual(size - 1);
  expect(extent?.height).toBeLessThanOrEqual(size + 1);
}

describe('setting card arrow targets (real browser)', () => {
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
  }, 120_000);

  afterAll(async () => {
    await Promise.all(Object.values(browsers).map((browser) => browser.close()));
    await server.close();
  });

  function requireBrowser(engine: EngineName): Browser {
    const browser = browsers[engine];
    if (browser === undefined) throw new Error(`${engine} did not launch`);
    return browser;
  }

  const readings = new Map<string, Promise<Reading>>();

  function readingFor(engine: EngineName, band: Band, pointer: 'fine' | 'touch'): Promise<Reading> {
    const key = `${engine}/${band.name}/${pointer}`;
    let reading = readings.get(key);
    if (reading === undefined) {
      reading = readFixture(
        requireBrowser(engine),
        server.url,
        pointer === 'fine' ? fine(band) : touch(band)
      );
      readings.set(key, reading);
    }
    return reading;
  }

  it.each(ENGINE_BANDS)(
    'gives each arrow a 2rem square target under a fine pointer, on $engine at the $name root',
    async ({ engine, band }) => {
      const reading = await readingFor(engine, band, 'fine');
      expect(reading.coarse).toBe(false);
      expect(reading.rootPx).toBe(band.rootPx);
      expect(reading.extents).toHaveLength(ARROWS.length);
      for (const extent of reading.extents) {
        expectSquareTarget(extent, FINE_TARGET_REM * band.rootPx);
      }
    },
    TEST_MS
  );

  it.each(VIEWPORTS)(
    'gives each arrow a 2.75rem square target under touch emulation, at the $name root',
    async (band) => {
      const reading = await readingFor('chromium', band, 'touch');
      expect(reading.coarse).toBe(true);
      expect(reading.rootPx).toBe(band.rootPx);
      expect(reading.extents).toHaveLength(ARROWS.length);
      for (const extent of reading.extents) {
        expectSquareTarget(extent, TOUCH_TARGET_REM * band.rootPx);
      }
    },
    TEST_MS
  );

  it.each(ENGINE_BANDS)(
    'keeps every chevron and dot where the resting card drew it, on $engine at the $name root',
    async ({ engine, band }) => {
      const reading = await readingFor(engine, band, 'fine');
      expect(reading.reference).toHaveLength(5);
      expect(reading.shipped).toEqual(reading.reference);
    },
    TEST_MS
  );

  it.each(VIEWPORTS)(
    'keeps every chevron and dot where the resting card drew it under touch emulation, at the $name root',
    async (band) => {
      const reading = await readingFor('chromium', band, 'touch');
      expect(reading.reference).toHaveLength(5);
      expect(reading.shipped).toEqual(reading.reference);
    },
    TEST_MS
  );
});
