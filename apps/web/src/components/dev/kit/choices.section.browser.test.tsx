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
 * Measures the choice rows in real engines: a control centres on its whole label block
 * only once the browser lays the block out, which no test DOM does. The page mounts the
 * kit section under the app stylesheet and reads the samples it marks `data-centring`.
 *
 * Chromium and Firefox, the engines CI installs, driven by `@playwright/test` over a
 * private dev server; the page and its entry are virtual modules, so no fixture file
 * joins the tree.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, '../../../..');
const SRC_DIR = path.join(WEB_DIR, 'src');
const SECTION_FILE = path.join(HERE, 'choices.section.tsx');

const ENTRY_ID = 'virtual:choices-entry';

/** The first load compiles the app's whole stylesheet, which a busy machine can make slow. */
const LOAD_MS = 90_000;
const TEST_MS = LOAD_MS + 30_000;
/** The furthest a control's centre may sit from its label block's centre. */
const CENTRING_PX = 0.5;

const PAGE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>choices</title></head>
  <body>
    <div id="root"></div>
    <script type="module" src="/@id/${ENTRY_ID}"></script>
  </body>
</html>`;

const ENTRY_SOURCE = `
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import '@/app.css';
import section from ${JSON.stringify(SECTION_FILE)};

createRoot(document.getElementById('root')).render(createElement('div', null, section.render()));
globalThis.__choicesReady = true;
`;

function pageModules(): Plugin {
  return {
    name: 'choices-page',
    resolveId(id) {
      return id === ENTRY_ID ? `\0${id}` : undefined;
    },
    load(id) {
      return id === `\0${ENTRY_ID}` ? ENTRY_SOURCE : undefined;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = request.url;
        if (!url?.startsWith('/choices.html')) {
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
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'choices-vite-'));
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
    throw new Error('choices server has no port');
  }
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    close: async () => {
      await server.close();
      await rm(cacheDir, { recursive: true, force: true });
    },
  };
}

interface CentringReading {
  /** Lines the label block's text runs to. */
  lines: number;
  /** Distance between the control's vertical centre and the label block's. */
  offset: number;
}

declare global {
  var __choicesReady: boolean | undefined;
}

/** Reads the sample marked `data-centring="<sample>"`. */
async function readCentring(page: Page, sample: string): Promise<CentringReading> {
  return page.evaluate((sample) => {
    const cell = document.querySelector(`[data-centring="${sample}"]`);
    const control = cell?.querySelector('[role="checkbox"], [role="switch"]');
    const row = control?.parentElement;
    const block = [...(row?.children ?? [])].find((child) => child !== control);
    if (!(control instanceof HTMLElement) || !(block instanceof HTMLElement)) {
      throw new TypeError(`no control beside a label block in sample ${sample}`);
    }
    const controlBox = control.getBoundingClientRect();
    const blockBox = block.getBoundingClientRect();
    let lines = 0;
    for (const line of block.children) {
      const height = line.getBoundingClientRect().height;
      lines += Math.round(height / Number.parseFloat(getComputedStyle(line).lineHeight));
    }
    return {
      lines,
      offset: Math.abs(
        controlBox.top + controlBox.height / 2 - (blockBox.top + blockBox.height / 2)
      ),
    };
  }, sample);
}

type EngineName = 'chromium' | 'firefox';
const ENGINES: readonly EngineName[] = ['chromium', 'firefox'];

/** Each sample, with the lines its label block runs to in the kit's 11rem cell. */
const CHECK_SAMPLES = [
  { sample: '1', lines: 1 },
  { sample: '2', lines: 2 },
  { sample: '3', lines: 3 },
] as const;

describe('choice rows (real browser)', () => {
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
      await page.goto(`${server.origin}/choices.html`, { waitUntil: 'commit', timeout: LOAD_MS });
      await page.waitForFunction(() => globalThis.__choicesReady === true, undefined, {
        timeout: LOAD_MS,
      });
      await page.evaluate(() => document.fonts.ready);
      pages[engine] = page;
    }
  }, 2 * LOAD_MS);

  afterAll(async () => {
    await Promise.all(Object.values(browsers).map((browser) => browser.close()));
    await server.close();
  });

  function pageFor(engine: EngineName): Page {
    const page = pages[engine];
    if (page === undefined) throw new Error(`${engine} has no page`);
    return page;
  }

  describe.each(ENGINES)('on %s', (engine) => {
    it.each(CHECK_SAMPLES)(
      'runs the checkbox sample $sample to $lines lines',
      async ({ sample, lines }) => {
        const reading = await readCentring(pageFor(engine), sample);

        expect(reading.lines).toBe(lines);
      },
      TEST_MS
    );

    it.each(CHECK_SAMPLES)(
      'centres the checkbox on its $lines-line label block within half a pixel',
      async ({ sample }) => {
        const reading = await readCentring(pageFor(engine), sample);

        expect(reading.offset).toBeLessThanOrEqual(CENTRING_PX);
      },
      TEST_MS
    );

    it(
      'centres the switch on its label and description within half a pixel',
      async () => {
        const reading = await readCentring(pageFor(engine), 'switch');

        expect(reading.offset).toBeLessThanOrEqual(CENTRING_PX);
      },
      TEST_MS
    );
  });
});
