import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, firefox, type Browser, type Page } from '@playwright/test';
import { startFixtureServer, type FixtureServer } from '@/test-utils/fixture-server';

/**
 * Places the reply's cost breakdown in real engines: whether it stays inside the transcript is
 * a question of the room on each side of the pill, which no test DOM measures. The page mounts
 * the real pill at the end of a transcript scroller that sits beside a sidebar and above a
 * composer, under the app stylesheet; the page and its entry are virtual modules, so no fixture
 * file joins the tree.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, '../../../..');
const SRC_DIR = path.join(WEB_DIR, 'src');
const PILL_FILE = path.join(HERE, 'cost-pill.tsx');

const ENTRY_ID = 'virtual:cost-pill-entry';

/** The first load compiles the app's whole stylesheet, which a busy machine can make slow. */
const LOAD_MS = 90_000;
const TEST_MS = LOAD_MS + 30_000;
/** How long a click waits for the breakdown to answer on a loaded machine. */
const ACTION_MS = 30_000;
/** The large-text pass: 141% of the app's own root size. */
const LARGE_TEXT = 1.41;
/** A box edge read across two layout boxes rounds differently per engine; this much is rounding. */
const SUBPIXEL_PX = 1;

const PAGE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>cost pill</title></head>
  <body>
    <div id="root"></div>
    <script type="module" src="/@id/${ENTRY_ID}"></script>
  </body>
