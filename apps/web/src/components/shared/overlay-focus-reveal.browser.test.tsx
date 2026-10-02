import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, firefox, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { startFixtureServer, type FixtureServer } from '@/test-utils/fixture-server';
import { ROW_COUNT, rowLabel } from './overlay-focus-reveal-fixture/overlay-focus-reveal-rows';

/**
 * Drives the real `Overlay` (packages/ui/src/components/overlay/) in Chromium and Firefox, under
 * the app stylesheet, and checks that a focus-trap wrap lands on a control the user can see.
 * Radix's trap moves focus on both wrap edges with `preventScroll`, so in a list taller than the
 * overlay the control it lands on stays out of view unless the overlay reveals it; happy-dom has
 * no layout, so only a real engine can tell the two apart.
 *
 * The harness is a fixture server started through `startFixtureServer`
 * (`src/test-utils/fixture-server.ts`) plus `@playwright/test`, launched from ordinary Vitest,
 * serving the fixture page in `overlay-focus-reveal-fixture/`.
 */

const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'overlay-focus-reveal-fixture'
);

const PAGE_PATH = '/overlay-focus-reveal.html';

const FIRST_ROW = rowLabel(0);
const LAST_ROW = rowLabel(ROW_COUNT - 1);

type EngineName = 'chromium' | 'firefox';
const ENGINES: readonly EngineName[] = ['chromium', 'firefox'];

type Presentation = 'dialog' | 'sheet';
type Shape = 'list' | 'picker';

// The overlay presents by width alone: a dialog from 768px, a sheet below it.
const VIEWPORTS: Readonly<Record<Presentation, { width: number; height: number }>> = {
  dialog: { width: 768, height: 1024 },
  sheet: { width: 375, height: 812 },
};

const FIRST_CONTROL: Readonly<Record<Shape, string>> = { list: FIRST_ROW, picker: 'Close' };

// A page loads the whole ui barrel, several hundred modules, and the first load also optimizes
// its dependencies into a cold cache, so on a host busy with other suites each step can take far
// longer than on an idle one. The budgets bound waiting and decide nothing.
const PAGE_READY_MS = 90_000;
// Two warm-up loads, one per engine, each a navigation and a wait for the dialog, plus the launch.
const WARM_UP_MS = 2 * 2 * PAGE_READY_MS + 60_000;
// One page open, a navigation and a wait for the dialog, plus the keys pressed on it.
const CASE_MS = 2 * PAGE_READY_MS + 30_000;
// The fixture server's close gets most of the teardown; the rest is kept for removing its cache.
const CLOSE_MS = 45_000;
const TEARDOWN_MS = CLOSE_MS + 15_000;

interface Placement {
  label: string | null;
  inView: boolean;
}

/** Resolves once no animation is running, so every box read after it is at rest. */
async function settle(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => animation.playState !== 'running')
  );
}

function fixtureUrl(origin: string, fixture: { shape: Shape; initialFocus?: number }): string {
  const query = new URLSearchParams({ shape: fixture.shape });
  if (fixture.initialFocus !== undefined) query.set('initialFocus', String(fixture.initialFocus));
  return `${origin}${PAGE_PATH}?${query.toString()}`;
}

/** Opens a page on the fixture and resolves once the overlay is open and at rest. */
async function openFixture(
  context: BrowserContext,
  url: string,
  viewport: { width: number; height: number }
): Promise<Page> {
  const page = await context.newPage();
  await page.setViewportSize(viewport);
  await page.goto(url, { waitUntil: 'commit', timeout: PAGE_READY_MS });
  await page.getByRole('dialog').waitFor({ timeout: PAGE_READY_MS });
  await settle(page);
  return page;
}

/**
 * Rests focus on a control the user can see, as a Tab that reached it would. Focusing a control
 * that already holds focus scrolls nothing, so the reveal is asked for outright.
 */
async function focusControl(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name, exact: true }).evaluate((control) => {
    control.focus();
    control.scrollIntoView({ block: 'nearest' });
  });
  await settle(page);
}

/**
 * Names the focused control and says whether its box lies inside the viewport and inside every
 * ancestor that clips, up to the body, whose own clipping the viewport stands for.
 */
async function focusedPlacement(page: Page): Promise<Placement> {
  return page.evaluate(() => {
    const focused = document.activeElement;
    if (!(focused instanceof HTMLElement)) return { label: null, inView: false };
    const box = focused.getBoundingClientRect();
    const clips = [{ top: 0, left: 0, bottom: window.innerHeight, right: window.innerWidth }];
    for (
      let ancestor = focused.parentElement;
      ancestor !== null && ancestor !== document.body;
      ancestor = ancestor.parentElement
    ) {
      const style = getComputedStyle(ancestor);
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
      const outer = ancestor.getBoundingClientRect();
      const top = outer.top + ancestor.clientTop;
      const left = outer.left + ancestor.clientLeft;
      clips.push({
        top,
        left,
        bottom: top + ancestor.clientHeight,
        right: left + ancestor.clientWidth,
      });
    }
    const tolerance = 1;
    const inView = clips.every(
      (clip) =>
        box.top >= clip.top - tolerance &&
        box.bottom <= clip.bottom + tolerance &&
        box.left >= clip.left - tolerance &&
        box.right <= clip.right + tolerance
    );
    return { label: focused.textContent, inView };
  });
}

