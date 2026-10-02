import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, type Browser, type BrowserContextOptions } from '@playwright/test';

import { startFixtureServer, type FixtureServer } from '@/test-utils/fixture-server';

/**
 * Measures the sidebar's New chat and Search rows in a real engine, under the app's own
 * stylesheet: whether the shortcut hints are drawn, which depends on the viewport band and
 * the pointer, and the rows' heights, which depend on the pointer. The DOM the unit tests
 * run in evaluates no media query and lays nothing out.
 *
 * Chromium only: it is the one engine whose Playwright touch emulation turns
 * `(pointer: coarse)` on, and the band and pointer are the whole subject here.
 */

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sidebar-rows-fixture');

/** The first load compiles the app's whole stylesheet, which a busy machine can make slow. */
const FIXTURE_LOAD_MS = 90_000;
const TEST_MS = FIXTURE_LOAD_MS + 30_000;

/** Round 1's New chat row, its quiet Search row, the rail's squares and the touch floor. */
const NEW_CHAT_REM = 2.5;
const SEARCH_REM = 2;
const RAIL_REM = 2.25;
const TOUCH_REM = 2.75;

const CONTEXTS = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: { viewport: { width: 390, height: 844 } },
  touch: { viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: true },
} as const satisfies Record<string, BrowserContextOptions>;

type ContextName = keyof typeof CONTEXTS;

const SELECTORS = {
  newChat: '#panel a',
  search: '#panel button',
  railNewChat: '#rail a',
  railSearch: '#rail button',
  field: '#field label',
} as const;

type RowName = keyof typeof SELECTORS;

interface Box {
  width: number;
  height: number;
}

interface Reading {
  rootPx: number;
  panelHint: boolean;
  boxes: Record<RowName, Box>;
  searchType: { fontSize: string; fontWeight: string };
}

async function readFixture(
  browser: Browser,
  origin: string,
  options: BrowserContextOptions
): Promise<Reading> {
  const context = await browser.newContext(options);
  try {
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    // Navigation takes the load budget too: Playwright's own 30s default would cut a slow
    // first compile short. The mount wait below is what proves the page arrived.
    await page.goto(`${origin}/sidebar-rows.html`, {
      waitUntil: 'commit',
      timeout: FIXTURE_LOAD_MS,
    });
    await page
      .waitForFunction(() => globalThis.__rows !== undefined, undefined, {
        timeout: FIXTURE_LOAD_MS,
      })
      .catch((error: unknown) => {
        throw new Error(`the fixture never mounted; page errors: ${pageErrors.join(' | ')}`, {
          cause: error,
        });
      });
    return await page.evaluate((selectors) => {
      if (__rows === undefined) throw new Error('__rows not ready');
      const rows = __rows;
      const boxes = {
        newChat: rows.box(selectors.newChat),
        search: rows.box(selectors.search),
        railNewChat: rows.box(selectors.railNewChat),
        railSearch: rows.box(selectors.railSearch),
        field: rows.box(selectors.field),
      };
      return {
        rootPx: rows.rootPx(),
        panelHint: rows.hintShown('panel'),
        boxes,
        searchType: rows.style(`${selectors.search} > span`),
      };
    }, SELECTORS);
  } finally {
    await context.close();
  }
}

function expectNear(actual: number | undefined, expected: number): void {
  expect(actual).toBeGreaterThanOrEqual(expected - 0.5);
  expect(actual).toBeLessThanOrEqual(expected + 0.5);
}

describe('sidebar New chat and Search rows (real browser)', () => {
  let server: FixtureServer;
  let browser: Browser;
  const readings = new Map<ContextName, Promise<Reading>>();

  beforeAll(async () => {
    server = await startFixtureServer({ root: FIXTURE_DIR, plugins: [react(), tailwindcss()] });
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  }, 120_000);

  afterAll(async () => {
    await browser.close();
    await server.close();
  });

  function readingFor(name: ContextName): Promise<Reading> {
    let reading = readings.get(name);
    if (reading === undefined) {
      reading = readFixture(browser, server.url, CONTEXTS[name]);
      readings.set(name, reading);
    }
    return reading;
  }

  it(
    'draws the shortcut hints from 768 on a fine pointer',
    async () => {
      const { panelHint } = await readingFor('desktop');
      expect(panelHint).toBe(true);
    },
    TEST_MS
  );

  it(
    'hides the shortcut hints below 768',
    async () => {
      const { panelHint } = await readingFor('phone');
      expect(panelHint).toBe(false);
    },
    TEST_MS
  );

  it(
    'hides the shortcut hints under a coarse pointer',
    async () => {
      const { panelHint } = await readingFor('touch');
      expect(panelHint).toBe(false);
    },
    TEST_MS
  );

  it.each(['desktop', 'phone'] as const)(
    'draws the rows at their fine-pointer heights on the %s band',
    async (name) => {
      const { rootPx, boxes } = await readingFor(name);
      expectNear(boxes.newChat.height, NEW_CHAT_REM * rootPx);
      expectNear(boxes.search.height, SEARCH_REM * rootPx);
      expectNear(boxes.field.height, SEARCH_REM * rootPx);
    },
    TEST_MS
  );

  it(
    'draws the rail rows as squares on a fine pointer',
    async () => {
      const { rootPx, boxes } = await readingFor('desktop');
      for (const row of [boxes.railNewChat, boxes.railSearch]) {
        expectNear(row.width, RAIL_REM * rootPx);
        expectNear(row.height, RAIL_REM * rootPx);
      }
    },
    TEST_MS
  );

  it(
    'grows every row to the touch floor under a coarse pointer',
    async () => {
      const { rootPx, boxes } = await readingFor('touch');
      for (const name of ['newChat', 'search', 'field'] as const) {
        expectNear(boxes[name].height, TOUCH_REM * rootPx);
      }
    },
    TEST_MS
  );

  it(
    'grows the rail squares to the touch floor under a coarse pointer',
    async () => {
      const { rootPx, boxes } = await readingFor('touch');
      for (const row of [boxes.railNewChat, boxes.railSearch]) {
        expectNear(row.width, TOUCH_REM * rootPx);
        expectNear(row.height, TOUCH_REM * rootPx);
      }
    },
    TEST_MS
  );

  it(
    'sets the Search label in the small UI size at medium weight',
    async () => {
      const { rootPx, searchType } = await readingFor('desktop');
      expectNear(Number.parseFloat(searchType.fontSize), 0.8125 * rootPx);
      expect(searchType.fontWeight).toBe('500');
    },
    TEST_MS
  );
});
