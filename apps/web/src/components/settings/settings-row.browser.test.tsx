import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Plugin, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, firefox, type Browser, type Page } from '@playwright/test';

/**
 * Measures the inline action row in real engines: its width follows the list's width
 * through a container length, and its centring holds only once the browser lays the text
 * out, which no test DOM does. The page mounts settings groups of a fixed width under the
 * app stylesheet, desktop wide so the inline layout applies.
 *
 * Chromium and Firefox, the engines CI installs, driven by `@playwright/test` over a
 * private dev server; the page and its entry are virtual modules, so no fixture file
 * joins the tree.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, '../../..');
const SRC_DIR = path.join(WEB_DIR, 'src');
const GROUP_FILE = path.join(HERE, 'settings-group.tsx');
const ROW_FILE = path.join(HERE, 'settings-row.tsx');

const ENTRY_ID = 'virtual:settings-rows-entry';

/** The first load compiles the app's whole stylesheet, which a busy machine can make slow. */
const LOAD_MS = 90_000;
const TEST_MS = LOAD_MS + 30_000;
/** The furthest the button's centre may sit from the text block's centre. */
const CENTRING_PX = 0.5;
/** The furthest a measured width may sit from its rem target, for subpixel layout. */
const WIDTH_PX = 0.5;

const PAGE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>settings rows</title></head>
  <body>
    <div id="root"></div>
    <script type="module" src="/@id/${ENTRY_ID}"></script>
  </body>
</html>`;

// Each sample is one list; `data-sample` names it by list width and description length.
const ENTRY_SOURCE = `
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import '@/app.css';
import { Button } from '@hushbox/ui/button';
import { SettingsGroup } from ${JSON.stringify(GROUP_FILE)};
import { SettingsRow } from ${JSON.stringify(ROW_FILE)};

const SHORT = 'If you lose your password, this is your only recovery.';
const LONG = {
  36: 'A stolen password alone could open your account, so a second step at sign-in keeps it closed even when the password is known.',
  50: 'A stolen password alone could open your account, so a second step at sign-in keeps it closed even when someone else knows the password you use.',
};

function sample(width, lines) {
  return h('div', { key: width + '-' + lines, 'data-sample': width + '-' + lines, style: { width: width + 'rem' } },
    h(SettingsGroup, { id: 'g-' + width + '-' + lines, title: 'Needs attention' },
      h(SettingsRow, {
        kind: 'action',
        inline: true,
        title: 'Two-factor authentication is off',
        description: lines === 1 ? SHORT : LONG[width],
        action: h(Button, { block: true }, 'Turn on'),
      })));
}

createRoot(document.getElementById('root')).render(
  h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2rem', padding: '1rem' } },
    sample(36, 1), sample(36, 2), sample(50, 1), sample(50, 2)));
