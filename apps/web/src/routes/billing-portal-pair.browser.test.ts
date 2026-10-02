import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, firefox, type Browser, type Page } from '@playwright/test';

import { startFixtureServer, type FixtureServer } from '@/test-utils/fixture-server';

/**
 * Proves in real engines that the billing portal's post-purchase pair is reached in the order
 * it is drawn. The pair sits side by side while both labels fit an equal share of the balance
 * card and stacks otherwise, with Return to the app on top; only a laid-out page knows which,
 * so only a real engine can show that focus follows it.
 *
 * The real route mounts under a memory router over the app stylesheet, with a token exchange
 * that succeeds. The billing content is a stand-in that draws the portal's actions inside the
 * real page body and card, so the pair gets the column the balance card gives it. The page,
 * its entry and the seams it replaces are virtual modules, so no fixture file joins the tree.
 * Chromium and Firefox, the engines CI installs.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, '../..');
const SRC_DIR = path.join(WEB_DIR, 'src');
const ROUTE_FILE = path.join(HERE, 'billing-portal.tsx');

const ENTRY_ID = 'virtual:billing-portal-pair-entry';
const AUTH_ID = 'virtual:billing-portal-pair-auth';
const CONTENT_ID = 'virtual:billing-portal-pair-content';
const THEME_TOGGLE_ID = 'virtual:billing-portal-pair-theme-toggle';

/** The first load compiles the app's whole stylesheet, which a busy machine can make slow. */
const LOAD_MS = 90_000;
const TEST_MS = LOAD_MS + 30_000;

const PAGE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>billing portal pair</title></head>
  <body>
    <div id="root"></div>
    <script type="module" src="/@id/${ENTRY_ID}"></script>
  </body>
</html>`;

const ENTRY_SOURCE = `
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import {
  RouterProvider, createMemoryHistory, createRootRoute, createRouter,
} from '@tanstack/react-router';
import '@/app.css';
import { Route } from ${JSON.stringify(ROUTE_FILE)};

const rootRoute = createRootRoute();
const portalRoute = Route.update({
  id: '/billing-portal',
  path: '/billing-portal',
  getParentRoute: () => rootRoute,
});
const router = createRouter({
  routeTree: rootRoute.addChildren([portalRoute]),
  history: createMemoryHistory({ initialEntries: ['/billing-portal?token=portal-token'] }),
});
createRoot(document.getElementById('root')).render(
  h('div', { style: { height: '100vh' } }, h(RouterProvider, { router })),
);
`;

const STUBS: Readonly<Record<string, string>> = {
  [AUTH_ID]: 'export const authClient = { tokenLogin: () => Promise.resolve({}) };',
  // The header's toggle reads the app's theme provider, which the pair never touches.
  [THEME_TOGGLE_ID]: 'export const ThemeToggle = () => null;',
  [CONTENT_ID]: `
import { createElement as h } from 'react';
import { Card, CardContent } from '@hushbox/ui/surface';
import { PageBody } from '@/components/shared/page-body';

