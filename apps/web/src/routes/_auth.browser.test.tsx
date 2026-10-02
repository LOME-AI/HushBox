import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, firefox, type Browser, type Page } from '@playwright/test';

import { startFixtureServer, type FixtureServer } from '@/test-utils/fixture-server';

/**
 * Measures the auth layout's two top corners in real engines: the logo with its Beta badge on
 * the left, the theme toggle on the right. Neither may cover the other at any width from 320px
 * up at any of the accessibility widget's text steps, and neither may cover the page the form
 * column holds, however tall that page is, which only a laid-out page can show.
 *
 * Chromium and Firefox, the engines CI installs, over a private dev server. The page, its entry
 * and the seams the layout imports (the router, the session client, the theme context and the
 * native platform) are virtual modules, so no fixture file joins the tree.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, '../..');
const SRC_DIR = path.join(WEB_DIR, 'src');
const LAYOUT_FILE = path.join(HERE, '_auth.tsx');

const ENTRY_ID = 'virtual:auth-corners-entry';
const ROUTER_ID = 'virtual:auth-corners-router';
const AUTH_ID = 'virtual:auth-corners-auth';
const THEME_ID = 'virtual:auth-corners-theme';
const PLATFORM_ID = 'virtual:auth-corners-platform';
const BROWSER_ID = 'virtual:auth-corners-browser';

/** The first load compiles the app's whole stylesheet, which a busy machine can make slow. */
const LOAD_MS = 90_000;
const TEST_MS = LOAD_MS + 30_000;
/** Subpixel layout may place an edge a fraction of a pixel past another. */
const EDGE_PX = 0.5;

const BADGE_NAME = 'Beta: read what that means';

const PAGE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>auth corners</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/@id/${ENTRY_ID}"></script>
  </body>
</html>`;

const ENTRY_SOURCE = `
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import '@/app.css';
import { Route } from ${JSON.stringify(LAYOUT_FILE)};

// The app shell's scroll region, which gives the layout the viewport's height to fill.
createRoot(document.getElementById('root')).render(
  h('div', { className: 'flex h-dvh flex-col' },
    h('div', { className: 'min-h-0 flex-1 overflow-y-auto' }, h(Route.options.component)))
);
globalThis.__authCornersReady = true;
`;

const STUBS: Readonly<Record<string, string>> = {
  [ROUTER_ID]: `
import { createElement as h, Fragment } from 'react';
export const createFileRoute = () => (options) => ({ options });
export const redirect = () => new Error('redirect');
export const Outlet = () =>
  h(Fragment, null, h('h1', null, 'Create your account'), h('div', { 'data-form-body': '' }));
