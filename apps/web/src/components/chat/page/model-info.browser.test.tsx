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
 * Measures the model readout in real engines: how many lines it takes in a column, and
 * whether any line starts with a separating dot, hold only once the browser lays the text
 * out, which no test DOM does. The page mounts the readout for several models under the app
 * stylesheet in one column, whose width each test sets to the new chat column's width at a
 * screen width.
 *
 * Chromium and Firefox, the engines CI installs, driven by `@playwright/test` over a
 * private dev server; the page and its entry are virtual modules, so no fixture file
 * joins the tree.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, '../../../..');
const SRC_DIR = path.join(WEB_DIR, 'src');
const MODEL_INFO_FILE = path.join(HERE, 'model-info.tsx');

const ENTRY_ID = 'virtual:model-info-entry';

/** The first load compiles the app's whole stylesheet, which a busy machine can make slow. */
const LOAD_MS = 90_000;
const TEST_MS = LOAD_MS + 30_000;

/** The new chat column's width at each screen width: the chat measure less the gutters. */
const COLUMN_PX = { 320: 288, 390: 358, 1440: 714 } as const;

const PAGE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>model info</title></head>
  <body>
    <div id="root"></div>
    <script type="module" src="/@id/${ENTRY_ID}"></script>
  </body>
</html>`;

// Rates are billable nano-USD, as the catalog serves them.
const ENTRY_SOURCE = `
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import '@/app.css';
import { ModelInfo } from ${JSON.stringify(MODEL_INFO_FILE)};

const base = { contextLength: 200000, description: 'A model.', supportedParameters: [], modality: 'text' };
const smart = { ...base, id: 'smart-model', name: 'Smart Model', provider: 'HushBox', isSmartModel: true, pricing: {},
  minPricing: { inputPerToken: '35', outputPerToken: '115' },
  maxPricing: { inputPerToken: '34500', outputPerToken: '207000' } };
const sonnet = { ...base, id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', provider: 'Anthropic',
  pricing: { inputPerToken: '3450', outputPerToken: '17250' } };
const seedream = { ...base, id: 'bytedance-seed/seedream-4.5', name: 'Seedream 4.5', provider: 'ByteDance Seed',
  modality: 'image', contextLength: 0, pricing: { perImage: '46000000' } };
const long = { ...base, id: 'nous/hermes-long', name: 'Hermes 4 405B Extended Reasoning Preview Edition',
  provider: 'Nous Research Laboratories', pricing: { inputPerToken: '1150', outputPerToken: '3450' } };

const SAMPLES = [
  ['smart', smart, 1, true],
  ['sonnet', sonnet, 1, true],
  ['seedream', seedream, 1, true],
  ['visitor', smart, 1, false],
  ['several', sonnet, 3, true],
  ['long', long, 1, true],
];

createRoot(document.getElementById('root')).render(
  h('div', { id: 'column', style: { display: 'flex', flexDirection: 'column', gap: '2rem' } },
    SAMPLES.map(([id, model, count, signedIn]) =>
      h('div', { key: id, 'data-sample': id }, h(ModelInfo, { model, selectionCount: count, signedIn })))));