</html>`;

// The transcript scroller carries the slot the app's message list gives its scroller. The
// sidebar and the composer are sized in rem, so the large-text pass narrows the transcript and
// leaves the composer room enough below the pill for the breakdown to open over it.
const ENTRY_SOURCE = `
import { StrictMode, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import '@/app.css';
import { CostPill } from ${JSON.stringify(PILL_FILE)};

createRoot(document.getElementById('root')).render(h(StrictMode, null,
  h('div', { style: { display: 'flex', height: '100vh' } },
    h('aside', { id: 'sidebar', style: { width: '18rem', flex: 'none' } }),
    h('main', { style: { flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column' } },
      h('div', { 'data-slot': 'scroll-area-viewport', id: 'transcript',
        style: { flex: '1 1 0', minHeight: 0, overflow: 'auto' } },
        h('div', { style: { height: '1600px' } }),
        h('div', { style: { padding: '0 1.5rem 1rem' } },
          h(CostPill, { cost: '11800000', inputTokens: 1862, outputTokens: 412 }))),
      h('div', { id: 'composer', style: { height: '16rem', flex: 'none' } })))));
globalThis.__costPillReady = true;
`;

function pageModules(): Plugin {
  return {
    name: 'cost-pill-page',
    enforce: 'pre',
    resolveId(id) {
      return id === ENTRY_ID ? `\0${id}` : undefined;
    },
    load(id) {
      return id === `\0${ENTRY_ID}` ? ENTRY_SOURCE : undefined;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = request.url;
        if (!url?.startsWith('/cost-pill.html')) {
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
  var __costPillReady: boolean | undefined;
}

/** How far each edge of the open breakdown reaches past the transcript's box; 0 when inside. */
interface Overreach {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/**
 * Loads the page at a screen size and text scale, scrolls the transcript to its end, opens the
 * breakdown from the pill and reads how far it reaches past the transcript on each side.
 */
async function overreach(
  page: Page,
  origin: string,
  { width, height, scale }: { width: number; height: number; scale: number }
): Promise<Overreach> {
  await page.setViewportSize({ width, height });
  await page.goto(`${origin}/cost-pill.html`, { waitUntil: 'commit', timeout: LOAD_MS });
  await page.waitForFunction(() => globalThis.__costPillReady === true, undefined, {
    timeout: LOAD_MS,
  });
  await page.evaluate((factor) => {
    const root = document.documentElement;
    const base = Number.parseFloat(getComputedStyle(root).fontSize);
    root.style.fontSize = `${String(base * factor)}px`;
    const transcript = document.querySelector('#transcript');
    if (transcript === null) throw new TypeError('no transcript');
    transcript.scrollTop = transcript.scrollHeight;
  }, scale);
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole('button', { name: /^Cost / }).click({ timeout: ACTION_MS });
  const surface = page.getByRole('dialog', { name: 'This reply' });
  await surface.waitFor({ timeout: ACTION_MS });
  return surface.evaluate(async (dialog) => {
    // The breakdown slides and scales in; it is read where it comes to rest.
    await Promise.all(dialog.getAnimations().map((animation) => animation.finished));
    const transcript = document.querySelector('#transcript');
    if (transcript === null) throw new TypeError('no transcript');
    const box = dialog.getBoundingClientRect();
    const room = transcript.getBoundingClientRect();
    return {
      left: Math.max(0, room.left - box.left),
      right: Math.max(0, box.right - room.right),
      top: Math.max(0, room.top - box.top),
      bottom: Math.max(0, box.bottom - room.bottom),
    };
  });
}

/** The breakdown's list as laid out: where its columns start and how far apart its rows sit. */
interface ListReading {
  /** Each value's left edge less the longest label's right edge, in rem. */
  readonly valueOffsets: readonly number[];
  /** Each row's label top less the label above's bottom, in rem. */
  readonly rowGaps: readonly number[];
}

/** Loads the page at 1440, opens the breakdown and reads its list against the root size. */
async function readList(page: Page, origin: string): Promise<ListReading> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}/cost-pill.html`, { waitUntil: 'commit', timeout: LOAD_MS });
  await page.waitForFunction(() => globalThis.__costPillReady === true, undefined, {
    timeout: LOAD_MS,
  });
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole('button', { name: /^Cost / }).click({ timeout: ACTION_MS });
  const surface = page.getByRole('dialog', { name: 'This reply' });
  await surface.waitFor({ timeout: ACTION_MS });
  return surface.evaluate(async (dialog) => {
    await Promise.all(dialog.getAnimations().map((animation) => animation.finished));
    const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    const labels = [...dialog.querySelectorAll('dt')].map((dt) => dt.getBoundingClientRect());
    const values = [...dialog.querySelectorAll('dd')].map((dd) => {
      const range = document.createRange();
      range.selectNodeContents(dd);
      return range.getBoundingClientRect();
    });
    const labelEnd = Math.max(...labels.map((label) => label.right));
    const round = (value: number): number => Math.round((value / rem) * 1000) / 1000;
    return {
      valueOffsets: values.map((value) => round(value.left - labelEnd)),
      rowGaps: labels
        .slice(1)
        .map((label, index) => round(label.top - (labels[index]?.bottom ?? 0))),
    };
  });
}

const INSIDE: Overreach = { left: 0, right: 0, top: 0, bottom: 0 };

type EngineName = 'chromium' | 'firefox';
const ENGINES: readonly EngineName[] = ['chromium', 'firefox'];

describe('the reply cost breakdown (real browser)', () => {
  let server: FixtureServer;
  const browsers: Partial<Record<EngineName, Browser>> = {};

  beforeAll(async () => {
    server = await startFixtureServer({
      root: WEB_DIR,
      configFile: false,
      plugins: [pageModules(), react(), tailwindcss()],
      resolve: { alias: [{ find: /^@\/(.*)$/, replacement: path.join(SRC_DIR, '$1') }] },
    });
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
    screen: { width: number; height: number; scale: number }
  ): Promise<Overreach> {
    const browser = browsers[engine];
    if (browser === undefined) throw new Error(`${engine} did not launch`);
    const page = await browser.newPage();
    try {
      return await overreach(page, server.url, screen);
    } finally {
      await page.close();
    }
  }

  /** Each overreach rounded down to whole pixels past the subpixel allowance. */
  function settled(reading: Overreach): Overreach {
    const past = (value: number): number => (value <= SUBPIXEL_PX ? 0 : Math.round(value));
    return {
      left: past(reading.left),
      right: past(reading.right),
      top: past(reading.top),
      bottom: past(reading.bottom),
    };
  }

  async function listOn(engine: EngineName): Promise<ListReading> {
    const browser = browsers[engine];
    if (browser === undefined) throw new Error(`${engine} did not launch`);
    const page = await browser.newPage();
    try {
      return await readList(page, server.url);
    } finally {
      await page.close();
    }
  }

  describe.each(ENGINES)('on %s', (engine) => {
    it(
      'starts every value 1rem after the longest label, left-aligned',
      async () => {
        const { valueOffsets } = await listOn(engine);

        expect(valueOffsets).toHaveLength(3);
        for (const offset of valueOffsets) expect(offset).toBeCloseTo(1, 1);
      },
      TEST_MS
    );

    it(
      'sets its rows 0.375rem apart',
      async () => {
        const { rowGaps } = await listOn(engine);

        expect(rowGaps).toHaveLength(2);
        for (const gap of rowGaps) expect(gap).toBeCloseTo(0.375, 1);
      },
      TEST_MS
    );

    it(
      'stays inside the transcript at 768 under 141% text',
      async () => {
        const reading = await readOn(engine, { width: 768, height: 1024, scale: LARGE_TEXT });

        expect(settled(reading)).toEqual(INSIDE);
      },
      TEST_MS
    );

    it(
      'stays inside the transcript near the thread end at 1440',
      async () => {
        const reading = await readOn(engine, { width: 1440, height: 900, scale: 1 });

        expect(settled(reading)).toEqual(INSIDE);
      },
      TEST_MS
    );
  });
});