export const Link = ({ to, children, ...props }) => h('a', { href: to, ...props }, children);`,
  [AUTH_ID]: 'export const authClient = { getSession: () => Promise.resolve({ data: null }) };',
  [THEME_ID]: 'export const useTheme = () => ({ triggerTransition: () => {} });',
  [PLATFORM_ID]: 'export const isNative = () => false;',
  [BROWSER_ID]: 'export const openExternalPage = () => Promise.resolve();',
};

function pageModules(): Plugin {
  return {
    name: 'auth-corners-page',
    resolveId(id) {
      return id === ENTRY_ID || id in STUBS ? `\0${id}` : undefined;
    },
    load(id) {
      if (id === `\0${ENTRY_ID}`) return ENTRY_SOURCE;
      return id.startsWith('\0') ? STUBS[id.slice(1)] : undefined;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = request.url;
        if (!url?.startsWith('/auth-corners.html')) {
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
  var __authCornersReady: boolean | undefined;
}

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface Corners {
  viewport: number;
  logo: Box;
  badge: Box;
  toggle: Box;
  /** Whether a pointer at each sampled point across the badge reaches the badge's link. */
  badgeReachable: boolean[];
}

/** Sets the viewport and the widget's text step (100 for none), then reads both corners. */
async function readCorners(page: Page, width: number, scale: number): Promise<Corners> {
  await page.setViewportSize({ width, height: 800 });
  return page.evaluate(
    async ({ scale, badgeName }) => {
      const root = document.documentElement;
      root.classList.remove('a11y-font-scale-124', 'a11y-font-scale-141');
      if (scale !== 100) root.classList.add(`a11y-font-scale-${String(scale)}`);
      document.querySelector<HTMLElement>('[data-form-body]')?.style.removeProperty('height');
      await new Promise((resolve) => setTimeout(resolve, 0));
      await document.fonts.ready;
      const logo = document.querySelector('a[href="/chat"]');
      const badge = document.querySelector(`a[aria-label="${badgeName}"]`);
      const toggle = document.querySelector('[data-testid="theme-toggle"]');
      if (logo === null || badge === null || toggle === null) {
        throw new TypeError('the layout holds no logo, badge or theme toggle');
      }
      const box = (element: Element): Box => {
        const { left, right, top, bottom } = element.getBoundingClientRect();
        return { left, right, top, bottom };
      };
      const pill = box(badge);
      const middle = (pill.top + pill.bottom) / 2;
      const badgeReachable = [pill.left + 1, (pill.left + pill.right) / 2, pill.right - 1].map(
        (x) => badge.contains(document.elementFromPoint(x, middle))
      );
      return {
        viewport: root.clientWidth,
        logo: box(logo),
        badge: pill,
        toggle: box(toggle),
        badgeReachable,
      };
    },
    { scale, badgeName: BADGE_NAME }
  );
}

interface TouchTargets {
  coarse: boolean;
  /** Points sampled across the logo link, and how many of them a tap would give to the badge. */
  logoPoints: number;
  logoPointsOnBadge: number;
  /** How far a tap still reaches the badge, through its centre, down and across. */
  badgeReachHeight: number;
  badgeReachWidth: number;
}

/** Sets the viewport and the text step, then hit-tests the logo link and the badge's touch area. */
async function readTouchTargets(page: Page, width: number, scale: number): Promise<TouchTargets> {
  await page.setViewportSize({ width, height: 800 });
  return page.evaluate(
    async ({ scale, badgeName }) => {
      const root = document.documentElement;
      root.classList.remove('a11y-font-scale-124', 'a11y-font-scale-141');
      if (scale !== 100) root.classList.add(`a11y-font-scale-${String(scale)}`);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await document.fonts.ready;
      const logo = document.querySelector('a[href="/chat"]');
      const badge = document.querySelector(`a[aria-label="${badgeName}"]`);
      if (logo === null || badge === null) throw new TypeError('the layout holds no logo or badge');
      const onBadge = (x: number, y: number): boolean =>
        badge.contains(document.elementFromPoint(x, y));
      const mark = logo.getBoundingClientRect();
      let logoPoints = 0;
      let logoPointsOnBadge = 0;
      for (let y = mark.top + 0.5; y < mark.bottom; y += 1) {
        for (let x = mark.left + 0.5; x < mark.right; x += 2) {
          logoPoints += 1;
          if (onBadge(x, y)) logoPointsOnBadge += 1;
        }
      }
      const pill = badge.getBoundingClientRect();
      const centre = { x: (pill.left + pill.right) / 2, y: (pill.top + pill.bottom) / 2 };
      const reach = (dx: number, dy: number): number => {
        let distance = 0;
        while (
          distance < 100 &&
          onBadge(centre.x + dx * (distance + 0.5), centre.y + dy * (distance + 0.5))
        ) {
          distance += 0.5;
        }
        return distance;
      };
      return {
        coarse: globalThis.matchMedia('(pointer: coarse)').matches,
        logoPoints,
        logoPointsOnBadge,
        badgeReachHeight: reach(0, -1) + reach(0, 1),
        badgeReachWidth: reach(-1, 0) + reach(1, 0),
      };
    },
    { scale, badgeName: BADGE_NAME }
  );
}

/** How far two boxes overlap along their shallower axis; zero or less when they are apart. */
function overlap(a: Box, b: Box): number {
  const across = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const down = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return Math.min(across, down);
}

function union(a: Box, b: Box): Box {
  return {
    left: Math.min(a.left, b.left),
    right: Math.max(a.right, b.right),
    top: Math.min(a.top, b.top),
    bottom: Math.max(a.bottom, b.bottom),
  };
}

interface Column {
  /** Everything in the top corner row: the logo, the badge and the theme toggle. */
  cornerRow: Box;
  heading: Box;
  main: Box;
  column: Box;
}

/**
 * Sets the window and the text step, gives the page beneath the heading a height of `formShare`
 * of the window, scrolls to the top, then reads the corner row against the page.
 */
async function readColumn(
  page: Page,
  sample: { width: number; height: number; scale: number; formShare: number }
): Promise<Column> {
  await page.setViewportSize({ width: sample.width, height: sample.height });
  const read = await page.evaluate(
    async ({ scale, formShare, badgeName }) => {
      const root = document.documentElement;
      root.classList.remove('a11y-font-scale-124', 'a11y-font-scale-141');
      if (scale !== 100) root.classList.add(`a11y-font-scale-${String(scale)}`);
      const formBody = document.querySelector<HTMLElement>('[data-form-body]');
      const main = document.querySelector('main');
      const heading = document.querySelector('h1');
      const corners = [
        document.querySelector('a[href="/chat"]'),
        document.querySelector(`a[aria-label="${badgeName}"]`),
        document.querySelector('[data-testid="theme-toggle"]'),
      ];
      if (formBody === null || main === null || heading === null || corners.includes(null)) {
        throw new TypeError('the layout holds no corner, main, heading or form');
      }
      formBody.style.height = `${String(formShare * window.innerHeight)}px`;
      await new Promise((resolve) => setTimeout(resolve, 0));
      await document.fonts.ready;
      main.closest('.overflow-y-auto')?.scrollTo(0, 0);
      const box = (element: Element): Box => {
        const { left, right, top, bottom } = element.getBoundingClientRect();
        return { left, right, top, bottom };
      };
      const column = main.parentElement;
      if (column === null) throw new TypeError('main has no column');
      return {
        corners: corners.flatMap((corner) => (corner === null ? [] : [box(corner)])),
        heading: box(heading),
        main: box(main),
        column: box(column),
      };
    },
    { scale: sample.scale, formShare: sample.formShare, badgeName: BADGE_NAME }
  );
  const [first, ...rest] = read.corners;
  if (first === undefined) throw new TypeError('the corner row is empty');
  let cornerRow = first;
  for (const corner of rest) cornerRow = union(cornerRow, corner);
  return {
    cornerRow,
    heading: read.heading,
    main: read.main,
    column: read.column,
  };
}

type EngineName = 'chromium' | 'firefox';
const ENGINES: readonly EngineName[] = ['chromium', 'firefox'];

const SAMPLES = [
  { width: 320, scale: 141 },
  { width: 320, scale: 124 },
  { width: 320, scale: 100 },
  { width: 340, scale: 141 },
  { width: 360, scale: 141 },
  { width: 375, scale: 100 },
  { width: 1440, scale: 141 },
] as const;

/** Where the badge fits beside the logo today, it stays on the logo's line. */
const ROOMY_SAMPLES = [
  { width: 340, scale: 141 },
  { width: 375, scale: 100 },
  { width: 768, scale: 100 },
  { width: 1440, scale: 100 },
] as const;

/** Under a coarse pointer the badge's touch area outgrows the pill, toward the logo when wrapped. */
const TOUCH_SAMPLES = [
  { width: 320, scale: 141 },
  { width: 320, scale: 124 },
  { width: 320, scale: 100 },
  { width: 340, scale: 141 },
  { width: 375, scale: 141 },
  { width: 375, scale: 100 },
  { width: 768, scale: 141 },
] as const;

/** The smallest touch target, in CSS pixels, the shared hit-area rule exists to guarantee. */
const MIN_TOUCH_TARGET_PX = 44;

/** The window sizes and text steps where the form column could rise into the corner row. */
const WINDOWS = [
  { width: 1024, height: 640, scale: 100 },
  { width: 1280, height: 800, scale: 141 },
  { width: 1440, height: 800, scale: 124 },
  { width: 1440, height: 900, scale: 141 },
  { width: 1440, height: 900, scale: 100 },
  { width: 375, height: 800, scale: 100 },
  { width: 320, height: 800, scale: 141 },
] as const;

/** A page that nearly fills the window, and one taller than it. */
const TALL_PAGES = WINDOWS.flatMap((window) =>
  [0.85, 1.25].map((formShare) => ({ ...window, formShare }))
);

/** Beside the wall, a page short enough to clear the corner row by a wide margin. */
const SHORT_PAGES = [
  { width: 1024, height: 640, scale: 100, formShare: 0.4 },
  { width: 1440, height: 900, scale: 100, formShare: 0.5 },
  { width: 1440, height: 900, scale: 141, formShare: 0.3 },
] as const;

describe('auth layout corners (real browser)', () => {
  let server: FixtureServer;
  const browsers: Partial<Record<EngineName, Browser>> = {};
  const pages: Partial<Record<EngineName, Page>> = {};
  /** Chromium alone turns `(pointer: coarse)` on under Playwright's touch emulation. */
  let touchPage: Page | undefined;

  beforeAll(async () => {
    server = await startFixtureServer({
      root: WEB_DIR,
      configFile: false,
      plugins: [react(), tailwindcss(), pageModules()],
      resolve: {
        alias: [
          { find: /^@tanstack\/react-router$/, replacement: ROUTER_ID },
          { find: /^@\/lib\/auth\/auth$/, replacement: AUTH_ID },
          { find: /^@\/providers\/theme-provider$/, replacement: THEME_ID },
          { find: /^@\/capacitor\/platform$/, replacement: PLATFORM_ID },
          { find: /^@\/capacitor\/browser$/, replacement: BROWSER_ID },
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
    for (const engine of ENGINES) {
      const browser = browsers[engine];
      if (browser === undefined) throw new Error(`${engine} did not launch`);
      const page = await browser.newPage({ viewport: { width: 320, height: 800 } });
      await page.goto(`${server.url}/auth-corners.html`, {
        waitUntil: 'commit',
        timeout: LOAD_MS,
      });
      await page.waitForFunction(() => globalThis.__authCornersReady === true, undefined, {
        timeout: LOAD_MS,
      });
      await page.evaluate(() => document.fonts.ready);
      pages[engine] = page;
    }
    touchPage = await chromiumBrowser.newPage({
      viewport: { width: 320, height: 800 },
      hasTouch: true,
      isMobile: true,
    });
    await touchPage.goto(`${server.url}/auth-corners.html`, {
      waitUntil: 'commit',
      timeout: LOAD_MS,
    });
    await touchPage.waitForFunction(() => globalThis.__authCornersReady === true, undefined, {
      timeout: LOAD_MS,
    });
  }, 2 * LOAD_MS);

  // Closing two browsers and the server can outlast the default hook budget on a busy machine.
  // The server's close starts beside the browsers' rather than after them, so a stalled
  // browser close cannot keep the server from removing its cache folder within its budget.
  afterAll(async () => {
    await Promise.all([
      ...Object.values(browsers).map((browser) => browser.close()),
      server.close(),
    ]);
  }, LOAD_MS);

  function pageFor(engine: EngineName): Page {
    const page = pages[engine];
    if (page === undefined) throw new Error(`${engine} has no page`);
    return page;
  }

  describe('under a coarse pointer on chromium', () => {
    function touch(): Page {
      if (touchPage === undefined) throw new Error('chromium has no touch page');
      return touchPage;
    }

    it.each(TOUCH_SAMPLES)(
      'gives no tap on the logo to the badge at $width px with $scale% text',
      async ({ width, scale }) => {
        const targets = await readTouchTargets(touch(), width, scale);

        expect(targets.coarse).toBe(true);
        expect(targets.logoPoints).toBeGreaterThan(0);
        expect(targets.logoPointsOnBadge).toBe(0);
      },
      TEST_MS
    );

    it.each(TOUCH_SAMPLES)(
      "keeps the badge's touch target at least 44px each way at $width px with $scale% text",
      async ({ width, scale }) => {
        const targets = await readTouchTargets(touch(), width, scale);

        expect(targets.coarse).toBe(true);
        expect(targets.badgeReachHeight).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
        expect(targets.badgeReachWidth).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
      },
      TEST_MS
    );
  });

  describe.each(ENGINES)('on %s', (engine) => {
    it.each(SAMPLES)(
      'keeps the logo corner clear of the theme toggle at $width px with $scale% text',
      async ({ width, scale }) => {
        const corners = await readCorners(pageFor(engine), width, scale);

        expect(overlap(union(corners.logo, corners.badge), corners.toggle)).toBeLessThanOrEqual(
          EDGE_PX
        );
      },
      TEST_MS
    );

    it.each(SAMPLES)(
      'leaves the whole badge within reach of the pointer at $width px with $scale% text',
      async ({ width, scale }) => {
        const corners = await readCorners(pageFor(engine), width, scale);

        expect(corners.badgeReachable).toEqual([true, true, true]);
      },
      TEST_MS
    );

    it.each(SAMPLES)(
      'keeps the badge inside the viewport at $width px with $scale% text',
      async ({ width, scale }) => {
        const corners = await readCorners(pageFor(engine), width, scale);

        expect(corners.badge.right).toBeLessThanOrEqual(corners.viewport + EDGE_PX);
      },
      TEST_MS
    );

    it.each(ROOMY_SAMPLES)(
      "keeps the badge on the logo's line at $width px with $scale% text",
      async ({ width, scale }) => {
        const corners = await readCorners(pageFor(engine), width, scale);
        const badgeMiddle = (corners.badge.top + corners.badge.bottom) / 2;

        expect(badgeMiddle).toBeGreaterThan(corners.logo.top);
        expect(badgeMiddle).toBeLessThan(corners.logo.bottom);
      },
      TEST_MS
    );

    it.each(TALL_PAGES)(
      'keeps the corner row clear of the page heading at $width x $height with $scale% text and a page $formShare of the window tall',
      async (sample) => {
        const { cornerRow, heading } = await readColumn(pageFor(engine), sample);

        expect(overlap(cornerRow, heading)).toBeLessThanOrEqual(EDGE_PX);
      },
      TEST_MS
    );

    it.each(SHORT_PAGES)(
      'keeps a short page centred in the form column at $width x $height with $scale% text',
      async (sample) => {
        const { main, column } = await readColumn(pageFor(engine), sample);

        expect(Math.abs(main.top - column.top - (column.bottom - main.bottom))).toBeLessThanOrEqual(
          1
        );
      },
      TEST_MS
    );
  });
});
