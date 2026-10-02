import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, firefox, type Browser, type BrowserContext } from '@playwright/test';
import { TEST_IDS } from '@hushbox/shared';
import { startFixtureServer, type FixtureServer } from '@/test-utils/fixture-server';

/**
 * Lays the member pane's body out in a real engine, under the app's own stylesheet, with a
 * row's options menu open: whether each online avatar's ring is drawn whole inside the body,
 * whether the body can scroll sideways, and whether every group label starts inside the pane.
 * All three rest on the body's inset, which the DOM the unit tests run in never lays out, so
 * each is also measured against a control with the inset stripped, which must fail.
 */

const DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(DIRECTORY, 'member-sidebar-body-fixture');
const SRC_DIR = path.resolve(DIRECTORY, '../../..');

/** The first load compiles the app's whole stylesheet, which a busy machine can make slow. */
const LOAD_MS = 90_000;
const TEST_MS = LOAD_MS * 2;
const CLOSE_MS = 45_000;
/** The stylesheet's first compile, which a loaded machine can stretch past a page load's budget. */
const WARM_MS = LOAD_MS * 3;

/** Sub-pixel layout rounding the comparison forgives. */
const EDGE_TOLERANCE_PX = 0.5;

interface Measured {
  rings: { left: number; right: number; bodyLeft: number; bodyRight: number }[];
  sidewaysOverflow: number;
  scrollLeft: number;
  labels: { text: string; left: number; paneLeft: number }[];
}

interface View {
  label: string;
  viewport: number;
  scale?: string;
}

const VIEWS: readonly View[] = [
  { label: '320', viewport: 320 },
  { label: '1440', viewport: 1440 },
  { label: '320 with 141% text', viewport: 320, scale: '141' },
];

const ENGINES = ['chromium', 'firefox'] as const;
type EngineName = (typeof ENGINES)[number];

function ringsWhole({ rings }: Measured): boolean {
  return rings.every(
    (ring) =>
      ring.left >= ring.bodyLeft - EDGE_TOLERANCE_PX &&
      ring.right <= ring.bodyRight + EDGE_TOLERANCE_PX
  );
}

function scrollsSideways({ sidewaysOverflow, scrollLeft }: Measured): boolean {
  return sidewaysOverflow > 0 || scrollLeft > 0;
}

function labelsInside({ labels }: Measured): boolean {
  return labels.every((label) => label.left >= label.paneLeft - EDGE_TOLERANCE_PX);
}

describe('member pane body (real browser)', () => {
  let server: FixtureServer;
  const browsers: Partial<Record<EngineName, Browser>> = {};
  const contexts: Partial<Record<EngineName, BrowserContext>> = {};

  beforeAll(
    async () => {
      server = await startFixtureServer({
        root: FIXTURE_DIR,
        configFile: false,
        plugins: [react(), tailwindcss()],
        resolve: { alias: [{ find: /^@\/(.*)$/, replacement: path.join(SRC_DIR, '$1') }] },
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
          await warm.goto(`${server.url}/member-sidebar-body.html`, {
            waitUntil: 'commit',
            timeout: WARM_MS,
          });
          await warm.waitForFunction(() => globalThis.__memberBody !== undefined, undefined, {
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

  async function measureWithMenuOpen(
    engine: EngineName,
    { viewport, scale }: View,
    inset: 'kept' | 'none'
  ): Promise<Measured> {
    const context = contexts[engine];
    if (context === undefined) throw new Error(`${engine} did not launch`);
    const page = await context.newPage();
    try {
      await page.setViewportSize({ width: viewport, height: 900 });
      const query = new URLSearchParams();
      if (scale !== undefined) query.set('scale', scale);
      if (inset === 'none') query.set('inset', 'none');
      await page.goto(`${server.url}/member-sidebar-body.html?${query.toString()}`, {
        waitUntil: 'commit',
        timeout: LOAD_MS,
      });
      await page.waitForFunction(
        () => globalThis.__memberBody !== undefined && document.fonts.status === 'loaded',
        undefined,
        { timeout: LOAD_MS }
      );
      await page
        .getByTestId(TEST_IDS.memberSidebarContent)
        .locator('[data-testid^="member-actions-"]')
        .last()
        .click();
      await page.getByRole('menu').waitFor({ timeout: LOAD_MS });
      return await page.evaluate(() => {
        if (__memberBody === undefined) throw new Error('__memberBody not ready');
        return __memberBody.measure();
      });
    } finally {
      await page.close();
    }
  }

  const measured = new Map<string, Promise<Measured>>();
  function measureOnce(engine: EngineName, view: View, inset: 'kept' | 'none'): Promise<Measured> {
    const key = JSON.stringify([engine, view.viewport, view.scale, inset]);
    const cached = measured.get(key);
    if (cached !== undefined) return cached;
    const result = measureWithMenuOpen(engine, view, inset);
    measured.set(key, result);
    return result;
  }

  describe.each(ENGINES)('in %s', (engine) => {
    it.each(VIEWS)(
      "draws every online member's ring whole inside the body at $label",
      async (view) => {
        const result = await measureOnce(engine, view, 'kept');
        expect(result.rings.length).toBeGreaterThan(0);
        expect(ringsWhole(result)).toBe(true);
      },
      TEST_MS
    );

    it.each(VIEWS)(
      'keeps the body from scrolling sideways with a row menu open at $label',
      async (view) => {
        expect(scrollsSideways(await measureOnce(engine, view, 'kept'))).toBe(false);
      },
      TEST_MS
    );

    it.each(VIEWS)(
      "starts every group label inside the pane's left edge at $label",
      async (view) => {
        const result = await measureOnce(engine, view, 'kept');
        expect(result.labels.length).toBeGreaterThan(0);
        expect(labelsInside(result)).toBe(true);
      },
      TEST_MS
    );

    it.each(VIEWS)(
      'catches a clipped ring, a sideways scroll and a clipped label once the inset is stripped at $label',
      async (view) => {
        const control = await measureOnce(engine, view, 'none');
        expect(ringsWhole(control)).toBe(false);
        expect(scrollsSideways(control)).toBe(true);
        expect(labelsInside(control)).toBe(false);
      },
      TEST_MS
    );
  });
});
