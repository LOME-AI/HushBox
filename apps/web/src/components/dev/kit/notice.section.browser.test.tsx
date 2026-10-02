import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, firefox, type Browser } from '@playwright/test';
import { startFixtureServer, type FixtureServer } from '@/test-utils/fixture-server';
import type { Plugin } from 'vite';

/**
 * Measures where a notice's icon and corner control sit against text that wraps to three lines,
 * under the app stylesheet. Whether a grid or flex row centres its items on the whole text block
 * is something only a layout engine settles.
 *
 * Chromium and Firefox, the engines CI installs, driven through `@playwright/test` over a fixture
 * server; the page and its entry are virtual modules, so no fixture file joins the tree.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, '../../../..');
const SRC_DIR = path.join(WEB_DIR, 'src');

const ENTRY_ID = 'virtual:notice-geometry-entry';
const PAGE_PATH = '/notice-geometry.html';

/** The first load compiles the app's whole stylesheet, which a busy machine can make slow. */
const LOAD_MS = 90_000;
const TEST_MS = LOAD_MS + 30_000;
const CLOSE_MS = 45_000;

const PAGE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>notice geometry</title></head>
  <body>
    <div id="root"></div>
    <script type="module" src="/@id/${ENTRY_ID}"></script>
  </body>
</html>`;

// Each notice sits in a 16rem column, so its sentence wraps to three lines or more.
const ENTRY_SOURCE = `
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import '@/app.css';
import { Notice, NoticeDismiss } from '@hushbox/ui/notice';
import { Copy, Info } from '@hushbox/ui/icons';
import { IconButton } from '@hushbox/ui/button';

const TEXT = 'Your balance is running low, so replies may be shortened.';
const dismiss = h(NoticeDismiss, { onDismiss: () => {} });
const copy = h(IconButton, { icon: Copy, size: 'xs', 'aria-label': 'Copy' });
const samples = [
  ['inline', { placement: 'inline', end: dismiss }],
  ['composer', { placement: 'composer', end: dismiss }],
  ['tile', { placement: 'tile', end: copy }],
  ['slot', { placement: 'slot', end: copy }],
  ['bare', { placement: 'inline' }],
];

createRoot(document.getElementById('root')).render(
  h('div', { style: { display: 'flex', flexDirection: 'column', gap: '1rem', width: '16rem', padding: '1rem' } },
    samples.map(([id, props]) =>
      h(Notice, { key: id, 'data-testid': id, tone: 'warning', icon: Info, ...props }, TEXT)
    )
  )
);
`;

function pageModules(): Plugin {
  return {
    name: 'notice-geometry-page',
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

type EngineName = 'chromium' | 'firefox';
const ENGINES: readonly EngineName[] = ['chromium', 'firefox'];

interface Geometry {
  /** How many lines the text wraps to. */
  lines: number;
  /** The icon's vertical centre less the text's, in px. */
  iconOffset: number;
  /** The corner control's vertical centre less the text's, in px; null with no control. */
  endOffset: number | null;
  /** The space between the text's right edge and the notice's content edge, in px. */
  rightGap: number;
}

async function measure(browser: Browser, origin: string): Promise<Record<string, Geometry>> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
  try {
    // Both the load event and DOMContentLoaded wait on every module script, which a loaded
    // machine can hold past the budget; the notices rendering is the readiness this needs.
    await page.goto(`${origin}${PAGE_PATH}`, { timeout: LOAD_MS, waitUntil: 'commit' });
    await page.locator('[data-testid="bare"]').waitFor({ timeout: LOAD_MS });
    await page.evaluate(() => document.fonts.ready);
    return await page.evaluate(() => {
      const centre = (rect: DOMRect): number => rect.top + rect.height / 2;
      const result: Record<string, Geometry> = {};
      for (const notice of document.querySelectorAll<HTMLElement>('[data-slot="notice"]')) {
        const id = notice.dataset['testid'];
        const [icon, body, end] = [...notice.children];
        if (id === undefined || icon === undefined || body === undefined) {
          throw new Error('a notice is missing its icon or its text');
        }
        const text = body.lastElementChild;
        if (text === null) throw new Error('a notice is missing its text');
        const bodyRect = body.getBoundingClientRect();
        const style = getComputedStyle(notice);
        const contentRight =
          notice.getBoundingClientRect().right -
          Number.parseFloat(style.paddingRight) -
          Number.parseFloat(style.borderRightWidth);
        const lineHeight = Number.parseFloat(getComputedStyle(text).lineHeight);
        result[id] = {
          lines: Math.round(text.getBoundingClientRect().height / lineHeight),
          iconOffset: centre(icon.getBoundingClientRect()) - centre(bodyRect),
          endOffset:
            end === undefined ? null : centre(end.getBoundingClientRect()) - centre(bodyRect),
          rightGap: contentRight - bodyRect.right,
        };
      }
      return result;
    });
  } finally {
    await page.close();
  }
}

describe('notice geometry in a real engine', () => {
  let server: FixtureServer;
  const browsers: Partial<Record<EngineName, Browser>> = {};
  const measured: Partial<Record<EngineName, Record<string, Geometry>>> = {};

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
    await Promise.all(Object.values(browsers).map((browser) => browser.close()));
    await server.close();
  }, CLOSE_MS + 15_000);

  async function geometryIn(engine: EngineName, id: string): Promise<Geometry> {
    const browser = browsers[engine];
    if (browser === undefined) throw new Error(`${engine} did not launch`);
    measured[engine] ??= await measure(browser, server.url);
    const geometry = measured[engine][id];
    if (geometry === undefined) throw new Error(`no notice ${id}`);
    return geometry;
  }

  describe.each(ENGINES)('%s', (engine) => {
    describe.each(['inline', 'composer', 'tile', 'slot'])('placed %s', (id) => {
      it(
        'wraps its text to at least three lines',
        async () => {
          const { lines } = await geometryIn(engine, id);
          expect(lines).toBeGreaterThanOrEqual(3);
        },
        TEST_MS
      );

      it(
        'centres its icon on the whole text',
        async () => {
          const { iconOffset } = await geometryIn(engine, id);
          expect(Math.abs(iconOffset)).toBeLessThan(1);
        },
        TEST_MS
      );

      it(
        'centres its corner control on the whole text',
        async () => {
          const { endOffset } = await geometryIn(engine, id);
          expect(Math.abs(endOffset ?? Infinity)).toBeLessThan(1);
        },
        TEST_MS
      );
    });

    it(
      'gives the text the full width when there is no corner control',
      async () => {
        const { rightGap } = await geometryIn(engine, 'bare');
        expect(Math.abs(rightGap)).toBeLessThan(0.5);
      },
      TEST_MS
    );
  });
});