const WRAP_CASES = ENGINES.flatMap((engine) =>
  (['dialog', 'sheet'] as const).flatMap((presentation) =>
    (['list', 'picker'] as const).map((shape) => ({ engine, presentation, shape }))
  )
);

describe('overlay focus reveal (real browser)', () => {
  let server: FixtureServer | undefined;
  const browsers: Browser[] = [];
  // One context per engine, so its pages share one HTTP cache and only the first pays for the
  // barrel's optimized dependencies.
  const contexts: Partial<Record<EngineName, BrowserContext>> = {};

  function requireContext(engine: EngineName): BrowserContext {
    const context = contexts[engine];
    if (context === undefined) throw new Error(`${engine} did not launch`);
    return context;
  }

  function requireServer(): FixtureServer {
    if (server === undefined) throw new Error('the fixture server did not start');
    return server;
  }

  beforeAll(async () => {
    server = await startFixtureServer({
      root: FIXTURE_DIR,
      configFile: false,
      plugins: [react(), tailwindcss()],
      resolve: {
        alias: [{ find: /^@\/(.*)$/, replacement: path.resolve(FIXTURE_DIR, '../../..', '$1') }],
      },
      watch: null,
      closeBudgetMs: CLOSE_MS,
    });
    const [chromiumBrowser, firefoxBrowser] = await Promise.all([
      chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] }),
      firefox.launch(),
    ]);
    browsers.push(chromiumBrowser, firefoxBrowser);
    contexts.chromium = await chromiumBrowser.newContext();
    contexts.firefox = await firefoxBrowser.newContext();
    // The first load optimizes the fixture's dependencies into the fresh cache and fills each
    // engine's HTTP cache; paying for both here keeps them out of every test's own time.
    const warmUpUrl = fixtureUrl(requireServer().url, { shape: 'list' });
    const chromiumWarmUp = await openFixture(
      requireContext('chromium'),
      warmUpUrl,
      VIEWPORTS.dialog
    );
    await chromiumWarmUp.close();
    const firefoxWarmUp = await openFixture(requireContext('firefox'), warmUpUrl, VIEWPORTS.dialog);
    await firefoxWarmUp.close();
  }, WARM_UP_MS);

  afterAll(async () => {
    await Promise.all([
      ...browsers.map((browser) => browser.close()),
      ...(server === undefined ? [] : [server.close()]),
    ]);
  }, TEARDOWN_MS);

  it.each(WRAP_CASES)(
    'lands both wrap edges in view in the $presentation holding a $shape, on $engine',
    async ({ engine, presentation, shape }) => {
      const page = await openFixture(
        requireContext(engine),
        fixtureUrl(requireServer().url, { shape }),
        VIEWPORTS[presentation]
      );
      try {
        const first = FIRST_CONTROL[shape];

        await focusControl(page, first);
        await page.keyboard.press('Shift+Tab');
        await settle(page);
        const shiftTabFromFirst = await focusedPlacement(page);

        await focusControl(page, LAST_ROW);
        await page.keyboard.press('Tab');
        await settle(page);
        const tabFromLast = await focusedPlacement(page);

        expect({ shiftTabFromFirst, tabFromLast }).toEqual({
          shiftTabFromFirst: { label: LAST_ROW, inView: true },
          tabFromLast: { label: first, inView: true },
        });
      } finally {
        await page.close();
      }
    },
    CASE_MS
  );

  it.each(ENGINES)(
    'leaves the list unscrolled when the dialog opens on a row below the fold, on %s',
    async (engine) => {
      const initialFocus = 29;
      const page = await openFixture(
        requireContext(engine),
        fixtureUrl(requireServer().url, { shape: 'list', initialFocus }),
        VIEWPORTS.dialog
      );
      try {
        const opened = await page.evaluate(() => {
          const focused = document.activeElement;
          let scrolled = 0;
          for (let ancestor = focused?.parentElement; ancestor; ancestor = ancestor.parentElement) {
            scrolled = Math.max(scrolled, ancestor.scrollTop);
          }
          return { label: focused?.textContent ?? null, scrolled };
        });

        expect(opened).toEqual({ label: rowLabel(initialFocus), scrolled: 0 });
      } finally {
        await page.close();
      }
    },
    CASE_MS
  );
});
