import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, firefox, type Browser, type Page } from '@playwright/test';
import { startFixtureServer, type FixtureServer } from '@/test-utils/fixture-server';
import type { Plugin } from 'vite';

/**
 * Drives the kit's tables in real engines, under the app stylesheet: whether a table's scroll
 * region is a tab stop depends on whether the table overflows it, which only a layout engine
 * can tell, and the focus outline it draws is the base layer's global rule meeting the
 * region's own classes in the cascade, which no test DOM resolves.
 *
 * Chromium and Firefox, the engines CI installs. `@vitest/browser` is not installed, so this
 * drives `@playwright/test` over a fixture server started through `startFixtureServer`; the
 * page and its entry are virtual modules, so no fixture file joins the tree.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, '../../../..');
const SRC_DIR = path.join(WEB_DIR, 'src');
const SECTION_FILE = path.join(HERE, 'surface.section.tsx');

const ENTRY_ID = 'virtual:surface-entry';
const PAGE_PATH = '/surface.html';

/** The kit's comfortable table, named by its caption. */
const TABLE = 'Purchase history';
/** The width at which the kit table overflows at any text size. */
const NARROW_PX = 180;

/**
 * The budget for a navigation, and again for the page to mount: the first load compiles the
 * app's whole stylesheet. On this host at a load average near 120, the first Firefox navigation
 * took up to about 90 seconds, so the budget is twice that.
 */
const LOAD_MS = 180_000;
/**
 * The budget for state the page's next layout produces: the scroll region's tab stop, which its
 * resize observer sets after layout, and a keyboard scroll. On a loaded machine the renderer or
 * this process has stalled for tens of seconds between two steps, so a wait allows a full stall
 * rather than the few frames an idle machine needs.
 */
const LAYOUT_SETTLE_MS = 60_000;
/**
 * A case's budget covers its worst waits, a load and three layout settles, so a stall fails as
 * the wait that stalled rather than as the case.
 */
const TEST_MS = 2 * LOAD_MS + 3 * LAYOUT_SETTLE_MS + 30_000;
const CLOSE_MS = 45_000;
/**
 * The budget for closing both browsers. On this host at a load average of 50 to 80, closing them
 * outlasted the 15 seconds the teardown used to leave them, so the budget allows a stall of the
 * same length as a layout settle.
 */
const BROWSER_CLOSE_MS = 60_000;
/**
 * The teardown's budget covers its waits, the browsers' close and then the fixture server's, so a
 * stall fails as the close that stalled rather than as the hook.
 */
const TEARDOWN_MS = BROWSER_CLOSE_MS + CLOSE_MS + 15_000;
/** Keyboard steps enough to walk every stop the section holds. */
const TAB_WALK = 12;

const PAGE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>surface</title></head>
  <body>
    <button id="before">Before</button>
    <div id="space"><div id="root"></div></div>
    <span id="ring-probe" style="color: var(--color-ring)">ring</span>
    <script type="module" src="/@id/${ENTRY_ID}"></script>
  </body>
</html>`;

const ENTRY_SOURCE = `
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import '@/app.css';
import section from ${JSON.stringify(SECTION_FILE)};

createRoot(document.getElementById('root')).render(createElement('div', null, section.render()));
globalThis.__surfaceReady = true;
`;

function pageModules(): Plugin {
  return {
    name: 'surface-page',
    resolveId(id) {
      return id === ENTRY_ID ? `\0${id}` : undefined;
    },
    load(id) {
      return id === `\0${ENTRY_ID}` ? ENTRY_SOURCE : undefined;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = request.url;
        if (!url?.startsWith(PAGE_PATH)) {
          next();
          return;
        }
        void (async (): Promise<void> => {
          try {
            const html = await server.transformIndexHtml(url, PAGE_HTML);
            response.setHeader('content-type', 'text/html');
            response.end(html);
          } catch (error) {
            next(error);
          }
        })();
      });
    },
  };
}

declare global {
  var __surfaceReady: boolean | undefined;
}

type EngineName = 'chromium' | 'firefox';
const ENGINES: readonly EngineName[] = ['chromium', 'firefox'];
const THEMES = ['light', 'dark'] as const;

interface Outline {
  style: string;
  width: string;
  offset: string;
  color: string;
  /** The ring token as the same engine resolves it in the same theme. */
  ring: string;
}

async function open(browser: Browser, origin: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${origin}${PAGE_PATH}`, { timeout: LOAD_MS });
  await page.waitForFunction(() => globalThis.__surfaceReady === true, undefined, {
    timeout: LOAD_MS,
  });
  await page.evaluate(() => document.fonts.ready);
  return page;
}

