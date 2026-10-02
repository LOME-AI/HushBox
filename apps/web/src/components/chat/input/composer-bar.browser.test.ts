import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import {
  chromium,
  firefox,
  type Browser,
  type BrowserContextOptions,
  type Page,
} from '@playwright/test';
import type { ChatModality } from '@hushbox/shared';

/**
 * Measures the composer's control bar in real engines: it compacts on a container query
 * over the composer's own width, and neither the query nor the wrapped geometry it
 * produces exists in the DOM this app's other tests run in.
 *
 * `@vitest/browser` is not installed. This follows the repo's pattern for driving real
 * Playwright from ordinary Vitest: a plain dev server over a fixture directory plus
 * `@playwright/test` launched directly. The fixture mounts either the real `PromptInput`,
 * with its data hooks stubbed, or the real `ComposerBar` holding the composer chips.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, 'composer-bar-fixture');
const SRC_DIR = path.resolve(HERE, '../../..');

/** The first load compiles the app's whole stylesheet, which a busy machine can make slow. */
const FIXTURE_LOAD_MS = 90_000;
const TEST_MS = FIXTURE_LOAD_MS + 30_000;

type EngineName = 'chromium' | 'firefox';
const ENGINES: readonly EngineName[] = ['chromium', 'firefox'];

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
}

interface ControlReading {
  name: string;
  slot: string;
  box: Box;
  shownText: string;
  truncated: boolean;
}

interface ComposerReading {
  rootPx: number;
  composer: Box;
  field: Box;
  barGapPx: number;
  barPaddingInlinePx: number;
  controls: ControlReading[];
  rows: number;
  pageScrollWidth: number;
}

interface ComposerOptions {
  effort: boolean;
  modality: ChatModality;
}

declare global {
  var __composerBar:
    | {
        mountComposer(options: ComposerOptions): void;
        mountChips(widthRem: number): void;
        read(): ComposerReading;
      }
    | undefined;
}

/** Stubbed data hooks: each alias swaps one module the composer reads for the fixture's stand-in. */
const STUBS: readonly (readonly [string, string])[] = [
  ['@/hooks/billing/use-prompt-budget', 'prompt-budget-stub.ts'],
  ['@/hooks/models/use-payer-premium-access', 'payer-premium-access-stub.ts'],
  ['@/hooks/chat/use-reasoning-effort', 'reasoning-effort-stub.ts'],
  ['@/providers/stability-provider', 'stability-stub.ts'],
  ['@/components/chat/budget/composer-messages', 'composer-messages-stub.ts'],
];

function escapeForPattern(specifier: string): string {
  return specifier.replaceAll(/[.*+?^${}()|[\]\\/]/g, String.raw`\$&`);
}

