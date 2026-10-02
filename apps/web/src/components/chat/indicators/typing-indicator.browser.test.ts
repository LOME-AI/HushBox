import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, firefox, type Browser, type BrowserContext } from '@playwright/test';
import { startFixtureServer, type FixtureServer } from '@/test-utils/fixture-server';

/**
 * Lays a group member's typing line out in real engines, above the input dock and its
 * composer, under the app's own stylesheet: the space from the line's text to the context
 * gauge on the composer's top edge is 1rem at every text size. It rests on the dock's padding,
 * the gauge's rise above the composer and the line's own margin, which the DOM the unit tests
 * run in never lays out, and the margin is keyed off the composer's top-edge slot by name, so
 * a control renames that slot and must lose the 1rem.
 */

const DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(DIRECTORY, 'typing-indicator-fixture');
const SRC_DIR = path.resolve(DIRECTORY, '../../..');
const COMPOSER_STUBS_DIR = path.resolve(DIRECTORY, '../input/composer-bar-fixture');

/** The first load compiles the app's whole stylesheet, which a busy machine can make slow. */
const LOAD_MS = 90_000;
const TEST_MS = LOAD_MS * 2;
const CLOSE_MS = 45_000;
/** The stylesheet's first compile, which a loaded machine can stretch past a page load's budget. */
const WARM_MS = LOAD_MS * 3;

/** Sub-pixel layout rounding the comparison forgives. */
const EDGE_TOLERANCE_PX = 0.5;

/** The composer's data hooks, swapped for the composer bar fixture's stubs. */
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

interface Measured {
  rootPx: number;
  gapPx: number;
}

interface View {
  label: string;
  viewport: number;
  scale?: string;
  theme?: 'dark';
}

const VIEWS: readonly View[] = [
  { label: '1440', viewport: 1440 },
  { label: '375 in dark', viewport: 375, theme: 'dark' },
  { label: '1440 with 141% text', viewport: 1440, scale: '141' },
  { label: '375 with 141% text', viewport: 375, scale: '141' },
];

const ENGINES = ['chromium', 'firefox'] as const;
type EngineName = (typeof ENGINES)[number];

/** How far the gap sits from 1rem, in pixels. */
function missByPx({ rootPx, gapPx }: Measured): number {
  return Math.abs(gapPx - rootPx);
}

describe('typing line above the composer (real browser)', () => {
  let server: FixtureServer;
  const browsers: Partial<Record<EngineName, Browser>> = {};
  const contexts: Partial<Record<EngineName, BrowserContext>> = {};

  beforeAll(
    async () => {
      server = await startFixtureServer({
        root: FIXTURE_DIR,
        configFile: false,
        plugins: [react(), tailwindcss()],
        resolve: {
          alias: [
            ...STUBS.map(([specifier, stub]) => ({
              find: new RegExp(`^${escapeForPattern(specifier)}$`),
              replacement: path.join(COMPOSER_STUBS_DIR, stub),
            })),
            { find: /^@\/(.*)$/, replacement: path.join(SRC_DIR, '$1') },
          ],
        },
        watch: null,
        closeBudgetMs: CLOSE_MS,
      });
      const [chromiumBrowser, firefoxBrowser] = await Promise.all([
        chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] }),
        firefox.launch(),
      ]);
      browsers.chromium = chromiumBrowser;
      browsers.firefox = firefoxBrowser;
      // One context per engine shares its cache across the cases, and loading the page once
      // here keeps the stylesheet's first compile out of the first measured case.
      for (const engine of ENGINES) {
        const context = await (
          engine === 'chromium' ? chromiumBrowser : firefoxBrowser
        ).newContext();
        contexts[engine] = context;
        const warm = await context.newPage();
        try {
          await warm.goto(`${server.url}/typing-indicator.html`, {
            waitUntil: 'commit',
            timeout: WARM_MS,
          });
          await warm.waitForFunction(() => globalThis.__typingIndicator !== undefined, undefined, {
            timeout: WARM_MS,
          });
        } finally {
          await warm.close();
        }
      }
    },
    TEST_MS + WARM_MS * 2
  );

  afterAll(async () => {
    await Promise.all(Object.values(browsers).map((browser) => browser.close()));
    await server.close();
  }, CLOSE_MS + 15_000);

  async function measure(
    engine: EngineName,
    { viewport, scale, theme }: View,
    slot: 'kept' | 'renamed'
  ): Promise<Measured> {
    const context = contexts[engine];
    if (context === undefined) throw new Error(`${engine} did not launch`);
    const page = await context.newPage();
    try {
      await page.setViewportSize({ width: viewport, height: 900 });
      const query = new URLSearchParams();
      if (scale !== undefined) query.set('scale', scale);
      if (theme !== undefined) query.set('theme', theme);
      if (slot === 'renamed') query.set('slot', 'renamed');
      await page.goto(`${server.url}/typing-indicator.html?${query.toString()}`, {
        waitUntil: 'commit',
        timeout: LOAD_MS,
      });
      await page.waitForFunction(
        () =>
          globalThis.__typingIndicator !== undefined &&
          document.fonts.status === 'loaded' &&
          document.querySelector('[role="meter"]') !== null,
        undefined,
        { timeout: LOAD_MS }
      );
      return await page.evaluate(() => {
        if (__typingIndicator === undefined) throw new Error('__typingIndicator not ready');
        return __typingIndicator.measure();
      });
    } finally {
      await page.close();
    }
  }

  describe.each(ENGINES)('in %s', (engine) => {
    it.each(VIEWS)(
      'clears the context gauge by 1rem at $label',
      async (view) => {
        expect(missByPx(await measure(engine, view, 'kept'))).toBeLessThanOrEqual(
          EDGE_TOLERANCE_PX
        );
      },
      TEST_MS
    );

    it(
      "loses the 1rem once the composer's top-edge slot is renamed",
      async () => {
        const control = await measure(engine, { label: '1440', viewport: 1440 }, 'renamed');
        expect(missByPx(control)).toBeGreaterThan(EDGE_TOLERANCE_PX);
      },
      TEST_MS
    );
  });
});
