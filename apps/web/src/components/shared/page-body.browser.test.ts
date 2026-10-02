import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, firefox, type Browser, type Page } from '@playwright/test';

import { startFixtureServer, type FixtureServer } from '@/test-utils/fixture-server';

/**
 * Lays a page body out in a real engine, under the app's own stylesheet: whether its pinned band
 * sticks to the scroller's top or scrolls with the page, which turns on the band's laid-out height
 * against the scroller's. The DOM the unit tests run in lays nothing out.
 */

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'page-body-fixture');

/** The first load compiles the app's whole stylesheet, which a busy machine can make slow. */
const LOAD_MS = 90_000;
const TEST_MS = LOAD_MS * 2;
const CLOSE_MS = 45_000;
/** How long a text-size change on the live page may take to reach the band's position. */
const SETTLE_MS = 30_000;

/** The accessibility widget's largest text size. */
const LARGEST_TEXT = '141';
/** How far the tests scroll the page: less than the page's overflow in every case. */
const SCROLL_PX = 200;
/** Tab presses in a focus walk: past the cards that fit under a pinned band at every case. */
const TAB_PRESSES = 40;
/** Sub-pixel layout rounding the comparison forgives. */
const EDGE_TOLERANCE_PX = 0.5;

interface Viewport {
  width: number;
  height: number;
}

interface BandCase {
  label: string;
  viewport: Viewport;
  scale?: string;
  /** The band content's height, in rem, that gives the measured share at this size. */
  bandRem: number;
  /** The band's height over the scroller's that this case must reproduce. */
  share: { min: number; max: number };
  pinned: boolean;
}

/** The /accessibility page's measured band shares, reproduced in the fixture. */
const BAND_CASES: readonly BandCase[] = [
  {
    label: '768x900 at 100% text (55%)',
    viewport: { width: 768, height: 900 },
    bandRem: 25,
    share: { min: 0.53, max: 0.57 },
    pinned: true,
  },
  {
    label: '1440x900 at the largest text (about 68%)',
    viewport: { width: 1440, height: 900 },
    scale: LARGEST_TEXT,
    bandRem: 21,
    share: { min: 0.66, max: 0.7 },
    pinned: true,
  },
  {
    label: '834x1112 at the largest text (90%)',
    viewport: { width: 834, height: 1112 },
    scale: LARGEST_TEXT,
    bandRem: 36,
    share: { min: 0.88, max: 0.92 },
    pinned: false,
  },
  {
    label: '768x900 at the largest text (over 100%)',
    viewport: { width: 768, height: 900 },
    scale: LARGEST_TEXT,
    bandRem: 40,
    share: { min: 1, max: Number.POSITIVE_INFINITY },
    pinned: false,
  },
];

/** The live text-size change: pinned at 100% text and scrolling at the largest at 768x900. */
const LIVE_CASE = { viewport: { width: 768, height: 900 }, bandRem: 25 } as const;

const ENGINES = ['chromium', 'firefox'] as const;

type EngineName = (typeof ENGINES)[number];

interface FocusWalk {
  /** For each content control the walk focused, its top edge less the band's bottom edge. */
  clearances: number[];
  scrollTop: number;
}

interface Reading {
  position: string;
  top: number;
  bandHeight: number;
  scrollerHeight: number;
  scrollTop: number;
}