export function BillingContent({ purchasedActions }) {
  return h(PageBody, null,
    h(Card, null,
      h(CardContent, null,
        h('div', { 'data-pair': '' }, purchasedActions({ openPayment: () => {} })))));
}`,
};

function pageModules(): Plugin {
  return {
    name: 'billing-portal-pair-page',
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
        if (!url?.startsWith('/billing-portal-pair.html')) {
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

interface PairReading {
  /** The accessible text of the first control a keyboard reaches in the pair. */
  firstFocusable: string;
  /** The text of the control drawn first: the top one when stacked, the left one otherwise. */
  firstDrawn: string;
  /** Whether the two controls sit on one line. */
  sideBySide: boolean;
}

/** Frames the page is given after a resize before the pair is read. */
const SETTLE_FRAMES = 3;

declare global {
  var __pairFrames: number | undefined;
}

/**
 * Sets the viewport, lets the row settle into its layout, then reads the pair. The row learns
 * whether it is stacked from a resize observation after layout and re-renders from it, so the
 * reading waits a few rendered frames rather than a clock.
 */
async function readPair(page: Page, width: number): Promise<PairReading> {
  await page.setViewportSize({ width, height: 900 });
  await page.evaluate(() => {
    globalThis.__pairFrames = 0;
  });
  await page.waitForFunction(
    (frames) => {
      globalThis.__pairFrames = (globalThis.__pairFrames ?? 0) + 1;
      return globalThis.__pairFrames >= frames;
    },
    SETTLE_FRAMES,
    { polling: 'raf' }
  );
  return page.evaluate(() => {
    const controls = [
      ...document.querySelectorAll<HTMLElement>('[data-pair] a, [data-pair] button'),
    ];
    if (controls.length !== 2) throw new TypeError('the balance card holds no purchased pair');
    const [first, second] = controls as [HTMLElement, HTMLElement];
    const firstBox = first.getBoundingClientRect();
    const secondBox = second.getBoundingClientRect();
    const sideBySide = Math.abs(firstBox.top - secondBox.top) < 1;
    const firstLeads = sideBySide ? firstBox.left <= secondBox.left : firstBox.top <= secondBox.top;
    const drawnFirst = firstLeads ? first : second;
    return {
      firstFocusable: first.textContent.trim(),
      firstDrawn: drawnFirst.textContent.trim(),
      sideBySide,
    };
  });
}

type EngineName = 'chromium' | 'firefox';
const ENGINES: readonly EngineName[] = ['chromium', 'firefox'];

describe('the billing portal pair after a purchase (real browser)', () => {
  let server: FixtureServer;
  const browsers: Partial<Record<EngineName, Browser>> = {};
  const pages: Partial<Record<EngineName, Page>> = {};

  beforeAll(async () => {
    server = await startFixtureServer({
      root: WEB_DIR,
      configFile: false,
      plugins: [react(), tailwindcss(), pageModules()],
      resolve: {
        alias: [
          { find: /^@\/lib\/auth\/auth$/, replacement: AUTH_ID },
          { find: /^@\/components\/billing\/billing-content$/, replacement: CONTENT_ID },
          { find: /^@\/components\/shared\/theme-toggle$/, replacement: THEME_TOGGLE_ID },
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
      const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
      await page.goto(`${server.url}/billing-portal-pair.html`, {
        waitUntil: 'commit',
        timeout: LOAD_MS,
      });
      await page.waitForSelector('[data-pair] a', { timeout: LOAD_MS });
      await page.evaluate(() => document.fonts.ready);
      pages[engine] = page;
    }
  }, 2 * LOAD_MS);

  // Closing two browsers and the server can outlast the default hook budget on a busy machine.
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

  describe.each(ENGINES)('on %s', (engine) => {
    it(
      'stacks the pair on a phone',
      async () => {
        const reading = await readPair(pageFor(engine), 390);

        expect(reading.sideBySide).toBe(false);
      },
      TEST_MS
    );

    it(
      'reaches Return to the app first on a phone',
      async () => {
        const reading = await readPair(pageFor(engine), 390);

        expect(reading.firstFocusable).toBe('Return to the app');
      },
      TEST_MS
    );

    it(
      'sets the pair side by side on a tablet',
      async () => {
        const reading = await readPair(pageFor(engine), 834);

        expect(reading.sideBySide).toBe(true);
      },
      TEST_MS
    );

    it(
      'reaches Add Credits first on a tablet',
      async () => {
        const reading = await readPair(pageFor(engine), 834);

        expect(reading.firstFocusable).toBe('Add Credits');
      },
      TEST_MS
    );

    it(
      'draws Return to the app on top on a phone',
      async () => {
        const reading = await readPair(pageFor(engine), 390);

        expect(reading.firstDrawn).toBe('Return to the app');
      },
      TEST_MS
    );

    it(
      'draws Add Credits on the left on a tablet',
      async () => {
        const reading = await readPair(pageFor(engine), 834);

        expect(reading.firstDrawn).toBe('Add Credits');
      },
      TEST_MS
    );
  });
});