/** Gives the section this many pixels of width, or its full width when null. */
async function setSpace(page: Page, width: number | null): Promise<void> {
  await page.evaluate((width) => {
    const space = document.querySelector<HTMLElement>('#space');
    if (space === null) throw new Error('no space');
    space.style.width = width === null ? '' : `${String(width)}px`;
  }, width);
}

/** Whether the table's scroll region is a tab stop, once layout and its observer have run. */
async function settledStop(page: Page, table: string, expected: boolean): Promise<boolean> {
  await page.waitForFunction(
    ({ table, expected }) => {
      const region = document.querySelector(`[role="group"][aria-label="${table}"]`);
      return region !== null && region.hasAttribute('tabindex') === expected;
    },
    { table, expected },
    { timeout: LAYOUT_SETTLE_MS }
  );
  return expected;
}

async function isStop(page: Page, table: string): Promise<boolean> {
  return page.evaluate(
    (table) =>
      document.querySelector(`[role="group"][aria-label="${table}"]`)?.getAttribute('tabindex') ===
      '0',
    table
  );
}

/** The accessible names of the groups keyboard focus reaches, walking Tab from the page's start. */
async function tabWalk(page: Page): Promise<string[]> {
  await page.focus('#before');
  const reached: string[] = [];
  for (let step = 0; step < TAB_WALK; step += 1) {
    await page.keyboard.press('Tab');
    const name = await page.evaluate(() =>
      document.activeElement?.getAttribute('role') === 'group'
        ? document.activeElement.getAttribute('aria-label')
        : null
    );
    if (name !== null) reached.push(name);
  }
  return reached;
}

/** Tabs to the table's scroll region and reads the outline its keyboard focus draws. */
async function focusedOutline(page: Page, table: string): Promise<Outline> {
  await page.focus('#before');
  for (let step = 0; step < TAB_WALK; step += 1) {
    await page.keyboard.press('Tab');
    const here = await page.evaluate(
      (table) => document.activeElement?.getAttribute('aria-label') === table,
      table
    );
    if (here) break;
  }
  return page.evaluate((table) => {
    const region = document.activeElement;
    if (region?.getAttribute('aria-label') !== table) throw new Error(`${table} took no focus`);
    if (!region.matches(':focus-visible')) throw new Error(`${table} is not keyboard-focused`);
    const style = getComputedStyle(region);
    const probe = document.querySelector('#ring-probe');
    if (probe === null) throw new Error('no ring probe');
    return {
      style: style.outlineStyle,
      width: style.outlineWidth,
      offset: style.outlineOffset,
      color: style.outlineColor,
      ring: getComputedStyle(probe).color,
    };
  }, table);
}

async function setTheme(page: Page, theme: (typeof THEMES)[number]): Promise<void> {
  await page.evaluate((theme) => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, theme);
}

/** The narrowest space the table fits at default text, plus a margin under the text step. */
async function fitWidthAtDefaultText(page: Page, table: string): Promise<number> {
  await setSpace(page, 1);
  const tableWidth = await page.evaluate(
    (table) =>
      document.querySelector(`[role="group"][aria-label="${table}"]`)?.scrollWidth ?? Number.NaN,
    table
  );
  // Borders of the region itself sit outside its scroll width.
  return Math.ceil(tableWidth) + 8;
}