describe('page body pinned band (real browser)', () => {
  let server: FixtureServer;
  const browsers: Partial<Record<EngineName, Browser>> = {};

  beforeAll(async () => {
    server = await startFixtureServer({
      root: FIXTURE_DIR,
      configFile: false,
      plugins: [react(), tailwindcss()],
      watch: null,
      closeBudgetMs: CLOSE_MS,
    });
    const [chromiumBrowser, firefoxBrowser] = await Promise.all([
      chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] }),
      firefox.launch(),
    ]);
    browsers.chromium = chromiumBrowser;
    browsers.firefox = firefoxBrowser;
  }, TEST_MS);

  afterAll(async () => {
    await Promise.all(Object.values(browsers).map((browser) => browser.close()));
    await server.close();
  }, CLOSE_MS + 15_000);

  /** Opens the fixture page in `engine`, mounted with its fonts loaded, and runs `use` on it. */
  async function withPage<T>(
    engine: EngineName,
    { viewport, scale, bandRem }: { viewport: Viewport; scale?: string; bandRem: number },
    use: (page: Page) => Promise<T>
  ): Promise<T> {
    const browser = browsers[engine];
    if (browser === undefined) throw new Error(`${engine} did not launch`);
    const context = await browser.newContext({ viewport });
    try {
      const page = await context.newPage();
      const query = new URLSearchParams({ band: String(bandRem) });
      if (scale !== undefined) query.set('scale', scale);
      await page.goto(`${server.url}/page-body.html?${query.toString()}`, {
        waitUntil: 'commit',
        timeout: LOAD_MS,
      });
      await page.waitForFunction(
        () => globalThis.__pageBody !== undefined && document.fonts.status === 'loaded',
        undefined,
        { timeout: LOAD_MS }
      );
      return await use(page);
    } finally {
      await context.close();
    }
  }

  function read(page: Page): Promise<Reading> {
    return page.evaluate(() => {
      if (__pageBody === undefined) throw new Error('__pageBody not ready');
      return __pageBody.read();
    });
  }

  /** The band's reading at the page's top and again after the page scrolls by `SCROLL_PX`. */
  async function readBeforeAndAfterScroll(page: Page): Promise<[Reading, Reading]> {
    const before = await read(page);
    await page.evaluate((top) => {
      __pageBody?.scrollTo(top);
    }, SCROLL_PX);
    return [before, await read(page)];
  }

  /** Tabs from the page's top through its controls, reading each focused control against the band. */
  async function walkFocus(page: Page): Promise<FocusWalk> {
    const clearances: number[] = [];
    for (let press = 0; press < TAB_PRESSES; press += 1) {
      await page.keyboard.press('Tab');
      const reading = await page.evaluate(() => __pageBody?.focusAgainstBand() ?? null);
      if (reading !== null) clearances.push(reading.control - reading.band);
    }
    const { scrollTop } = await read(page);
    return { clearances, scrollTop };
  }

  function setScale(page: Page, scale: string | null): Promise<void> {
    return page.evaluate((next) => {
      __pageBody?.setScale(next);
    }, scale);
  }

  function waitForPosition(page: Page, position: string): Promise<unknown> {
    return page.waitForFunction((expected) => __pageBody?.read().position === expected, position, {
      timeout: SETTLE_MS,
    });
  }

  describe.each(ENGINES)('in %s', (engine) => {
    it.each(BAND_CASES)(
      'reproduces the measured band share at $label',
      async (bandCase) => {
        const [before] = await withPage(engine, bandCase, readBeforeAndAfterScroll);
        const share = before.bandHeight / before.scrollerHeight;
        expect(share).toBeGreaterThanOrEqual(bandCase.share.min);
        expect(share).toBeLessThanOrEqual(bandCase.share.max);
      },
      TEST_MS
    );

    it.each(BAND_CASES.filter((bandCase) => bandCase.pinned))(
      'keeps the band at the scroller top as the page scrolls at $label',
      async (bandCase) => {
        const [, after] = await withPage(engine, bandCase, readBeforeAndAfterScroll);
        expect(after.position).toBe('sticky');
        expect(Math.abs(after.top)).toBeLessThanOrEqual(EDGE_TOLERANCE_PX);
      },
      TEST_MS
    );

    it.each(BAND_CASES.filter((bandCase) => !bandCase.pinned))(
      'scrolls the band with the page at $label',
      async (bandCase) => {
        const [before, after] = await withPage(engine, bandCase, readBeforeAndAfterScroll);
        expect(after.position).toBe('static');
        expect(Math.abs(after.top - (before.top - SCROLL_PX))).toBeLessThanOrEqual(
          EDGE_TOLERANCE_PX
        );
      },
      TEST_MS
    );

    it.each(BAND_CASES.filter((bandCase) => bandCase.pinned))(
      'keeps every focused control clear of the pinned band at $label',
      async (bandCase) => {
        const walk = await withPage(engine, bandCase, walkFocus);
        expect(walk.clearances.length).toBeGreaterThan(0);
        expect(walk.scrollTop).toBeGreaterThan(0);
        for (const clearance of walk.clearances) {
          expect(clearance).toBeGreaterThanOrEqual(-EDGE_TOLERANCE_PX);
        }
      },
      TEST_MS
    );

    it(
      'unpins the band when the largest text is set on the open page',
      async () => {
        const position = await withPage(engine, LIVE_CASE, async (page) => {
          await setScale(page, LARGEST_TEXT);
          await waitForPosition(page, 'static');
          const reading = await read(page);
          return reading.position;
        });
        expect(position).toBe('static');
      },
      TEST_MS
    );

    it(
      'pins the band again when the largest text is cleared on the open page',
      async () => {
        const position = await withPage(
          engine,
          { ...LIVE_CASE, scale: LARGEST_TEXT },
          async (page) => {
            await setScale(page, null);
            await waitForPosition(page, 'sticky');
            const reading = await read(page);
            return reading.position;
          }
        );
        expect(position).toBe('sticky');
      },
      TEST_MS
    );

    it(
      "settles the band's position before a later resize observer of the band reads it",
      async () => {
        const positions = await withPage(engine, LIVE_CASE, async (page) => {
          await setScale(page, LARGEST_TEXT);
          await waitForPosition(page, 'static');
          return page.evaluate(() => __pageBody?.laterObserverPositions ?? []);
        });
        expect(positions.at(-1)).toBe('static');
      },
      TEST_MS
    );
  });
});
