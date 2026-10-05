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
import { TEST_IDS } from '@hushbox/shared';
import { startFixtureServer, type FixtureServer } from '@/test-utils/fixture-server';
import type { Plugin } from 'vite';

/**
 * Measures the new chat page in real engines: where its composer sits, and whether anything
 * that loads, opens or grows below it moves it. Both depend on the page's real layout under
 * the app stylesheet at a real viewport, which no test DOM computes.
 *
 * The fixture mounts the real page in a stand-in for the app shell, with the catalog, the
 * conversation list and the predictor's candidates each answered when a test says so.
 * Chromium and Firefox, the engines CI installs, each with a mouse and under touch
 * emulation, which reaches the `pointer: coarse` media query the touch layout keys on.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, 'chat-welcome-fixture');
const SRC_DIR = path.resolve(HERE, '../../..');
const COMPOSER_FIXTURE_DIR = path.resolve(HERE, '../input/composer-bar-fixture');

/** The first load compiles the app's whole stylesheet, which a busy machine can make slow. */
const LOAD_MS = 90_000;
const TEST_MS = LOAD_MS + 60_000;

/**
 * Layout lands on sub-pixel units that do not all convert to binary fractions exactly, so
 * two readings of an unmoved box can differ by a hair.
 */
const SUBPIXEL_SLACK = 0.5;
/** Two blocks' movements compared against each other carry each block's rounding. */
const BLOCK_SLACK = 1;

type EngineName = 'chromium' | 'firefox';
const ENGINES: readonly EngineName[] = ['chromium', 'firefox'];
type Pointer = 'fine' | 'coarse';
const POINTERS: readonly Pointer[] = ['fine', 'coarse'];

interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

interface WelcomeReading {
  coarse: boolean;
  scroller: Box;
  scrollTop: number;
  composer: Box;
  modelChip: Box;
  candidateList: Box | null;
  candidateRows: number;
  suggestions: Box;
  continueShown: boolean;
  modelInfoShown: boolean;
}

interface MountOptions {
  signedIn: boolean;
  sidebar: boolean;
}

declare global {
  var __chatWelcome:
    | {
        mount(options: MountOptions): void;
        resolveCatalog(): void;
        resolveConversations(): void;
        answerCandidates(count: number): void;
        read(): WelcomeReading;
      }
    | undefined;
}

interface Viewport {
  width: number;
  height: number;
  /** Docks the 18rem sidebar beside the page, as a tablet holds it open. */
  sidebar?: boolean;
}

/** The sizes the candidate list must not move the composer at. */
const CANDIDATE_LIST_VIEWPORTS: readonly Viewport[] = [
  { width: 1280, height: 720 },
  { width: 1366, height: 768 },
  { width: 393, height: 659 },
  { width: 412, height: 839 },
  { width: 834, height: 1194, sidebar: true },
];

/** The phone sizes the late-loading blocks must not move the composer at. */
const LATE_LOAD_VIEWPORTS: readonly Viewport[] = [
  { width: 375, height: 667 },
  { width: 390, height: 844 },
];

/** The sizes from 768 where the composer's top is placed at a third of the page body. */
const ONE_THIRD_VIEWPORTS: readonly Viewport[] = [
  { width: 1280, height: 720 },
  { width: 1366, height: 768 },
  { width: 834, height: 1194, sidebar: true },
];

const TYPED = 'Write a short poem about';

/** Stubbed data hooks: each alias swaps one module the page reads for a stand-in. */
const STUBS: readonly (readonly [RegExp, string])[] = [
  [/^@\/hooks\/models\/models(\.js)?$/, path.join(FIXTURE_DIR, 'catalog-stub.ts')],
  [
    /^@\/components\/chat\/model-selector\/model-selector-modal$/,
    path.join(FIXTURE_DIR, 'model-selector-modal-stub.ts'),
  ],
  [
    /^@\/hooks\/billing\/use-prompt-budget$/,
    path.join(COMPOSER_FIXTURE_DIR, 'prompt-budget-stub.ts'),
  ],
  [
    /^@\/hooks\/models\/use-payer-premium-access(\.js)?$/,
    path.join(COMPOSER_FIXTURE_DIR, 'payer-premium-access-stub.ts'),
  ],
  [
    /^@\/hooks\/chat\/use-reasoning-effort$/,
    path.join(COMPOSER_FIXTURE_DIR, 'reasoning-effort-stub.ts'),
  ],
  [/^@\/providers\/stability-provider$/, path.join(COMPOSER_FIXTURE_DIR, 'stability-stub.ts')],
  [
    /^@\/components\/chat\/budget\/composer-messages$/,
    path.join(COMPOSER_FIXTURE_DIR, 'composer-messages-stub.ts'),
  ],
];

/** The conversation list is swapped for the Continue list alone; its module serves the app. */
function continueListConversations(): Plugin {
  const continueList = path.join(HERE, 'continue-list.tsx');
  // The alias plugin runs ahead of every other, so the specifier arrives already resolved.
  const conversations = path.join(SRC_DIR, 'hooks', 'chat', 'chat');
  return {
    name: 'chat-welcome-continue-conversations',
    enforce: 'pre',
    resolveId(source, importer) {
      return source === conversations && importer === continueList
        ? path.join(FIXTURE_DIR, 'conversations-stub.ts')
        : undefined;
    },
  };
}

