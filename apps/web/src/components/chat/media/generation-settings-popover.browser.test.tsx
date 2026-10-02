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
 * Lays the "Aspect ratio" grid out in real engines: whether every tile holds its own label
 * and shape is a question of glyph widths and container size, which no test DOM answers.
 * The page mounts the real popover and chip under the app stylesheet, with the image model
 * selected in the real store and the catalog read answered by a stub module. The composer
 * sits in a region as narrow as the main column left beside an open sidebar at 768, which
 * caps the anchored popover near 304px.
 *
 * Chromium and Firefox, the engines CI installs, driven by `@playwright/test` over a
 * private dev server; the page, its entry and the catalog stub are virtual modules, so no
 * fixture file joins the tree.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, '../../../..');
const SRC_DIR = path.join(WEB_DIR, 'src');
const POPOVER_FILE = path.join(HERE, 'generation-settings-popover.tsx');
const CHIP_FILE = path.join(HERE, 'ratio-chip.tsx');
const STORE_FILE = path.join(SRC_DIR, 'stores', 'model.ts');

const ENTRY_ID = 'virtual:ratio-grid-entry';
const MODELS_ID = 'virtual:ratio-grid-models';

/** The first load compiles the app's whole stylesheet, which a busy machine can make slow. */
const LOAD_MS = 90_000;
const TEST_MS = LOAD_MS + 30_000;
/** How long a click waits for the popover to answer on a loaded machine. */
const ACTION_MS = 30_000;

/** The main column beside an open sidebar at a 768 screen, which caps the popover near 304px. */
const NARROW_REGION_PX = 336;
/** The anchored popover's width in that region, with room for the measurement to drift. */
const NARROW_POPOVER_MAX_PX = 320;
/** A screen tall enough to hold the whole popover below the composer. */
const TALL_SCREEN_PX = 1024;
/** A screen whose room below the composer is shorter than the opened grid. */
const SHORT_SCREEN_PX = 520;
/** The large-text pass: 141% of the app's own root size. */
const LARGE_TEXT = 1.41;

const PAGE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>ratio grid</title></head>
  <body>
    <div id="root"></div>
    <script type="module" src="/@id/${ENTRY_ID}"></script>
  </body>
