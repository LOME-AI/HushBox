import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, type Browser, type BrowserContextOptions, type Page } from '@playwright/test';

/**
 * Measures the auth frame (`routes/_auth.tsx`) in a real engine: whether the CipherWall
 * shows is decided by a container query on the frame's own width and by the pointer, and
 * neither exists in the DOM this app's other tests run in.
 *
 * `@vitest/browser` is not installed. This follows the repo's established pattern for
 * driving real Playwright from ordinary Vitest: a plain dev server plus `@playwright/test`
 * launched directly, as `setting-card-targets.browser.test.ts` does.
 *
 * Chromium only: it is the one engine whose Playwright touch emulation turns
 * `(pointer: coarse)` on, and the layout rules under test are plain CSS every engine
 * shares.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, 'auth-frame-fixture');
const SRC_DIR = path.resolve(HERE, '../..');

/** The form column's padding wherever the wall is hidden: 3.5rem over, 2rem under and beside. */
const SINGLE_COLUMN_PADDING_REM = { top: 3.5, inline: 2, bottom: 2 } as const;
/** The form column's padding beside the wall: 4rem beside, 3.5rem over and under. */
const SPLIT_PADDING_REM = { top: 3.5, inline: 4, bottom: 3.5 } as const;
/** The form column's minimum beside the wall. */
const FORM_MIN_REM = 34;
/** Layout rounding a measured width may carry. */
const TOLERANCE_PX = 2;

/** The first load compiles the app's whole stylesheet, which a busy machine can make slow. */
const FIXTURE_LOAD_MS = 90_000;
const TEST_MS = FIXTURE_LOAD_MS + 30_000;

interface Padding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

interface FrameReading {
  coarse: boolean;
  rootPx: number;
  frameWidth: number;
  wallShown: boolean;
  formWidth: number;
  wallWidth: number;
  formPadding: Padding;
}

declare global {
  var __authFrame: { read(): FrameReading } | undefined;
}

async function startFixtureServer(): Promise<{ origin: string; close: () => Promise<void> }> {
  // Vite's default dependency cache is this app's `node_modules/.vite`, the one the running
  // dev server serves from; optimising this fixture's dependencies there rewrites that
  // cache under the dev server and leaves it answering 504 for every module it had.
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'auth-frame-vite-'));
  const server: ViteDevServer = await createServer({
    root: FIXTURE_DIR,
    cacheDir,
    logLevel: 'error',
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: [
        {
          find: /^@\/lib\/auth\/auth$/,
          replacement: path.join(FIXTURE_DIR, 'auth-client-stub.ts'),
        },
        { find: /^@\/(.*)$/, replacement: path.join(SRC_DIR, '$1') },
      ],
    },
    // hmr disabled: every reading here is one-shot — nothing needs a live-reload push.
    server: { port: 0, host: '127.0.0.1', hmr: false },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (address === null || address === undefined || typeof address === 'string') {
    throw new Error('auth frame fixture server has no port');
  }
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    close: async () => {
      await server.close();
      await rm(cacheDir, { recursive: true, force: true });
    },
  };
}

async function readFrame(
  browser: Browser,
  origin: string,
  options: BrowserContextOptions
): Promise<FrameReading> {
  const context = await browser.newContext(options);
  try {
    const page: Page = await context.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    // Only the navigation is awaited here; the mount wait below carries the load budget, so
    // a slow first compile of the stylesheet is not cut off by the navigation's own timeout.
    await page.goto(`${origin}/auth-frame.html`, {
      waitUntil: 'commit',
      timeout: FIXTURE_LOAD_MS,
    });
    await page
      .waitForFunction(() => globalThis.__authFrame !== undefined, undefined, {
        timeout: FIXTURE_LOAD_MS,
      })
      .catch((error: unknown) => {
        throw new Error(`the fixture never mounted; page errors: ${pageErrors.join(' | ')}`, {
          cause: error,
        });
      });
    return await page.evaluate(() => {
      if (__authFrame === undefined) throw new Error('__authFrame not ready');
      return __authFrame.read();
    });
  } finally {
    await context.close();
  }
}

function fine(width: number): BrowserContextOptions {
  return { viewport: { width, height: 900 } };
}

function touch(width: number): BrowserContextOptions {
  return { viewport: { width, height: 900 }, hasTouch: true, isMobile: true };
}