globalThis.__modelInfoReady = true;
`;

function pageModules(): Plugin {
  return {
    name: 'model-info-page',
    resolveId(id) {
      return id === ENTRY_ID ? `\0${id}` : undefined;
    },
    load(id) {
      return id === `\0${ENTRY_ID}` ? ENTRY_SOURCE : undefined;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = request.url;
        if (!url?.startsWith('/model-info.html')) {
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
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'model-info-vite-'));
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
    throw new Error('model info server has no port');
  }
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    close: async () => {
      await server.close();
      await rm(cacheDir, { recursive: true, force: true });
    },
  };
}

interface LineReading {
  /** Lines the readout runs to. */
  lines: number;
  /** Whether any line begins with a separating dot. */
  dotStartsALine: boolean;
  /** Whether any glyph falls outside the column. */
  overflows: boolean;
}

declare global {
  var __modelInfoReady: boolean | undefined;
}

/**
 * Sets the screen and the column, then reads the sample's lines from the boxes of its
 * visible text. A box whose vertical middle falls inside a line already found sits on that
 * line, so a line's taller name and smaller figures count once.
 */
async function readLines(
  page: Page,
  sample: string,
  { screen, rootFontSize }: { screen: keyof typeof COLUMN_PX; rootFontSize?: string }
): Promise<LineReading> {
  await page.setViewportSize({ width: screen, height: 900 });
  return page.evaluate(
    ({ sample, columnPx, rootFontSize }) => {
      interface Box {
        top: number;
        bottom: number;
        left: number;
        right: number;
        dot: boolean;
      }

      function boxesOf(node: Node, dot: boolean): Box[] {
        const range = document.createRange();
        range.selectNodeContents(node);
        return [...range.getClientRects()]
          .filter((box) => box.width >= 0.5)
          .map((box) => ({
            top: box.top,
            bottom: box.bottom,
            left: box.left,
            right: box.right,
            dot,
          }));
      }

      function visibleTextBoxes(readout: HTMLElement): Box[] {
        const boxes: Box[] = [];
        const walker = document.createTreeWalker(readout, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          const parent = node.parentElement;
          if (!(parent instanceof HTMLElement) || parent.closest('.sr-only') !== null) continue;
          if ((node.textContent ?? '').trim() === '') continue;
          boxes.push(...boxesOf(node, parent.dataset['slot'] === 'model-info-dot'));
        }
        return boxes;
      }

      function linesOf(boxes: readonly Box[]): Box[][] {
        const lines: { top: number; bottom: number; members: Box[] }[] = [];
        for (const box of boxes.toSorted((a, b) => a.top + a.bottom - (b.top + b.bottom))) {
          const middle = (box.top + box.bottom) / 2;
          const line = lines.find((found) => middle > found.top && middle < found.bottom);
          if (line === undefined) lines.push({ top: box.top, bottom: box.bottom, members: [box] });
          else line.members.push(box);
        }
        return lines.map((line) => line.members);
      }

      function startsWithDot(line: readonly Box[]): boolean {
        let first: Box | undefined;
        for (const box of line) {
          if (first === undefined || box.left < first.left) first = box;
        }
        return first?.dot === true;
      }

      document.documentElement.style.fontSize = rootFontSize ?? '';
      const column = document.querySelector('#column');
      if (!(column instanceof HTMLElement)) throw new TypeError('no column');
      column.style.width = `${String(columnPx)}px`;
      const readout = document.querySelector(`[data-sample="${sample}"] p`);
      if (!(readout instanceof HTMLElement)) throw new TypeError(`sample ${sample} has no readout`);

      const boxes = visibleTextBoxes(readout);
      const lines = linesOf(boxes);
      const bounds = readout.getBoundingClientRect();
      return {
        lines: lines.length,
        dotStartsALine: lines.some((line) => startsWithDot(line)),
        overflows: boxes.some(
          (box) => box.left < bounds.left - 0.5 || box.right > bounds.right + 0.5
        ),
      };
    },
    { sample, columnPx: COLUMN_PX[screen], rootFontSize }
  );
}

type EngineName = 'chromium' | 'firefox';
const ENGINES: readonly EngineName[] = ['chromium', 'firefox'];
const SAMPLES = ['smart', 'sonnet', 'seedream', 'visitor', 'several', 'long'] as const;

describe('model info lines (real browser)', () => {
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
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.goto(`${server.origin}/model-info.html`, {
        waitUntil: 'commit',
        timeout: LOAD_MS,
      });
      await page.waitForFunction(() => globalThis.__modelInfoReady === true, undefined, {
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
    it(
      "reads the Smart Model's facts and rates on one line at 1440",
      async () => {
        const reading = await readLines(pageFor(engine), 'smart', { screen: 1440 });

        expect(reading.lines).toBe(1);
      },
      TEST_MS
    );

    it(
      "reads the Smart Model's facts and rates on two lines at 390",
      async () => {
        const reading = await readLines(pageFor(engine), 'smart', { screen: 390 });

        expect(reading.lines).toBe(2);
      },
      TEST_MS
    );

    it.each(SAMPLES)(
      'starts no line of the %s readout with a dot at 320',
      async (sample) => {
        const reading = await readLines(pageFor(engine), sample, { screen: 320 });

        expect(reading.dotStartsALine).toBe(false);
      },
      TEST_MS
    );

    it.each(SAMPLES)(
      'starts no line of the %s readout with a dot at 320 under 200% text',
      async (sample) => {
        const reading = await readLines(pageFor(engine), sample, {
          screen: 320,
          rootFontSize: '200%',
        });

        expect(reading.dotStartsALine).toBe(false);
      },
      TEST_MS
    );

    it.each(SAMPLES)(
      'keeps the %s readout inside the column at 320 under 200% text',
      async (sample) => {
        const reading = await readLines(pageFor(engine), sample, {
          screen: 320,
          rootFontSize: '200%',
        });

        expect(reading.overflows).toBe(false);
      },
      TEST_MS
    );
  });
});