async function startFixtureServer(): Promise<{ origin: string; close: () => Promise<void> }> {
  // Vite's default dependency cache is this app's `node_modules/.vite`, the one the running
  // dev server serves from; optimising this fixture's dependencies there rewrites that
  // cache under the dev server and leaves it answering 504 for every module it had. The
  // private cache sits in the OS temp directory, outside the repository.
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'composer-bar-vite-'));
  const server: ViteDevServer = await createServer({
    root: FIXTURE_DIR,
    cacheDir,
    logLevel: 'error',
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: [
        ...STUBS.map(([specifier, stub]) => ({
          find: new RegExp(`^${escapeForPattern(specifier)}$`),
          replacement: path.join(FIXTURE_DIR, stub),
        })),
        { find: /^@\/(.*)$/, replacement: path.join(SRC_DIR, '$1') },
      ],
    },
    // hmr disabled: every reading here is one-shot — nothing needs a live-reload push.
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
    throw new Error('composer bar fixture server has no port');
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

interface PageSetup {
  width: number;
  dark?: boolean;
  /** The accessibility widget's largest text step. */
  largeText?: boolean;
}

async function openFixture(browser: Browser, origin: string, setup: PageSetup): Promise<Page> {
  const options: BrowserContextOptions = { viewport: { width: setup.width, height: 900 } };
  const context = await browser.newContext(options);
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  // Only the navigation is awaited here; the mount wait below carries the load budget, so a
  // slow first compile of the stylesheet is not cut off by the navigation's own timeout.
  await page.goto(`${origin}/composer-bar.html`, { waitUntil: 'commit', timeout: FIXTURE_LOAD_MS });
  await page
    .waitForFunction(() => globalThis.__composerBar !== undefined, undefined, {
      timeout: FIXTURE_LOAD_MS,
    })
    .catch((error: unknown) => {
      throw new Error(`the fixture never loaded; page errors: ${pageErrors.join(' | ')}`, {
        cause: error,
      });
    });
  await page.evaluate(
    ({ dark, largeText }) => {
      document.documentElement.classList.toggle('dark', dark);
      document.documentElement.classList.toggle('a11y-font-scale-141', largeText);
    },
    { dark: setup.dark === true, largeText: setup.largeText === true }
  );
  return page;
}

async function readComposer(page: Page, options: ComposerOptions): Promise<ComposerReading> {
  await page.evaluate((mount) => {
    if (__composerBar === undefined) throw new Error('__composerBar not ready');
    __composerBar.mountComposer(mount);
  }, options);
  return readAfterLayout(page);
}

async function readChips(page: Page, widthRem: number): Promise<ComposerReading> {
  await page.evaluate((rem) => {
    if (__composerBar === undefined) throw new Error('__composerBar not ready');
    __composerBar.mountChips(rem);
  }, widthRem);
  return readAfterLayout(page);
}

async function readAfterLayout(page: Page): Promise<ComposerReading> {
  // The mount renders synchronously, and reading a box forces the layout the container
  // queries resolve in, so no frame needs to pass first.
  return page.evaluate(() => {
    if (__composerBar === undefined) throw new Error('__composerBar not ready');
    return __composerBar.read();
  });
}

function control(reading: ComposerReading, slot: string): ControlReading | undefined {
  return reading.controls.find((entry) => entry.slot === slot);
}

function requireControl(reading: ComposerReading, slot: string): ControlReading {
  const found = control(reading, slot);
  if (found === undefined) {
    throw new Error(`no control shows in the ${slot} slot: ${JSON.stringify(reading.controls)}`);
  }
  return found;
}

function inside(inner: Box, outer: Box): boolean {
  return (
    inner.left >= outer.left - 0.5 &&
    inner.right <= outer.right + 0.5 &&
    inner.top >= outer.top - 0.5 &&
    inner.bottom <= outer.bottom + 0.5
  );
}

function overlaps(a: Box, b: Box): boolean {
  return (
    a.left < b.right - 0.5 &&
    b.left < a.right - 0.5 &&
    a.top < b.bottom - 0.5 &&
    b.top < a.bottom - 0.5
  );
}

/** Pairs of controls whose boxes cross, by name. */
function overlappingPairs(reading: ComposerReading): string[] {
  const pairs: string[] = [];
  const { controls } = reading;
  for (const [index, first] of controls.entries()) {
    for (const second of controls.slice(index + 1)) {
      if (overlaps(first.box, second.box)) pairs.push(`${first.name} × ${second.name}`);
    }
  }
  return pairs;
}

describe('composer bar (real browser)', () => {
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
    setup: PageSetup,
    use: (page: Page) => Promise<T>
  ): Promise<T> {
    const browser = browsers[engine];
    if (browser === undefined) throw new Error(`${engine} did not launch`);
    const page = await openFixture(browser, server.origin, setup);
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
      'keeps Send fully inside the composer at 320 in the $theme theme',
      async ({ dark }) => {
        await withPage(engine, { width: 320, dark }, async (page) => {
          for (const effort of [true, false]) {
            const reading = await readComposer(page, { effort, modality: 'text' });
            expect(inside(requireControl(reading, 'send').box, reading.field)).toBe(true);
            expect(reading.pageScrollWidth).toBeLessThanOrEqual(320);
          }
        });
      },
      TEST_MS
    );

    it(
      'keeps Send inside the composer at 320 under the largest text step',
      async () => {
        await withPage(engine, { width: 320, largeText: true }, async (page) => {
          const reading = await readComposer(page, { effort: true, modality: 'text' });
          expect(inside(requireControl(reading, 'send').box, reading.field)).toBe(true);
        });
      },
      TEST_MS
    );

    it(
      'overlaps no two controls at 320',
      async () => {
        await withPage(engine, { width: 320 }, async (page) => {
          for (const modality of ['text', 'image', 'video'] as const) {
            const reading = await readComposer(page, { effort: modality === 'text', modality });
            expect(overlappingPairs(reading)).toEqual([]);
          }
        });
      },
      TEST_MS
    );

    it.each(['search', 'effort'])(
      'hides the %s control on the 18rem composer a 320 phone gives',
      async (slot) => {
        await withPage(engine, { width: 320 }, async (page) => {
          const reading = await readComposer(page, { effort: true, modality: 'text' });
          expect(reading.composer.width / reading.rootPx).toBe(18);
          expect(control(reading, slot)).toBeUndefined();
        });
      },
      TEST_MS
    );

    it.each(['search', 'effort'])(
      'keeps the %s control on the wider composer a 390 phone gives',
      async (slot) => {
        await withPage(engine, { width: 390 }, async (page) => {
          const reading = await readComposer(page, { effort: true, modality: 'text' });
          expect(reading.composer.width / reading.rootPx).toBeGreaterThanOrEqual(20);
          expect(control(reading, slot)).toBeDefined();
        });
      },
      TEST_MS
    );

    it(
      "keeps every chip's full form on a composer of 34rem",
      async () => {
        await withPage(engine, { width: 1440 }, async (page) => {
          const reading = await readChips(page, 34);
          expect(requireControl(reading, 'search').shownText).toBe('Search');
          expect(requireControl(reading, 'model').shownText).toBe('Claude Sonnet 4.5');
          expect(control(reading, 'estimate')).toBeDefined();
          expect(reading.barGapPx).toBeCloseTo(0.375 * reading.rootPx, 1);
          expect(reading.barPaddingInlinePx).toBeCloseTo(0.5 * reading.rootPx, 1);
        });
      },
      TEST_MS
    );

    it.each([20.25, 21, 22, 24, 34])(
      'holds one row at %srem, the model name truncated to make room',
      async (widthRem) => {
        await withPage(engine, { width: 1440 }, async (page) => {
          const reading = await readChips(page, widthRem);
          expect(reading.rows).toBe(1);
          expect(requireControl(reading, 'model').truncated).toBe(true);
        });
      },
      TEST_MS
    );

    it(
      'falls back to a second line when even the swatch and Send cannot share the row',
      async () => {
        await withPage(engine, { width: 1440 }, async (page) => {
          const reading = await readChips(page, 11);
          expect(reading.rows).toBe(2);
          expect(inside(requireControl(reading, 'send').box, reading.field)).toBe(true);
          expect(overlappingPairs(reading)).toEqual([]);
        });
      },
      TEST_MS
    );

    it(
      'shows the Search chip as its icon alone, in a 2rem square, under 34rem',
      async () => {
        await withPage(engine, { width: 1440 }, async (page) => {
          const reading = await readChips(page, 33.75);
          const search = requireControl(reading, 'search');
          expect(search.shownText).toBe('');
          expect(search.box.width).toBeCloseTo(2 * reading.rootPx, 0);
        });
      },
      TEST_MS
    );

    it(
      "shows the model chip's short name under 34rem",
      async () => {
        await withPage(engine, { width: 1440 }, async (page) => {
          const reading = await readChips(page, 33.75);
          expect(requireControl(reading, 'model').shownText).toBe('Sonnet 4.5');
        });
      },
      TEST_MS
    );

    it(
      'takes the estimate out of the bar under 34rem',
      async () => {
        await withPage(engine, { width: 1440 }, async (page) => {
          const reading = await readChips(page, 33.75);
          expect(control(reading, 'estimate')).toBeUndefined();
        });
      },
      TEST_MS
    );

    it(
      "tightens the bar's spacing to 0.25rem gaps and 0.375rem sides under 34rem",
      async () => {
        await withPage(engine, { width: 1440 }, async (page) => {
          const reading = await readChips(page, 33.75);
          expect(reading.barGapPx).toBeCloseTo(0.25 * reading.rootPx, 1);
          expect(reading.barPaddingInlinePx).toBeCloseTo(0.375 * reading.rootPx, 1);
        });
      },
      TEST_MS
    );

    it(
      "keeps the mode chip's label on a composer of 20.5rem",
      async () => {
        await withPage(engine, { width: 1440 }, async (page) => {
          const reading = await readChips(page, 20.5);
          const labelled = reading.controls.find((entry) => entry.name === 'Image');
          expect(labelled?.shownText).toBe('Image');
        });
      },
      TEST_MS
    );

    it(
      'shows the mode chip as its icon alone, in a 2rem square, under 20.5rem',
      async () => {
        await withPage(engine, { width: 1440 }, async (page) => {
          const reading = await readChips(page, 20.25);
          const modeChips = reading.controls.filter((entry) => entry.slot === 'mode');
          expect(modeChips.map((entry) => entry.shownText)).toEqual(['', '']);
          for (const chip of modeChips) expect(chip.box.width).toBeCloseTo(2 * reading.rootPx, 0);
        });
      },
      TEST_MS
    );

    it(
      'keeps only the mode chips, the model chip and Send under 20rem',
      async () => {
        await withPage(engine, { width: 1440 }, async (page) => {
          const reading = await readChips(page, 19.75);
          expect(reading.controls.map((entry) => entry.slot)).toEqual([
            'mode',
            'mode',
            'model',
            'send',
          ]);
        });
      },
      TEST_MS
    );

    it(
      'keeps every chip inside the field under 20rem',
      async () => {
        await withPage(engine, { width: 1440 }, async (page) => {
          const reading = await readChips(page, 19.75);
          for (const entry of reading.controls) expect(inside(entry.box, reading.field)).toBe(true);
          expect(overlappingPairs(reading)).toEqual([]);
        });
      },
      TEST_MS
    );
  });
});
