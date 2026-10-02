import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, firefox, type Browser, type Page } from '@playwright/test';

import { startFixtureServer, type FixtureServer } from '@/test-utils/fixture-server';

/**
 * Measures Manage Balance Online in real engines at the accessibility widget's large text
 * steps on narrow phones: its label and icon must stay inside the button's fill, which only
 * a laid-out page can show. The button sits in a button stack inside the billing page's
 * gutters (the page body's 1rem, the card's 1px border and its 1.5rem content inset), where
 * the balance card draws it when payment is disabled.
 *
 * Chromium and Firefox, the engines CI installs, over a private dev server. The page and its
 * entry are virtual modules, as are the two network seams the button imports, so no fixture
 * file joins the tree.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, '../../..');
const SRC_DIR = path.join(WEB_DIR, 'src');
const BUTTON_FILE = path.join(HERE, 'manage-online-button.tsx');

const ENTRY_ID = 'virtual:manage-online-entry';
const API_CLIENT_ID = 'virtual:manage-online-api-client';
const BROWSER_ID = 'virtual:manage-online-browser';

/** The first load compiles the app's whole stylesheet, which a busy machine can make slow. */
const LOAD_MS = 90_000;
const TEST_MS = LOAD_MS + 30_000;
/** Subpixel layout may place an edge a fraction of a pixel past its box. */
const EDGE_PX = 0.5;

const PAGE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>manage online</title></head>
  <body>
    <div id="root"></div>
    <script type="module" src="/@id/${ENTRY_ID}"></script>
  </body>
</html>`;

const ENTRY_SOURCE = `
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import '@/app.css';
import { ButtonStack } from '@hushbox/ui/button';
import { ManageOnlineButton } from ${JSON.stringify(BUTTON_FILE)};

createRoot(document.getElementById('root')).render(
  h('div', { style: { paddingInline: 'calc(2.5rem + 1px)' } },
    h('div', { 'data-column': '' }, h(ButtonStack, null, h(ManageOnlineButton)))));
globalThis.__manageOnlineReady = true;
`;

const STUBS: Readonly<Record<string, string>> = {
  [API_CLIENT_ID]: `
export const client = { billing: { 'login-link': { $post: () => Promise.resolve(new Response()) } } };
export const fetchJson = () => new Promise(() => {});`,
  [BROWSER_ID]: 'export const openExternalUrl = () => Promise.resolve();',
};

function pageModules(): Plugin {
  return {
    name: 'manage-online-page',
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
        if (!url?.startsWith('/manage-online.html')) {
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
  var __manageOnlineReady: boolean | undefined;
}

interface Overrun {
  /** How far the label's glyphs reach past the button's box, the worst edge, in px. */
  label: number;
  /** How far the icon reaches past the button's box, the worst edge, in px. */
  icon: number;
}

/** Sets the viewport and the widget's text step, then reads how far the content leaves the fill. */
async function readOverrun(page: Page, width: number, scale: number): Promise<Overrun> {
  await page.setViewportSize({ width, height: 800 });
  return page.evaluate(async (scale) => {
    const root = document.documentElement;
    root.classList.remove('a11y-font-scale-124', 'a11y-font-scale-141');
    root.classList.add(`a11y-font-scale-${String(scale)}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await document.fonts.ready;
    const button = document.querySelector('[data-column] button');
    const icon = button?.querySelector('svg');
    const label = [...(button?.childNodes ?? [])].find(
      (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== ''
    );
    if (!(button instanceof HTMLElement) || icon === null || icon === undefined || !label) {
      throw new TypeError('the column holds no Manage Balance Online button');
    }
    const box = button.getBoundingClientRect();
    const past = (inner: DOMRect): number =>
      Math.max(
        box.left - inner.left,
        inner.right - box.right,
        box.top - inner.top,
        inner.bottom - box.bottom
      );
    const range = document.createRange();
    range.selectNodeContents(label);
    return { label: past(range.getBoundingClientRect()), icon: past(icon.getBoundingClientRect()) };
  }, scale);
}

type EngineName = 'chromium' | 'firefox';
const ENGINES: readonly EngineName[] = ['chromium', 'firefox'];

const SAMPLES = [
  { width: 320, scale: 141 },
  { width: 320, scale: 124 },
  { width: 360, scale: 141 },
  { width: 360, scale: 124 },
  { width: 390, scale: 141 },
  { width: 390, scale: 124 },
] as const;

describe('Manage Balance Online at large text (real browser)', () => {
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
          { find: /^@\/lib\/api-client\.js$/, replacement: API_CLIENT_ID },
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
      await page.goto(`${server.url}/manage-online.html`, {
        waitUntil: 'commit',
        timeout: LOAD_MS,
      });
      await page.waitForFunction(() => globalThis.__manageOnlineReady === true, undefined, {
        timeout: LOAD_MS,
      });
      await page.evaluate(() => document.fonts.ready);
      pages[engine] = page;
    }
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

  describe.each(ENGINES)('on %s', (engine) => {
    it.each(SAMPLES)(
      'keeps the label inside the fill at $width px with $scale% text',
      async ({ width, scale }) => {
        const overrun = await readOverrun(pageFor(engine), width, scale);

        expect(overrun.label).toBeLessThanOrEqual(EDGE_PX);
      },
      TEST_MS
    );

    it.each(SAMPLES)(
      'keeps the icon inside the fill at $width px with $scale% text',
      async ({ width, scale }) => {
        const overrun = await readOverrun(pageFor(engine), width, scale);

        expect(overrun.icon).toBeLessThanOrEqual(EDGE_PX);
      },
      TEST_MS
    );
  });
});