globalThis.__settingsRowsReady = true;
`;

function pageModules(): Plugin {
  return {
    name: 'settings-rows-page',
    resolveId(id) {
      return id === ENTRY_ID ? `\0${id}` : undefined;
    },
    load(id) {
      return id === `\0${ENTRY_ID}` ? ENTRY_SOURCE : undefined;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = request.url;
        if (!url?.startsWith('/settings-rows.html')) {
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

async function startServer(): Promise<{ origin: string; close: () => Promise<void> }> {
  // A private dependency cache: the app's `node_modules/.vite` is the running dev server's,
  // and a second optimiser rewriting it leaves that server answering 504.
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'settings-rows-vite-'));
  const server: ViteDevServer = await createServer({
    root: WEB_DIR,
    configFile: false,
    cacheDir,
    logLevel: 'error',
    plugins: [react(), tailwindcss(), pageModules()],
    resolve: { alias: [{ find: /^@\/(.*)$/, replacement: path.join(SRC_DIR, '$1') }] },
    server: { port: 0, host: '127.0.0.1', hmr: false },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (address === null || address === undefined || typeof address === 'string') {
    throw new Error('settings rows server has no port');
  }
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    close: async () => {
      await server.close();
      await rm(cacheDir, { recursive: true, force: true });
    },
  };
}

interface ActionReading {
  /** The list's width, in rem. */
  listRem: number;
  /** The button's width, in px. */
  buttonPx: number;
  /** One rem, in px. */
  remPx: number;
  /** Lines the description runs to. */
  descriptionLines: number;
  /** Distance between the button's vertical centre and the text block's. */
  offset: number;
}

declare global {
  var __settingsRowsReady: boolean | undefined;
}

async function readAction(page: Page, sample: string): Promise<ActionReading> {
  return page.evaluate((sample) => {
    const root = document.querySelector(`[data-sample="${sample}"]`);
    const list = root?.querySelector('[data-settings-list]');
    const button = root?.querySelector('button');
    const text = root?.querySelector('[data-settings-title]')?.parentElement;
    const description = text?.lastElementChild;
    if (
      !(list instanceof HTMLElement) ||
      !(button instanceof HTMLElement) ||
      !(text instanceof HTMLElement) ||
      !(description instanceof HTMLElement)
    ) {
      throw new TypeError(`sample ${sample} has no inline action row`);
    }
    const remPx = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    const buttonBox = button.getBoundingClientRect();
    const textBox = text.getBoundingClientRect();
    const descriptionHeight = description.getBoundingClientRect().height;
    return {
      listRem: list.getBoundingClientRect().width / remPx,
      buttonPx: buttonBox.width,
      remPx,
      descriptionLines: Math.round(
        descriptionHeight / Number.parseFloat(getComputedStyle(description).lineHeight)
      ),
      offset: Math.abs(buttonBox.top + buttonBox.height / 2 - (textBox.top + textBox.height / 2)),
    };
  }, sample);
}

type EngineName = 'chromium' | 'firefox';
const ENGINES: readonly EngineName[] = ['chromium', 'firefox'];

const SAMPLES = [
  { sample: '36-1', listRem: 36, buttonRem: 7, lines: 1 },
  { sample: '36-2', listRem: 36, buttonRem: 7, lines: 2 },
  { sample: '50-1', listRem: 50, buttonRem: 12, lines: 1 },
  { sample: '50-2', listRem: 50, buttonRem: 12, lines: 2 },
] as const;

describe('inline settings action (real browser)', () => {
  let server: { origin: string; close: () => Promise<void> };
  const browsers: Partial<Record<EngineName, Browser>> = {};
  const pages: Partial<Record<EngineName, Page>> = {};

  beforeAll(async () => {
    server = await startServer();
    const [chromiumBrowser, firefoxBrowser] = await Promise.all([
      chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] }),
      firefox.launch(),
    ]);
    browsers.chromium = chromiumBrowser;
    browsers.firefox = firefoxBrowser;
    for (const engine of ENGINES) {
      const browser = browsers[engine];
      if (browser === undefined) throw new Error(`${engine} did not launch`);
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      await page.goto(`${server.origin}/settings-rows.html`, {
        waitUntil: 'commit',
        timeout: LOAD_MS,
      });
      await page.waitForFunction(() => globalThis.__settingsRowsReady === true, undefined, {
        timeout: LOAD_MS,
      });
      await page.evaluate(() => document.fonts.ready);
      pages[engine] = page;
    }
  }, 2 * LOAD_MS);

  // Closing two browsers and the server can outlast the default hook budget on a busy machine.
  afterAll(async () => {
    await Promise.all(Object.values(browsers).map((browser) => browser.close()));
    await server.close();
  }, LOAD_MS);

  function pageFor(engine: EngineName): Page {
    const page = pages[engine];
    if (page === undefined) throw new Error(`${engine} has no page`);
    return page;
  }

  describe.each(ENGINES)('on %s', (engine) => {
    it.each(SAMPLES)(
      'lays sample $sample out as a $listRem rem list with a $lines-line description',
      async ({ sample, listRem, lines }) => {
        const reading = await readAction(pageFor(engine), sample);

        expect(reading.listRem).toBeCloseTo(listRem, 2);
        expect(reading.descriptionLines).toBe(lines);
      },
      TEST_MS
    );

    it.each(SAMPLES)(
      'makes the button $buttonRem rem wide in a $listRem rem list ($lines-line text)',
      async ({ sample, buttonRem }) => {
        const reading = await readAction(pageFor(engine), sample);

        expect(Math.abs(reading.buttonPx - buttonRem * reading.remPx)).toBeLessThanOrEqual(
          WIDTH_PX
        );
      },
      TEST_MS
    );

    it.each(SAMPLES)(
      'centres the button on the $lines-line text block in a $listRem rem list',
      async ({ sample }) => {
        const reading = await readAction(pageFor(engine), sample);

        expect(reading.offset).toBeLessThanOrEqual(CENTRING_PX);
      },
      TEST_MS
    );
  });
});