/** Resolves as the work does, or rejects naming the wait once its budget runs out. */
async function within<T>(work: Promise<T>, budgetMs: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const overrun = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${what} did not finish within ${String(budgetMs)}ms`));
    }, budgetMs);
  });
  try {
    return await Promise.race([work, overrun]);
  } finally {
    clearTimeout(timer);
  }
}

describe('the kit tables in a real engine', () => {
  let server: FixtureServer;
  const browsers: Partial<Record<EngineName, Browser>> = {};

  beforeAll(async () => {
    server = await startFixtureServer({
      root: WEB_DIR,
      configFile: false,
      plugins: [react(), tailwindcss(), pageModules()],
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
  }, TEST_MS);

  afterAll(async () => {
    try {
      await within(
        Promise.all(Object.values(browsers).map((browser) => browser.close())),
        BROWSER_CLOSE_MS,
        'closing the browsers'
      );
    } finally {
      await server.close();
    }
  }, TEARDOWN_MS);

  function browserFor(engine: EngineName): Browser {
    const browser = browsers[engine];
    if (browser === undefined) throw new Error(`${engine} did not launch`);
    return browser;
  }

  describe.each(ENGINES)('%s', (engine) => {
    it(
      'leaves a table that fits out of the tab order at 1440',
      async () => {
        const page = await open(browserFor(engine), server.url);
        try {
          expect(await settledStop(page, TABLE, false)).toBe(false);
          expect(await tabWalk(page)).not.toContain(TABLE);
        } finally {
          await page.close();
        }
      },
      TEST_MS
    );

    it(
      'puts a table that overflows its space in the tab order',
      async () => {
        const page = await open(browserFor(engine), server.url);
        try {
          await setSpace(page, NARROW_PX);
          expect(await settledStop(page, TABLE, true)).toBe(true);
          expect(await tabWalk(page)).toContain(TABLE);
        } finally {
          await page.close();
        }
      },
      TEST_MS
    );

    it(
      'gains the tab stop when its space narrows, and loses it when the space widens',
      async () => {
        const page = await open(browserFor(engine), server.url);
        try {
          const readings: boolean[] = [await isStop(page, TABLE)];
          await setSpace(page, NARROW_PX);
          await settledStop(page, TABLE, true);
          readings.push(await isStop(page, TABLE));
          await setSpace(page, null);
          await settledStop(page, TABLE, false);
          readings.push(await isStop(page, TABLE));
          expect(readings).toEqual([false, true, false]);
        } finally {
          await page.close();
        }
      },
      TEST_MS
    );

    it(
      'gains the tab stop under the largest text in a space the default text fits, and loses it back',
      async () => {
        const page = await open(browserFor(engine), server.url);
        try {
          await setSpace(page, await fitWidthAtDefaultText(page, TABLE));
          const readings: boolean[] = [await settledStop(page, TABLE, false)];
          await page.evaluate(() => {
            document.documentElement.classList.add('a11y-font-scale-141');
          });
          readings.push(await settledStop(page, TABLE, true));
          await page.evaluate(() => {
            document.documentElement.classList.remove('a11y-font-scale-141');
          });
          readings.push(await settledStop(page, TABLE, false));
          expect(readings).toEqual([false, true, false]);
        } finally {
          await page.close();
        }
      },
      TEST_MS
    );

    it(
      'scrolls sideways under the arrow keys while it holds focus',
      async () => {
        const page = await open(browserFor(engine), server.url);
        try {
          await setSpace(page, NARROW_PX);
          await settledStop(page, TABLE, true);
          await focusedOutline(page, TABLE);
          await page.keyboard.press('ArrowRight');
          await page.keyboard.press('ArrowRight');
          await page.waitForFunction(
            (table) =>
              (document.querySelector(`[role="group"][aria-label="${table}"]`)?.scrollLeft ?? 0) >
              0,
            TABLE,
            { timeout: LAYOUT_SETTLE_MS }
          );
          const scrolled = await page.evaluate(
            (table) =>
              document.querySelector(`[role="group"][aria-label="${table}"]`)?.scrollLeft ?? 0,
            TABLE
          );
          expect(scrolled).toBeGreaterThan(0);
        } finally {
          await page.close();
        }
      },
      TEST_MS
    );

    it.each(THEMES)(
      'draws the global outline on keyboard focus in the %s theme: solid, 2px, 2px out, in the ring colour',
      async (theme) => {
        const page = await open(browserFor(engine), server.url);
        try {
          await setTheme(page, theme);
          await setSpace(page, NARROW_PX);
          await settledStop(page, TABLE, true);
          const outline = await focusedOutline(page, TABLE);
          expect({ ...outline, color: outline.color === outline.ring }).toEqual({
            style: 'solid',
            width: '2px',
            offset: '2px',
            color: true,
            ring: outline.ring,
          });
        } finally {
          await page.close();
        }
      },
      TEST_MS
    );

    it(
      'draws no ring shadow in place of the outline',
      async () => {
        const page = await open(browserFor(engine), server.url);
        try {
          await setSpace(page, NARROW_PX);
          await settledStop(page, TABLE, true);
          await focusedOutline(page, TABLE);
          const shadow = await page.evaluate(() =>
            document.activeElement === null
              ? 'none'
              : getComputedStyle(document.activeElement).boxShadow
          );
          // Every layer's offsets, blur and spread are zero: a ring layer that draws nothing.
          expect((shadow.match(/-?[\d.]+px/g) ?? []).filter((length) => length !== '0px')).toEqual(
            []
          );
        } finally {
          await page.close();
        }
      },
      TEST_MS
    );

    it(
      'gives way to the widget’s strong focus setting',
      async () => {
        const page = await open(browserFor(engine), server.url);
        try {
          await page.evaluate(() => {
            const html = document.documentElement;
            html.classList.add('a11y-focus-strong');
            html.style.setProperty('--a11y-focus-width', '4px');
            html.style.setProperty('--a11y-focus-color', 'rgb(0, 0, 255)');
          });
          await setSpace(page, NARROW_PX);
          await settledStop(page, TABLE, true);
          const outline = await focusedOutline(page, TABLE);
          expect([outline.style, outline.width, outline.color]).toEqual([
            'solid',
            '4px',
            'rgb(0, 0, 255)',
          ]);
        } finally {
          await page.close();
        }
      },
      TEST_MS
    );
  });
});