function contextFor(
  engine: EngineName,
  viewport: Viewport,
  pointer: Pointer
): BrowserContextOptions {
  const touch = pointer === 'coarse';
  return {
    viewport: { width: viewport.width, height: viewport.height },
    // Motion is reduced so every reading is of settled boxes, never of a block mid-animation.
    reducedMotion: 'reduce',
    hasTouch: touch,
    // Firefox has no mobile emulation; its touch emulation alone reaches the coarse pointer.
    ...(engine === 'chromium' && touch ? { isMobile: true } : {}),
  };
}

function label(viewport: Viewport): string {
  return `${String(viewport.width)}x${String(viewport.height)}${viewport.sidebar === true ? ' with the sidebar docked' : ''}`;
}

function moved(before: Box, after: Box): number {
  return Math.max(
    Math.abs(after.top - before.top),
    Math.abs(after.bottom - before.bottom),
    Math.abs(after.left - before.left),
    Math.abs(after.right - before.right)
  );
}

function heightOf(box: Box | null): number {
  return box === null ? 0 : box.bottom - box.top;
}

async function mountPage(page: Page, options: MountOptions): Promise<void> {
  await page.evaluate((mount) => {
    if (__chatWelcome === undefined) throw new Error('__chatWelcome not ready');
    __chatWelcome.mount(mount);
  }, options);
  await page.getByTestId(TEST_IDS.suggestionChips).waitFor({ timeout: LOAD_MS });
}

async function call(page: Page, action: 'resolveCatalog' | 'resolveConversations'): Promise<void> {
  await page.evaluate((name) => {
    if (__chatWelcome === undefined) throw new Error('__chatWelcome not ready');
    __chatWelcome[name]();
  }, action);
}

async function answerCandidates(page: Page, count: number): Promise<void> {
  await page.evaluate((answered) => {
    if (__chatWelcome === undefined) throw new Error('__chatWelcome not ready');
    __chatWelcome.answerCandidates(answered);
  }, count);
}

async function readOnce(page: Page): Promise<WelcomeReading> {
  return page.evaluate(() => {
    if (__chatWelcome === undefined) throw new Error('__chatWelcome not ready');
    return __chatWelcome.read();
  });
}

/** A reading once two taken a frame apart agree, so nothing is still laying out. */
async function settledRead(page: Page): Promise<WelcomeReading> {
  let previous = await readOnce(page);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await page.evaluate(
      async () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 50);
        })
    );
    const next = await readOnce(page);
    if (JSON.stringify(next) === JSON.stringify(previous)) return next;
    previous = next;
  }
  throw new Error(`the page never settled: ${JSON.stringify(previous)}`);
}