</html>`;

const MODELS_SOURCE = `
const seedream = {
  id: 'bytedance-seed/seedream-4.5', name: 'Seedream 4.5', provider: 'ByteDance Seed',
  description: 'Image model.', modality: 'image', contextLength: 0, supportedParameters: [],
  pricing: { perImage: '46000000', dearestPerImage: '46000000' },
  supportedAspectRatios: ['1:1', '1:2', '2:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16',
    '16:9', '9:19.5', '19.5:9', '9:20', '20:9', '9:21', '21:9', 'auto'],
};
export function useModels() {
  return { data: { models: [seedream], premiumIds: new Set() } };
}
`;

const ENTRY_SOURCE = `
import { createElement as h, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import '@/app.css';
import { useModelStore } from ${JSON.stringify(STORE_FILE)};
import { GenerationSettingsPopover } from ${JSON.stringify(POPOVER_FILE)};
import { RatioChip } from ${JSON.stringify(CHIP_FILE)};

useModelStore.setState({
  activeModality: 'image',
  imageConfig: { aspectRatio: '1:1' },
  selections: { text: [], image: [{ id: 'bytedance-seed/seedream-4.5', name: 'Seedream 4.5' }], audio: [], video: [] },
});

function Composer() {
  const field = useRef(null);
  return h('div', { ref: field, id: 'composer', style: { border: '1px solid', padding: '8px' } },
    h(GenerationSettingsPopover, { modality: 'image', trigger: h(RatioChip), anchor: field }));
}

createRoot(document.getElementById('root')).render(
  h('main', { style: { display: 'flex', height: '100vh' } },
    h('div', { 'data-page-slot': 'region', id: 'region',
      style: { width: '${String(NARROW_REGION_PX)}px', padding: '120px 16px 0', boxSizing: 'border-box' } },
      h(Composer))));
globalThis.__ratioGridReady = true;
`;

function pageModules(): Plugin {
  return {
    name: 'ratio-grid-page',
    enforce: 'pre',
    resolveId(id) {
      if (id === ENTRY_ID || id === MODELS_ID) return `\0${id}`;
      return id === '@/hooks/models/models' ? `\0${MODELS_ID}` : undefined;
    },
    load(id) {
      if (id === `\0${ENTRY_ID}`) return ENTRY_SOURCE;
      return id === `\0${MODELS_ID}` ? MODELS_SOURCE : undefined;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = request.url;
        if (!url?.startsWith('/ratio-grid.html')) {
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
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'ratio-grid-vite-'));
  const server: ViteDevServer = await createServer({
    root: WEB_DIR,
    configFile: false,
    cacheDir,
    logLevel: 'error',
    plugins: [pageModules(), react(), tailwindcss()],
    resolve: {
      alias: [
        { find: /^@\/(?!hooks\/models\/models$)(.*)$/, replacement: path.join(SRC_DIR, '$1') },
      ],
    },
    server: { port: 0, host: '127.0.0.1', hmr: false },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (address === null || address === undefined || typeof address === 'string') {
    throw new Error('ratio grid server has no port');
  }
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    close: async () => {
      await server.close();
      await rm(cacheDir, { recursive: true, force: true });
    },
  };
}

declare global {
  var __ratioGridReady: boolean | undefined;
}

interface GridReading {
  /** The open popover's or sheet's width. */
  readonly surfaceWidth: number;
  /** Tiles whose label or shape reaches past the tile's border. */
  readonly spilling: readonly string[];
  /** How many tiles were read, so a reading of none cannot pass. */
  readonly tiles: number;
  /** Whether the grid's own box scrolls. */
  readonly gridScrolls: boolean;
  /** Whether the popover as a whole scrolls, which would carry its title and Cost row away. */
  readonly surfaceScrolls: boolean;
}

/**
 * Loads the page at a screen width under 141% text, opens the popover from its chip, opens
 * "N more", and reads every tile: a label's glyph boxes and the shape's box must sit inside
 * the tile's border.
 */
async function readGrid(
  page: Page,
  origin: string,
  { width, height = TALL_SCREEN_PX }: { width: number; height?: number }
): Promise<GridReading> {
  await page.setViewportSize({ width, height });
  await page.goto(`${origin}/ratio-grid.html`, { waitUntil: 'commit', timeout: LOAD_MS });
  await page.waitForFunction(() => globalThis.__ratioGridReady === true, undefined, {
    timeout: LOAD_MS,
  });
  await page.evaluate((scale) => {
    const root = document.documentElement;
    const base = Number.parseFloat(getComputedStyle(root).fontSize);
    root.style.fontSize = `${String(base * scale)}px`;
  }, LARGE_TEXT);
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole('button', { name: /^Aspect ratio: / }).click({ timeout: ACTION_MS });
  const surface = page.getByRole('dialog', { name: 'Aspect ratio' });
  await surface.getByRole('button', { name: /^\d+ more$/u }).click({ timeout: ACTION_MS });
  await surface.getByRole('button', { name: 'Auto' }).waitFor({ timeout: ACTION_MS });

  return surface.evaluate((dialog) => {
    /** The shape's box and the label's glyph boxes. */
    function partsOf(tile: HTMLElement): DOMRect[] {
      const parts: DOMRect[] = [];
      const shape = tile.querySelector('svg');
      if (shape !== null) parts.push(shape.getBoundingClientRect());
      for (const node of tile.childNodes) {
        if (node.nodeType !== Node.TEXT_NODE) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        parts.push(...range.getClientRects());
      }
      return parts;
    }

    /** Whether any part of the tile reaches past its border. */
    function spills(tile: HTMLElement): boolean {
      const style = getComputedStyle(tile);
      const box = tile.getBoundingClientRect();
      const left = box.left + Number.parseFloat(style.borderLeftWidth);
      const right = box.right - Number.parseFloat(style.borderRightWidth);
      const top = box.top + Number.parseFloat(style.borderTopWidth);
      const bottom = box.bottom - Number.parseFloat(style.borderBottomWidth);
      return partsOf(tile).some(
        (rect) =>
          rect.width >= 0.5 &&
          (rect.left < left - 0.5 ||
            rect.right > right + 0.5 ||
            rect.top < top - 0.5 ||
            rect.bottom > bottom + 0.5)
      );
    }

    const grid = dialog.querySelector('fieldset');
    if (grid === null) throw new TypeError('no ratio grid');
    const scroller = grid.parentElement;
    if (scroller === null) throw new TypeError('the grid has no box');
    const tiles = [...grid.querySelectorAll('button')];
    return {
      surfaceWidth: Math.round(dialog.getBoundingClientRect().width),
      spilling: tiles.filter((tile) => spills(tile)).map((tile) => tile.textContent),
      tiles: tiles.length,
      gridScrolls: scroller.scrollHeight > scroller.clientHeight + 1,
      surfaceScrolls: dialog.scrollHeight > dialog.clientHeight + 1,
    };
  });
}

type EngineName = 'chromium' | 'firefox';
const ENGINES: readonly EngineName[] = ['chromium', 'firefox'];

describe('the aspect ratio grid (real browser)', () => {
  let server: { origin: string; close: () => Promise<void> };
  const browsers: Partial<Record<EngineName, Browser>> = {};

  beforeAll(async () => {
    server = await startServer();
    const [chromiumBrowser, firefoxBrowser] = await Promise.all([
      chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] }),
      firefox.launch(),
    ]);
    browsers.chromium = chromiumBrowser;
    browsers.firefox = firefoxBrowser;
  }, LOAD_MS);

  // Closing two browsers and the server can outlast the default hook budget on a busy machine.
  afterAll(async () => {
    await Promise.all(Object.values(browsers).map((browser) => browser.close()));
    await server.close();
  }, LOAD_MS);

  async function readOn(
    engine: EngineName,
    screen: { width: number; height?: number }
  ): Promise<GridReading> {
    const browser = browsers[engine];
    if (browser === undefined) throw new Error(`${engine} did not launch`);
    const page = await browser.newPage();
    try {
      return await readGrid(page, server.origin, screen);
    } finally {
      await page.close();
    }
  }

  describe.each(ENGINES)('on %s', (engine) => {
    it(
      'keeps every label and shape inside its tile at 768 beside an open sidebar, under 141% text',
      async () => {
        const reading = await readOn(engine, { width: 768 });

        expect(reading.surfaceWidth).toBeLessThanOrEqual(NARROW_POPOVER_MAX_PX);
        expect(reading.tiles).toBe(18);
        expect(reading.spilling).toEqual([]);
      },
      TEST_MS
    );

    it(
      'scrolls the grid, not the popover, when the room below the composer is short',
      async () => {
        const reading = await readOn(engine, { width: 768, height: SHORT_SCREEN_PX });

        expect(reading.gridScrolls).toBe(true);
        expect(reading.surfaceScrolls).toBe(false);
      },
      TEST_MS
    );

    it.each([320, 390])(
      'keeps every label and shape inside its tile in the %ipx sheet, under 141% text',
      async (width) => {
        const reading = await readOn(engine, { width });

        expect(reading.tiles).toBe(18);
        expect(reading.spilling).toEqual([]);
      },
      TEST_MS
    );
  });
});
