import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, firefox, type Browser, type Page } from '@playwright/test';

import { startFixtureServer, type FixtureServer } from '@/test-utils/fixture-server';

/**
 * Lays a page body out in a real engine, under the app's own stylesheet, at 768x900: whether
 * its pinned band sticks to the scroller's top or scrolls with the page, which turns on the
 * band's laid-out height against the scroller's. The DOM the unit tests run in lays nothing out.
 */

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'page-body-fixture');

/** The first load compiles the app's whole stylesheet, which a busy machine can make slow. */
const LOAD_MS = 90_000;
const TEST_MS = LOAD_MS * 2;
const CLOSE_MS = 45_000;
/** How long a text-size change on the live page may take to reach the band's position. */
const SETTLE_MS = 10_000;

const VIEWPORT = { width: 768, height: 900 } as const;
/** The accessibility widget's largest text size. */
const LARGEST_TEXT = '141';
/** How far the tests scroll the page: less than the page's overflow at either text size. */
const SCROLL_PX = 200;
/** Sub-pixel layout rounding the comparison forgives. */
const EDGE_TOLERANCE_PX = 0.5;

const ENGINES = ['chromium', 'firefox'] as const;

type EngineName = (typeof ENGINES)[number];

interface Reading {
  position: string;
  top: number;
  bandHeight: number;
  scrollerHeight: number;
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
    scale: string | undefined,
    use: (page: Page) => Promise<T>
  ): Promise<T> {
    const browser = browsers[engine];
    if (browser === undefined) throw new Error(`${engine} did not launch`);
    const context = await browser.newContext({ viewport: VIEWPORT });
    try {
      const page = await context.newPage();
      const query = scale === undefined ? '' : `?scale=${scale}`;
      await page.goto(`${server.url}/page-body.html${query}`, {
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

  function setScale(page: Page, scale: string | null): Promise<void> {
    return page.evaluate((next) => {
      __pageBody?.setScale(next);
    }, scale);
  }

  function waitForPosition(page: Page, position: string): Promise<unknown> {
    return page.waitForFunction(
      (expected) => __pageBody?.read().position === expected,
      position,
      { timeout: SETTLE_MS }
    );
  }

  describe.each(ENGINES)('in %s at 768x900', (engine) => {
    it(
      'keeps the band at the scroller top as the page scrolls at 100% text',
      async () => {
        const [before, after] = await withPage(engine, undefined, readBeforeAndAfterScroll);
        expect(before.bandHeight).toBeLessThanOrEqual(before.scrollerHeight / 2);
        expect(after.position).toBe('sticky');
        expect(Math.abs(after.top)).toBeLessThanOrEqual(EDGE_TOLERANCE_PX);
      },
      TEST_MS
    );

    it(
      'scrolls the band with the page under the largest text',
      async () => {
        const [before, after] = await withPage(engine, LARGEST_TEXT, readBeforeAndAfterScroll);
        expect(before.bandHeight).toBeGreaterThan(before.scrollerHeight / 2);
        expect(after.position).toBe('static');
        expect(Math.abs(after.top - (before.top - SCROLL_PX))).toBeLessThanOrEqual(
          EDGE_TOLERANCE_PX
        );
      },
      TEST_MS
    );

    it(
      'unpins the band when the largest text is set on the open page',
      async () => {
        const position = await withPage(engine, undefined, async (page) => {
          await setScale(page, LARGEST_TEXT);
          await waitForPosition(page, 'static');
          return (await read(page)).position;
        });
        expect(position).toBe('static');
      },
      TEST_MS
    );

    it(
      'pins the band again when the largest text is cleared on the open page',
      async () => {
        const position = await withPage(engine, LARGEST_TEXT, async (page) => {
          await setScale(page, null);
          await waitForPosition(page, 'sticky');
          return (await read(page)).position;
        });
        expect(position).toBe('sticky');
      },
      TEST_MS
    );

    it(
      "settles the band's position before a later resize observer of the band reads it",
      async () => {
        const positions = await withPage(engine, undefined, async (page) => {
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