describe('new chat page geometry (real browser)', () => {
  let server: FixtureServer;
  const browsers: Partial<Record<EngineName, Browser>> = {};

  beforeAll(async () => {
    server = await startFixtureServer({
      root: FIXTURE_DIR,
      plugins: [continueListConversations(), react(), tailwindcss()],
      resolve: {
        alias: [
          ...STUBS.map(([find, replacement]) => ({ find, replacement })),
          { find: /^@\/(.*)$/, replacement: path.join(SRC_DIR, '$1') },
        ],
      },
    });
    const [chromiumBrowser, firefoxBrowser] = await Promise.all([
      chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] }),
      firefox.launch(),
    ]);
    browsers.chromium = chromiumBrowser;
    browsers.firefox = firefoxBrowser;
  }, 120_000);

  // The server's close starts beside the browsers', so a stalled browser close cannot keep
  // the server from removing its cache folder within its budget.
  afterAll(async () => {
    await Promise.all([
      ...Object.values(browsers).map((browser) => browser.close()),
      server.close(),
    ]);
  }, LOAD_MS);

  async function withPage<T>(
    engine: EngineName,
    viewport: Viewport,
    pointer: Pointer,
    use: (page: Page) => Promise<T>
  ): Promise<T> {
    const browser = browsers[engine];
    if (browser === undefined) throw new Error(`${engine} did not launch`);
    const context = await browser.newContext(contextFor(engine, viewport, pointer));
    try {
      const page = await context.newPage();
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      await page.goto(`${server.url}/chat-welcome.html`, { waitUntil: 'commit', timeout: LOAD_MS });
      await page
        .waitForFunction(() => globalThis.__chatWelcome !== undefined, undefined, {
          timeout: LOAD_MS,
        })
        .catch((error: unknown) => {
          throw new Error(`the fixture never loaded; page errors: ${pageErrors.join(' | ')}`, {
            cause: error,
          });
        });
      await page.evaluate(() => document.fonts.ready);
      return await use(page);
    } finally {
      await context.close();
    }
  }

  describe.each(ENGINES)('on %s', (engine) => {
    describe.each(POINTERS)('with a %s pointer', (pointer) => {
      it.each(CANDIDATE_LIST_VIEWPORTS.map((viewport) => [label(viewport), viewport] as const))(
        'holds the composer still while the candidate list opens beneath it at %s',
        async (_label, viewport) => {
          await withPage(engine, viewport, pointer, async (page) => {
            await mountPage(page, { signedIn: true, sidebar: viewport.sidebar === true });
            await call(page, 'resolveCatalog');
            await call(page, 'resolveConversations');
            await page.getByTestId(TEST_IDS.continueList).waitFor({ timeout: LOAD_MS });
            await page.getByRole('textbox').fill(TYPED);
            await page.locator('[data-slot="prediction-text"]').waitFor({ timeout: LOAD_MS });
            const closed = await settledRead(page);
            expect(closed.coarse).toBe(pointer === 'coarse');
            expect(closed.candidateRows).toBe(0);

            await answerCandidates(page, 4);
            await page
              .locator('[data-slot="prediction-suggestion-row"]')
              .nth(3)
              .waitFor({ timeout: LOAD_MS });
            const open = await settledRead(page);

            expect(open.candidateRows).toBe(4);
            expect(moved(closed.composer, open.composer)).toBeLessThanOrEqual(SUBPIXEL_SLACK);
            expect(open.candidateList).not.toBeNull();
            const listGrowth = heightOf(open.candidateList) - heightOf(closed.candidateList);
            expect(listGrowth).toBeGreaterThan(0);
            expect(
              Math.abs(open.suggestions.top - closed.suggestions.top - listGrowth)
            ).toBeLessThanOrEqual(BLOCK_SLACK);
          });
        },
        TEST_MS
      );

      it.each(LATE_LOAD_VIEWPORTS.map((viewport) => [label(viewport), viewport] as const))(
        'holds the composer and the model chip still while the page finishes loading at %s',
        async (_label, viewport) => {
          await withPage(engine, viewport, pointer, async (page) => {
            await mountPage(page, { signedIn: true, sidebar: false });
            const first = await settledRead(page);
            expect(first.coarse).toBe(pointer === 'coarse');
            expect(first.continueShown).toBe(false);
            expect(first.modelInfoShown).toBe(false);

            await call(page, 'resolveConversations');
            await page.getByTestId(TEST_IDS.continueList).waitFor({ timeout: LOAD_MS });
            const withContinue = await settledRead(page);

            await call(page, 'resolveCatalog');
            await page
              .locator(`[data-testid="${TEST_IDS.modelInfo}"]:not([aria-hidden="true"])`)
              .waitFor({ timeout: LOAD_MS });
            const loaded = await settledRead(page);

            expect(moved(first.composer, withContinue.composer)).toBeLessThanOrEqual(
              SUBPIXEL_SLACK
            );
            expect(moved(first.modelChip, withContinue.modelChip)).toBeLessThanOrEqual(
              SUBPIXEL_SLACK
            );
            expect(moved(withContinue.composer, loaded.composer)).toBeLessThanOrEqual(
              SUBPIXEL_SLACK
            );
            expect(moved(withContinue.modelChip, loaded.modelChip)).toBeLessThanOrEqual(
              SUBPIXEL_SLACK
            );
          });
        },
        TEST_MS
      );
    });

    it.each(
      ONE_THIRD_VIEWPORTS.flatMap((viewport) =>
        (['a visitor', 'an account with recent chats'] as const).map(
          (reader) => [reader, label(viewport), viewport] as const
        )
      )
    )(
      "places the composer's top a third of the way down the page body for %s at %s",
      async (reader, _label, viewport) => {
        await withPage(engine, viewport, 'fine', async (page) => {
          const signedIn = reader !== 'a visitor';
          await mountPage(page, { signedIn, sidebar: viewport.sidebar === true });
          await call(page, 'resolveCatalog');
          if (signedIn) {
            await call(page, 'resolveConversations');
            await page.getByTestId(TEST_IDS.continueList).waitFor({ timeout: LOAD_MS });
          }
          const reading = await settledRead(page);
          const bodyHeight = reading.scroller.bottom - reading.scroller.top;
          expect(reading.scrollTop).toBe(0);
          expect(
            Math.abs(reading.composer.top - reading.scroller.top - bodyHeight / 3)
          ).toBeLessThanOrEqual(SUBPIXEL_SLACK);
        });
      },
      TEST_MS
    );

    it.each(LATE_LOAD_VIEWPORTS.map((viewport) => [label(viewport), viewport] as const))(
      'starts the page at the top of its body below 768 at %s',
      async (_label, viewport) => {
        await withPage(engine, viewport, 'fine', async (page) => {
          await mountPage(page, { signedIn: false, sidebar: false });
          await call(page, 'resolveCatalog');
          const reading = await settledRead(page);
          const greetingTop = await page
            .getByRole('heading', { level: 1 })
            .evaluate((heading) => heading.getBoundingClientRect().top);
          // The stack's own top padding is at most 2rem; a centred stack sits far lower.
          expect(greetingTop - reading.scroller.top).toBeLessThanOrEqual(32 + SUBPIXEL_SLACK);
        });
      },
      TEST_MS
    );
  });
});
