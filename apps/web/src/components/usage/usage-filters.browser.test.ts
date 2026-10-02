import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, type Browser } from '@playwright/test';

import { startFixtureServer, type FixtureServer } from '@/test-utils/fixture-server';

/**
 * Lays the usage page's filter row out in a real engine, under the app's own stylesheet
 * and the accessibility widget's text-size class: whether the range buttons stay inside
 * the page's column. The DOM the unit tests run in lays nothing out.
 */

const DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(DIRECTORY, 'usage-filters-fixture');
const SRC_DIR = path.resolve(DIRECTORY, '../..');

/** The first load compiles the app's whole stylesheet, which a busy machine can make slow. */
const FIXTURE_LOAD_MS = 90_000;
const TEST_MS = FIXTURE_LOAD_MS + 30_000;

/** Sub-pixel layout rounding the comparison forgives. */
const EDGE_TOLERANCE_PX = 0.5;

interface Rect {
  left: number;
  right: number;
  top: number;
}

interface Layout {
  row: Rect;
  buttons: Rect[];
}

async function layoutAt(
  browser: Browser,
  origin: string,
  width: number,
  query: string
): Promise<Layout> {
  const context = await browser.newContext({ viewport: { width, height: 800 } });
  try {
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    // Navigation takes the load budget too: Playwright's own 30s default would cut a slow
    // first compile short. The mount wait below is what proves the page arrived.
    await page.goto(`${origin}/usage-filters.html?${query}`, {
      waitUntil: 'commit',
      timeout: FIXTURE_LOAD_MS,
    });
    await page
      .waitForFunction(() => globalThis.__filters !== undefined, undefined, {
        timeout: FIXTURE_LOAD_MS,
      })
      .catch((error: unknown) => {
        throw new Error(`the fixture never mounted; page errors: ${pageErrors.join(' | ')}`, {
          cause: error,
        });
      });
    return await page.evaluate(() => {
      if (__filters === undefined) throw new Error('__filters not ready');
      return __filters.measure();
    });
  } finally {
    await context.close();
  }
}

function expectInsideRow({ row, buttons }: Layout): void {
  for (const button of buttons) {
    expect(button.left).toBeGreaterThanOrEqual(row.left - EDGE_TOLERANCE_PX);
    expect(button.right).toBeLessThanOrEqual(row.right + EDGE_TOLERANCE_PX);
  }
}

describe('usage filter row (real browser)', () => {
  let server: FixtureServer;
  let browser: Browser;

  beforeAll(async () => {
    server = await startFixtureServer({
      root: FIXTURE_DIR,
      plugins: [react(), tailwindcss()],
      resolve: {
        alias: [
          // The model names come from the catalog query, which the fixture serves unanswered.
          {
            find: /^@\/hooks\/models\/models$/,
            replacement: path.join(FIXTURE_DIR, 'models-stub.ts'),
          },
          { find: /^@\/(.*)$/, replacement: path.join(SRC_DIR, '$1') },
        ],
      },
    });
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  }, 120_000);

  afterAll(async () => {
    await browser.close();
    await server.close();
  });

  it(
    'keeps every range button inside the column at 320 with 141% text',
    async () => {
      expectInsideRow(await layoutAt(browser, server.url, 320, 'scale=141'));
    },
    TEST_MS
  );

  it(
    'keeps every range button inside the column at 320',
    async () => {
      expectInsideRow(await layoutAt(browser, server.url, 320, ''));
    },
    TEST_MS
  );

  it(
    'sets the range buttons on one line where the column holds them',
    async () => {
      const { buttons } = await layoutAt(browser, server.url, 1440, '');
      expect(new Set(buttons.map((button) => Math.round(button.top))).size).toBe(1);
    },
    TEST_MS
  );
});
