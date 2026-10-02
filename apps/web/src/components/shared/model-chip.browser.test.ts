import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, firefox, type Browser, type Page } from '@playwright/test';

/**
 * Measures the model chip inside the real composer bar in real engines: the chip's name
 * truncates by layout, and whether the count of further models survives that squeeze is
 * geometry the DOM this app's other tests run in does not compute.
 *
 * Follows the repo's pattern for real Playwright from ordinary Vitest: a plain dev server
 * over a fixture directory and `@playwright/test` launched directly.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, 'model-chip-fixture');
const SRC_DIR = path.resolve(HERE, '../..');

/** The first load compiles the app's whole stylesheet, which a busy machine can make slow. */
const FIXTURE_LOAD_MS = 90_000;
const TEST_MS = FIXTURE_LOAD_MS + 30_000;

/** The chip's chevron is the icon scale's `sm` step. */
const CHEVRON_REM = 0.875;

type EngineName = 'chromium' | 'firefox';
const ENGINES: readonly EngineName[] = ['chromium', 'firefox'];

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
}

interface ChipReading {
  rootPx: number;
  chip: Box;
  count: Box | null;
  chevron: Box;
  countClipped: boolean | null;
  nameTruncated: boolean;
}

declare global {
  var __modelChip:
    | {
        mount(widthRem: number, label: string, count: string | undefined): void;
        read(): ChipReading;
      }
    | undefined;
}

async function startFixtureServer(): Promise<{ origin: string; close: () => Promise<void> }> {
  // The app's default dependency cache is the one the running dev server serves from, so the
  // fixture optimises its dependencies into a private cache outside the repository.
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'model-chip-vite-'));
  const server: ViteDevServer = await createServer({
    root: FIXTURE_DIR,
    cacheDir,
    logLevel: 'error',
    plugins: [react(), tailwindcss()],
    resolve: { alias: [{ find: /^@\/(.*)$/, replacement: path.join(SRC_DIR, '$1') }] },
    server: { port: 0, host: '127.0.0.1', hmr: false },
  });
  try {
    await server.listen();
  } catch (error) {
    await server.close();
    await rm(cacheDir, { recursive: true, force: true });
    throw error;
  }
  const address = server.httpServer?.address();
  if (address === null || address === undefined || typeof address === 'string') {
    await server.close();
    await rm(cacheDir, { recursive: true, force: true });
    throw new Error('model chip fixture server has no port');
  }
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    close: async () => {
      try {
        await server.close();
      } finally {
        await rm(cacheDir, { recursive: true, force: true });
      }
    },
  };
}

async function openFixture(browser: Browser, origin: string, dark: boolean): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${origin}/model-chip.html`, { waitUntil: 'commit', timeout: FIXTURE_LOAD_MS });
  await page
    .waitForFunction(() => globalThis.__modelChip !== undefined, undefined, {
      timeout: FIXTURE_LOAD_MS,
    })
    .catch((error: unknown) => {
      throw new Error(`the fixture never loaded; page errors: ${pageErrors.join(' | ')}`, {
        cause: error,
      });
    });
  await page.evaluate((isDark) => {
    document.documentElement.classList.toggle('dark', isDark);
  }, dark);
  return page;
}

async function readChip(
  page: Page,
  widthRem: number,
  label: string,
  count: string | undefined
): Promise<ChipReading> {
  // The mount renders synchronously, and reading a box forces the layout the container
  // queries resolve in, so no frame needs to pass first.
  return page.evaluate(
    ({ rem, name, more }) => {
      if (__modelChip === undefined) throw new Error('__modelChip not ready');
      __modelChip.mount(rem, name, more);
      return __modelChip.read();
    },
    { rem: widthRem, name: label, more: count }
  );
}

function inside(inner: Box, outer: Box): boolean {
  return inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5;
}

describe('model chip (real browser)', () => {
  let server: { origin: string; close: () => Promise<void> };
  const browsers: Partial<Record<EngineName, Browser>> = {};

  beforeAll(async () => {
    server = await startFixtureServer();
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

  async function withPage<T>(
    engine: EngineName,
    dark: boolean,
    use: (page: Page) => Promise<T>
  ): Promise<T> {
    const browser = browsers[engine];
    if (browser === undefined) throw new Error(`${engine} did not launch`);
    const page = await openFixture(browser, server.origin, dark);
    try {
      return await use(page);
    } finally {
      await page.context().close();
    }
  }

  describe.each(ENGINES)('on %s', (engine) => {
    it.each([
      { theme: 'light', dark: false },
      { theme: 'dark', dark: true },
    ])(
      'keeps the count whole while a phone composer truncates the name, in the $theme theme',
      async ({ dark }) => {
        await withPage(engine, dark, async (page) => {
          for (const widthRem of [20.25, 22.4]) {
            const reading = await readChip(page, widthRem, 'Claude Sonnet 4.5', ' + 2');
            expect(reading.nameTruncated).toBe(true);
            expect(reading.count).not.toBeNull();
            expect(reading.countClipped).toBe(false);
            expect(inside(reading.count!, reading.chip)).toBe(true);
          }
        });
      },
      TEST_MS
    );

    it.each([
      { selection: 'several models', count: ' + 2' },
      { selection: 'one model', count: undefined },
    ])(
      'keeps the chevron at its full size while a phone composer truncates the name, for $selection',
      async ({ count }) => {
        await withPage(engine, false, async (page) => {
          for (const widthRem of [20.25, 22.4]) {
            const reading = await readChip(page, widthRem, 'DeepSeek V4.1 Flash', count);
            expect(reading.nameTruncated).toBe(true);
            expect(reading.chevron.width).toBeCloseTo(CHEVRON_REM * reading.rootPx, 1);
          }
        });
      },
      TEST_MS
    );

    it(
      'keeps the count whole beside a long first name in a roomy composer',
      async () => {
        await withPage(engine, false, async (page) => {
          const reading = await readChip(page, 42, 'Qwen3 Coder 30B A3B Instruct', ' + 2');
          expect(reading.nameTruncated).toBe(true);
          expect(reading.countClipped).toBe(false);
          expect(inside(reading.count!, reading.chip)).toBe(true);
        });
      },
      TEST_MS
    );
  });
});