function expectPadding(
  reading: FrameReading,
  rem: { top: number; inline: number; bottom: number }
): void {
  expect(reading.formPadding).toEqual({
    top: rem.top * reading.rootPx,
    right: rem.inline * reading.rootPx,
    bottom: rem.bottom * reading.rootPx,
    left: rem.inline * reading.rootPx,
  });
}

/** Today's split: each column gets half of what is left after the form's own padding. */
function todaysSplit(reading: FrameReading): { form: number; wall: number } {
  const padding = 2 * SPLIT_PADDING_REM.inline * reading.rootPx;
  const half = (reading.frameWidth - padding) / 2;
  return { form: half + padding, wall: half };
}

describe('auth frame (real browser)', () => {
  let server: { origin: string; close: () => Promise<void> };
  let browser: Browser | undefined;

  beforeAll(async () => {
    server = await startFixtureServer();
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await server.close();
  });

  const readings = new Map<string, Promise<FrameReading>>();

  /** One load per width and pointer, shared by every test that asserts on it. */
  function read(width: number, pointer: 'fine' | 'touch'): Promise<FrameReading> {
    if (browser === undefined) throw new Error('chromium did not launch');
    const key = `${String(width)}/${pointer}`;
    let reading = readings.get(key);
    if (reading === undefined) {
      reading = readFrame(browser, server.origin, pointer === 'fine' ? fine(width) : touch(width));
      readings.set(key, reading);
    }
    return reading;
  }

  it.each([320, 390, 834])(
    'shows no wall at %ipx with a fine pointer',
    async (width) => {
      const reading = await read(width, 'fine');
      expect(reading.coarse).toBe(false);
      expect(reading.wallShown).toBe(false);
      expect(reading.formWidth).toBeCloseTo(reading.frameWidth, 0);
    },
    TEST_MS
  );

  it.each([320, 390, 834])(
    'pads the form column 3.5rem over, 2rem under and beside at %ipx with a fine pointer',
    async (width) => {
      expectPadding(await read(width, 'fine'), SINGLE_COLUMN_PADDING_REM);
    },
    TEST_MS
  );

  it.each([834, 1440])(
    'shows no wall at %ipx under touch emulation',
    async (width) => {
      const reading = await read(width, 'touch');
      expect(reading.coarse).toBe(true);
      expect(reading.wallShown).toBe(false);
      expect(reading.formWidth).toBeCloseTo(reading.frameWidth, 0);
    },
    TEST_MS
  );

  it.each([834, 1440])(
    'pads the form column 3.5rem over, 2rem under and beside at %ipx under touch emulation',
    async (width) => {
      expectPadding(await read(width, 'touch'), SINGLE_COLUMN_PADDING_REM);
    },
    TEST_MS
  );

  it(
    'holds the form column at its 34rem minimum beside the wall at 900px',
    async () => {
      const reading = await read(900, 'fine');
      expect(reading.wallShown).toBe(true);
      expect(Math.abs(reading.formWidth - FORM_MIN_REM * reading.rootPx)).toBeLessThanOrEqual(
        TOLERANCE_PX
      );
      expect(reading.wallWidth).toBeGreaterThanOrEqual(reading.frameWidth / 3 - TOLERANCE_PX);
    },
    TEST_MS
  );

  it.each([1024, 1440, 1920])(
    "shows the wall at %ipx in today's split",
    async (width) => {
      const reading = await read(width, 'fine');
      expect(reading.wallShown).toBe(true);
      const split = todaysSplit(reading);
      expect(Math.abs(reading.formWidth - split.form)).toBeLessThanOrEqual(TOLERANCE_PX);
      expect(Math.abs(reading.wallWidth - split.wall)).toBeLessThanOrEqual(TOLERANCE_PX);
    },
    TEST_MS
  );

  it.each([900, 1024, 1440, 1920])(
    'pads the form column 4rem beside and 3.5rem over and under beside the wall at %ipx',
    async (width) => {
      expectPadding(await read(width, 'fine'), SPLIT_PADDING_REM);
    },
    TEST_MS
  );

  it(
    'splits 788 and 652 at 1440px, as the live page measures today',
    async () => {
      const reading = await read(1440, 'fine');
      expect(Math.abs(reading.formWidth - 788)).toBeLessThanOrEqual(TOLERANCE_PX);
      expect(Math.abs(reading.wallWidth - 652)).toBeLessThanOrEqual(TOLERANCE_PX);
    },
    TEST_MS
  );
});
