import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, firefox, type Browser, type Page } from '@playwright/test';

import { startFixtureServer, type FixtureServer } from '@/test-utils/fixture-server';

/**
 * Reads the prediction overlay's wrap off a real engine. The overlay draws the hint by
 * letting the browser break a transparent copy of the typed text, so it lands at the caret
 * only while it breaks its lines by the same rules as the composer's textarea — rules a
 * `<textarea>` takes from the user-agent stylesheet and the overlay from utility classes,
 * which only a real cascade resolves.
 *
 * `@vitest/browser` is not installed. This follows the repo's pattern for driving real
 * Playwright from ordinary Vitest: a plain dev server over a fixture directory plus
 * `@playwright/test` launched directly.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, 'prediction-overlay-fixture');
const SRC_DIR = path.resolve(HERE, '../../..');

/**
 * One budget for a fixture's whole load, navigation and mount together. The first load
 * compiles the app's whole stylesheet, which a busy machine can make slow.
 */
const FIXTURE_LOAD_MS = 90_000;
/** Above the load budget, so a load that runs out reports the fixture's own diagnostic. */
const TEST_MS = FIXTURE_LOAD_MS + 30_000;

type EngineName = 'chromium' | 'firefox';
const ENGINES: readonly EngineName[] = ['chromium', 'firefox'];
/** A phone column and a desktop window: the composer's type scale steps between them. */
const WIDTHS = [375, 1280] as const;
const CASES = ENGINES.flatMap((engine) => WIDTHS.map((width) => [engine, width] as const));

type WrapReadings = ReturnType<NonNullable<typeof globalThis.__predictionOverlay>['read']>;

/** Loads the fixture on `page` within {@link FIXTURE_LOAD_MS}, or throws what the page reported. */
async function loadFixture(page: Page, origin: string): Promise<void> {
  const deadline = Date.now() + FIXTURE_LOAD_MS;
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  try {
    await page.goto(`${origin}/prediction-overlay.html`, {
      waitUntil: 'commit',
      timeout: FIXTURE_LOAD_MS,
    });
    await page.waitForFunction(() => globalThis.__predictionOverlay !== undefined, undefined, {
      timeout: Math.max(1, deadline - Date.now()),
    });
  } catch (error) {
    throw new Error(`the fixture never loaded; page errors: ${pageErrors.join(' | ')}`, {
      cause: error,
    });
  }
}

/** Reads both layers' wrap from one load of the fixture, closing its context however the load ends. */
async function readFixture(browser: Browser, origin: string, width: number): Promise<WrapReadings> {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  try {
    const page = await context.newPage();
    await loadFixture(page, origin);
    return await page.evaluate(() => {
      if (__predictionOverlay === undefined) throw new Error('__predictionOverlay not ready');
      return __predictionOverlay.read();
    });
  } finally {
    await context.close();
  }
}

describe('prediction overlay wrap (real browser)', () => {
  let server: FixtureServer;
  const browsers: Partial<Record<EngineName, Browser>> = {};

  beforeAll(async () => {
    server = await startFixtureServer({
      root: FIXTURE_DIR,
      plugins: [react(), tailwindcss()],
      resolve: { alias: [{ find: /^@\/(.*)$/, replacement: path.join(SRC_DIR, '$1') }] },
    });
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

  // One load per engine and width, shared by every property read from it: each load
  // compiles the app's stylesheet, the slow part of this file.
  const readings = new Map<string, Promise<WrapReadings>>();

  function readWrap(engine: EngineName, width: number): Promise<WrapReadings> {
    const key = `${engine}@${String(width)}`;
    let reading = readings.get(key);
    if (reading === undefined) {
      const browser = browsers[engine];
      if (browser === undefined) throw new Error(`${engine} did not launch`);
      reading = readFixture(browser, server.url, width);
      readings.set(key, reading);
    }
    return reading;
  }

  it.each(CASES)(
    'computes the textarea overflow-wrap on the overlay, on %s at %ipx',
    async (engine, width) => {
      const { textarea, overlay } = await readWrap(engine, width);
      expect(overlay.overflowWrap).toBe(textarea.overflowWrap);
    },
    TEST_MS
  );

  it.each(CASES)(
    'computes the textarea word-break on the overlay, on %s at %ipx',
    async (engine, width) => {
      const { textarea, overlay } = await readWrap(engine, width);
      expect(overlay.wordBreak).toBe(textarea.wordBreak);
    },
    TEST_MS
  );
});
