import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, firefox, type Browser } from '@playwright/test';
import { startFixtureServer, type FixtureServer } from '@/test-utils/fixture-server';
import type { Plugin } from 'vite';

/**
 * Measures where a turn notice's icon (the tile's disc, the slot's bare icon) and its Copy sit
 * against the text block beside them, for text of one, two and three lines, under the app
 * stylesheet. Whether a grid row centres them on the whole block is something only a layout
 * engine settles.
 *
 * Chromium and Firefox, the engines CI installs, driven through `@playwright/test` over a fixture
 * server; the page and its entry are virtual modules, so no fixture file joins the tree.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, '../../../..');
const SRC_DIR = path.join(WEB_DIR, 'src');

const ENTRY_ID = 'virtual:turn-notice-geometry-entry';
const PAGE_PATH = '/turn-notice-geometry.html';
const LARGE_TEXT_ENTRY_ID = 'virtual:turn-notice-large-text-entry';
const LARGE_TEXT_PAGE_PATH = '/turn-notice-large-text.html';

/** The first load compiles the app's whole stylesheet, which a loaded machine can make slow. */
const LOAD_MS = 180_000;
const TEST_MS = LOAD_MS + 30_000;
const CLOSE_MS = 45_000;
/** Closing both browsers has outlasted 15 seconds on a loaded host, so it has its own budget. */
const BROWSER_CLOSE_MS = 60_000;
/** The teardown's waits, the browsers' close and then the fixture server's, plus a margin. */
const TEARDOWN_MS = BROWSER_CLOSE_MS + CLOSE_MS + 15_000;

function pageHtml(entryId: string): string {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>turn notice geometry</title></head>
  <body>
    <div id="root"></div>
    <script type="module" src="/@id/${entryId}"></script>
  </body>
</html>`;
}

// Each sample's column width sets how many lines its sentence wraps to: a one-sentence code
// reads as its cause alone, and a narrower column wraps a two-sentence code further.
const SAMPLES: readonly { id: string; code: string; width: string; lines: number }[] = [
  { id: 'one', code: 'INCORRECT_PASSWORD', width: '40rem', lines: 1 },
  { id: 'two', code: 'UNAVAILABLE', width: '40rem', lines: 2 },
  { id: 'three', code: 'UNAVAILABLE', width: '19rem', lines: 3 },
];

const ENTRY_SOURCE = `
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import '@/app.css';
import { TurnNoticeView } from '@/components/chat/notice/turn-notice-view';
import { turnNoticeForCode } from '@/lib/chat/turn-notice';

const samples = ${JSON.stringify(SAMPLES)};

createRoot(document.getElementById('root')).render(
  h('div', { style: { display: 'flex', flexDirection: 'column', gap: '1rem', padding: '1rem' } },
    ['tile', 'slot'].flatMap((placement) =>
      samples.map(({ id, code, width }) =>
        h('div', { key: placement + id, 'data-sample': placement + '-' + id, style: { width } },
          h(TurnNoticeView, { placement, notice: turnNoticeForCode(code), onRegenerate: () => {} })
        )
      )
    )
  )
);
`;

// A 320 viewport with the accessibility widget's 141% text (`?text=default` leaves the root's text
// size as it is), a thread-wide column with a 1rem gutter, the turn notices with their longest words
// and a link, and the notice kit section, which draws every other placement: the composer stack, a
// tile, a slot and inline notices.
const LARGE_TEXT_ENTRY_SOURCE = `
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from '@tanstack/react-router';
import '@/app.css';
import { TurnNoticeView } from '@/components/chat/notice/turn-notice-view';
import { turnNoticeForCode } from '@/lib/chat/turn-notice';
import { trialRefusalFor } from '@/lib/chat/trial-refusals';
import noticeSection from '@/components/dev/kit/notice.section';

if (new URLSearchParams(location.search).get('text') !== 'default') {
  document.documentElement.classList.add('a11y-font-scale-141');
}
const view = (id, placement, notice) =>
  h('div', { 'data-sample': id }, h(TurnNoticeView, { placement, notice, onRegenerate: () => {} }));
function Samples() {
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '1rem', padding: '0 1rem' } },
    view('tile-unavailable', 'tile', turnNoticeForCode('UNAVAILABLE')),
    view('tile-concurrent', 'tile', turnNoticeForCode('CONCURRENT_RUN')),
    view('tile-trial', 'tile', trialRefusalFor({ code: 'TRIAL_LIMIT_REACHED' }).notice),
    view('slot-stream', 'slot', turnNoticeForCode('STREAM_ERROR')),
    view('slot-rotation', 'slot', turnNoticeForCode('ROTATION_PENDING')),
    h('div', { 'data-sample': 'kit' }, noticeSection.render())
  );
}
const router = createRouter({
  routeTree: createRootRoute({ component: Samples }),
  history: createMemoryHistory({ initialEntries: ['/'] }),
});
createRoot(document.getElementById('root')).render(h(RouterProvider, { router }));
`;

const PAGES: Readonly<Record<string, { entryId: string; source: string }>> = {
  [PAGE_PATH]: { entryId: ENTRY_ID, source: ENTRY_SOURCE },
  [LARGE_TEXT_PAGE_PATH]: { entryId: LARGE_TEXT_ENTRY_ID, source: LARGE_TEXT_ENTRY_SOURCE },
};

function pageModules(): Plugin {
  return {
    name: 'turn-notice-geometry-page',
    resolveId(id) {
      return Object.values(PAGES).some((page) => page.entryId === id) ? `\0${id}` : undefined;
    },
    load(id) {
      return Object.values(PAGES).find((page) => `\0${page.entryId}` === id)?.source;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = request.url;
        const page = url === undefined ? undefined : PAGES[url.split('?')[0] ?? ''];
        if (url === undefined || page === undefined) {
          next();
          return;
        }
        void (async (): Promise<void> => {
          try {
            const html = await server.transformIndexHtml(url, pageHtml(page.entryId));
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

type EngineName = 'chromium' | 'firefox';
const ENGINES: readonly EngineName[] = ['chromium', 'firefox'];

interface Geometry {
  /** How many lines the text block wraps to. */
  lines: number;
  /** The icon's vertical centre less the text block's, in px. */
  iconOffset: number;
  /** Copy's vertical centre less the text block's, in px. */
  copyOffset: number;
}

async function measure(browser: Browser, origin: string): Promise<Record<string, Geometry>> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1600 } });
  try {
    await page.goto(`${origin}${PAGE_PATH}`, { timeout: LOAD_MS, waitUntil: 'commit' });
    await page.locator('[data-sample="slot-three"] [data-slot="notice"]').waitFor({
      timeout: LOAD_MS,
    });
    await page.evaluate(() => document.fonts.ready);
    return await page.evaluate(() => {
      const centre = (rect: DOMRect): number => rect.top + rect.height / 2;
      // Line boxes come from the text nodes alone: a range over an element also returns the
      // element's own box in Firefox, which would count as a line of its own.
      const lineCount = (text: Element): number => {
        const tops = new Set<number>();
        const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const rect of range.getClientRects()) tops.add(Math.round(rect.top));
        }
        return tops.size;
      };
      const geometryOf = (sample: HTMLElement): Geometry => {
        const notice = sample.querySelector('[data-slot="notice"]');
        const icon = notice?.children[0];
        const text = notice?.children[1];
        const copy = notice?.querySelector('button[aria-label="Copy"]');
        if (icon === undefined || text === undefined || !copy) {
          throw new Error('a sample is missing its icon, its text or its Copy');
        }
        const textRect = text.getBoundingClientRect();
        return {
          lines: lineCount(text),
          iconOffset: centre(icon.getBoundingClientRect()) - centre(textRect),
          copyOffset: centre(copy.getBoundingClientRect()) - centre(textRect),
        };
      };
      const result: Record<string, Geometry> = {};
      for (const sample of document.querySelectorAll<HTMLElement>('[data-sample]')) {
        const id = sample.dataset['sample'];
        if (id === undefined) throw new Error('a sample has no id');
        result[id] = geometryOf(sample);
      }
      return result;
    });
  } finally {
    await page.close();
  }
}

interface Containment {
  /** How far, in px, any line of the text runs past its text column on either side. */
  overrun: number;
  /** Whether any line of the text meets the corner control's box. */
  underControl: boolean;
}

/** Each notice on the large-text page, keyed `<sample>/<placement>/<index in the sample>`. */
async function measureLargeText(
  browser: Browser,
  origin: string
): Promise<Record<string, Containment>> {
  const page = await browser.newPage({ viewport: { width: 320, height: 1600 } });
  try {
    await page.goto(`${origin}${LARGE_TEXT_PAGE_PATH}`, { timeout: LOAD_MS, waitUntil: 'commit' });
    await page.locator('[data-sample="kit"] [data-slot="notice"]').first().waitFor({
      timeout: LOAD_MS,
    });
    await page.evaluate(() => document.fonts.ready);
    return await page.evaluate(() => {
      const lineRects = (text: Element): DOMRect[] => {
        const rects: DOMRect[] = [];
        const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          const range = document.createRange();
          range.selectNodeContents(node);
          rects.push(...[...range.getClientRects()].filter((rect) => rect.width > 0));
        }
        return rects;
      };
      const meets = (a: DOMRect, b: DOMRect): boolean =>
        a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      const containmentOf = (notice: Element): Containment => {
        const [, text, end] = [...notice.children];
        if (text === undefined) throw new Error('a notice has no text block');
        const column = text.getBoundingClientRect();
        const control = end?.querySelector('button')?.getBoundingClientRect();
        const lines = lineRects(text);
        return {
          overrun: Math.max(
            0,
            ...lines.map((line) => Math.max(column.left - line.left, line.right - column.right))
          ),
          underControl: control !== undefined && lines.some((line) => meets(line, control)),
        };
      };
      const result: Record<string, Containment> = {};
      for (const sample of document.querySelectorAll<HTMLElement>('[data-sample]')) {
        const counts: Record<string, number> = {};
        for (const notice of sample.querySelectorAll<HTMLElement>('[data-slot="notice"]')) {
          const placement = notice.dataset['placement'] ?? 'inline';
          const index = counts[placement] ?? 0;
          counts[placement] = index + 1;
          result[`${sample.dataset['sample'] ?? ''}/${placement}/${String(index)}`] =
            containmentOf(notice);
        }
      }
      return result;
    });
  } finally {
    await page.close();
  }
}

/** A box's edges, in px from its tile's top left corner. */
interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface TileLayout {
  tile: Box;
  icon: Box;
  text: Box;
  corner: Box | undefined;
  actions: Box | undefined;
  /** The words of the text that a line break splits. */
  brokenWords: string[];
}

interface TileView {
  width: number;
  text: 'default' | 'large';
}

/** Each tile on the large-text page, keyed `<sample>/<index in the sample>`. */
async function measureTiles(
  browser: Browser,
  origin: string,
  view: TileView
): Promise<Record<string, TileLayout>> {
  const page = await browser.newPage({ viewport: { width: view.width, height: 1600 } });
  try {
    const query = view.text === 'default' ? '?text=default' : '';
    await page.goto(`${origin}${LARGE_TEXT_PAGE_PATH}${query}`, {
      timeout: LOAD_MS,
      waitUntil: 'commit',
    });
    await page.locator('[data-sample="kit"] [data-placement="tile"]').first().waitFor({
      timeout: LOAD_MS,
    });
    await page.evaluate(() => document.fonts.ready);
    return await page.evaluate(() => {
      const boxOf = (element: Element, origin: DOMRect): Box => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left - origin.left,
          top: rect.top - origin.top,
          right: rect.right - origin.left,
          bottom: rect.bottom - origin.top,
        };
      };
      // A word is split when its own range draws on more than one line.
      const brokenWords = (text: Element): string[] => {
        const broken: string[] = [];
        const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          for (const word of (node.textContent ?? '').matchAll(/\S+/g)) {
            const range = document.createRange();
            range.setStart(node, word.index);
            range.setEnd(node, word.index + word[0].length);
            const tops = new Set(
              [...range.getClientRects()]
                .filter((rect) => rect.width > 0)
                .map((rect) => Math.round(rect.top))
            );
            if (tops.size > 1) broken.push(word[0]);
          }
        }
        return broken;
      };
      const layoutOf = (tile: Element): TileLayout => {
        const [icon, text, ...rest] = [...tile.children];
        if (icon === undefined || text === undefined) {
          throw new Error('a tile is missing its icon or its text');
        }
        const corner = rest.find((part) => part.querySelector('button[aria-label="Copy"]'));
        const actions = rest.find((part) => part !== corner);
        const origin = tile.getBoundingClientRect();
        return {
          tile: boxOf(tile, origin),
          icon: boxOf(icon, origin),
          text: boxOf(text, origin),
          corner: corner === undefined ? undefined : boxOf(corner, origin),
          actions: actions === undefined ? undefined : boxOf(actions, origin),
          brokenWords: brokenWords(text),
        };
      };
      const result: Record<string, TileLayout> = {};
      for (const sample of document.querySelectorAll<HTMLElement>('[data-sample]')) {
        const tiles = sample.querySelectorAll('[data-slot="notice"][data-placement="tile"]');
        for (const [index, tile] of [...tiles].entries()) {
          result[`${sample.dataset['sample'] ?? ''}/${String(index)}`] = layoutOf(tile);
        }
      }
      return result;
    });
  } finally {
    await page.close();
  }
}

interface ResizeRun {
  /** Whether the tile was stacked after each width it was given. */
  stacked: boolean[];
  /** The window errors the resizes raised. */
  errors: string[];
}

// A tile whose words stack it in a 280px container and not in a 700px one, so each change of
// the container's width moves it across the stacking point.
const RESIZED_SAMPLE = 'tile-unavailable';
const RESIZE_WIDTHS = ['280px', '700px', '280px', '700px', '280px', '700px'];

/** Resizes one tile's container back and forth across its stacking point at 141% text. */
async function resizeAcrossStacking(browser: Browser, origin: string): Promise<ResizeRun> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1600 } });
  try {
    await page.goto(`${origin}${LARGE_TEXT_PAGE_PATH}`, { timeout: LOAD_MS, waitUntil: 'commit' });
    await page.locator('[data-sample="kit"] [data-placement="tile"]').first().waitFor({
      timeout: LOAD_MS,
    });
    await page.evaluate(() => document.fonts.ready);
    return await page.evaluate(
      async ({ sample, widths }) => {
        const container = document.querySelector<HTMLElement>(`[data-sample="${sample}"]`);
        const tile = container?.querySelector<HTMLElement>('[data-slot="notice"]');
        if (!container || !tile) throw new Error(`no tile under ${sample}`);
        const errors: string[] = [];
        const record = (event: ErrorEvent): void => {
          errors.push(event.message);
        };
        globalThis.addEventListener('error', record);
        const frame = (): Promise<number> =>
          new Promise((resolve) => globalThis.requestAnimationFrame(resolve));
        const stacked: boolean[] = [];
        for (const width of widths) {
          container.style.width = width;
          for (let count = 0; count < 4; count += 1) await frame();
          stacked.push(Object.hasOwn(tile.dataset, 'stacked'));
        }
        globalThis.removeEventListener('error', record);
        return { stacked, errors };
      },
      { sample: RESIZED_SAMPLE, widths: RESIZE_WIDTHS }
    );
  } finally {
    await page.close();
  }
}

describe('turn notice geometry in a real engine', () => {
  let server: FixtureServer;
  const browsers: Partial<Record<EngineName, Browser>> = {};
  const measured: Partial<Record<EngineName, Record<string, Geometry>>> = {};
  const contained: Partial<Record<EngineName, Record<string, Containment>>> = {};

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

  async function geometryIn(engine: EngineName, id: string): Promise<Geometry> {
    const browser = browsers[engine];
    if (browser === undefined) throw new Error(`${engine} did not launch`);
    measured[engine] ??= await measure(browser, server.url);
    const geometry = measured[engine][id];
    if (geometry === undefined) throw new Error(`no sample ${id}`);
    return geometry;
  }

  describe.each(ENGINES)('%s', (engine) => {
    describe.each(['tile', 'slot'])('as a %s', (placement) => {
      describe.each(SAMPLES)('with $lines line(s) of text', ({ id, lines }) => {
        const sample = `${placement}-${id}`;

        it(
          `wraps its text to ${String(lines)} line(s)`,
          async () => {
            const geometry = await geometryIn(engine, sample);
            expect(geometry.lines).toBe(lines);
          },
          TEST_MS
        );

        it(
          'centres its icon on the whole text block',
          async () => {
            const { iconOffset } = await geometryIn(engine, sample);
            expect(Math.abs(iconOffset)).toBeLessThanOrEqual(0.5);
          },
          TEST_MS
        );

        it(
          'centres Copy on the whole text block',
          async () => {
            const { copyOffset } = await geometryIn(engine, sample);
            expect(Math.abs(copyOffset)).toBeLessThanOrEqual(0.5);
          },
          TEST_MS
        );
      });
    });
  });
  async function containmentIn(engine: EngineName, prefix: string): Promise<Containment[]> {
    const browser = browsers[engine];
    if (browser === undefined) throw new Error(`${engine} did not launch`);
    contained[engine] ??= await measureLargeText(browser, server.url);
    const found = Object.entries(contained[engine])
      .filter(([key]) => key.startsWith(prefix))
      .map(([, containment]) => containment);
    if (found.length === 0) throw new Error(`no notice under ${prefix}`);
    return found;
  }

  // The turn notices, then the notice kit section: its tile, its slot, the composer stack and
  // the inline notices.
  const LARGE_TEXT_SAMPLES = [
    'tile-unavailable/',
    'tile-concurrent/',
    'tile-trial/',
    'slot-stream/',
    'slot-rotation/',
    'kit/tile/',
    'kit/slot/',
    'kit/composer/',
    'kit/inline/',
  ];

  // A literal percent sign in a `describe.each` title is read as a placeholder, so the engine
  // goes into a plain title.
  for (const engine of ENGINES) {
    describe(`${engine} at 320 with 141% text`, () => {
      describe.each(LARGE_TEXT_SAMPLES)('the notices under %s', (prefix) => {
        it(
          'keep every line of their text inside its column',
          async () => {
            const found = await containmentIn(engine, prefix);
            expect(Math.max(...found.map(({ overrun }) => overrun))).toBeLessThanOrEqual(0.5);
          },
          TEST_MS
        );

        it(
          'keep their text clear of the corner control',
          async () => {
            const found = await containmentIn(engine, prefix);
            expect(found.filter(({ underControl }) => underControl)).toHaveLength(0);
          },
          TEST_MS
        );
      });
    });
  }

  const tiled: Record<string, Record<string, TileLayout>> = {};

  async function tilesIn(engine: EngineName, view: TileView): Promise<[string, TileLayout][]> {
    const browser = browsers[engine];
    if (browser === undefined) throw new Error(`${engine} did not launch`);
    const key = `${engine}/${String(view.width)}/${view.text}`;
    tiled[key] ??= await measureTiles(browser, server.url, view);
    const found = Object.entries(tiled[key]);
    if (found.length === 0) throw new Error('no tile on the page');
    return found;
  }

  function offenders(
    tiles: readonly [string, TileLayout][],
    fails: (layout: TileLayout) => boolean
  ): string[] {
    return tiles.filter(([, layout]) => fails(layout)).map(([id]) => id);
  }

  /** Whether a tile's text is anywhere but on the icon's row, to its right. */
  const notBesideIcon = ({ icon, text }: TileLayout): boolean =>
    text.left < icon.right || text.top >= icon.bottom;

  /** Whether a tile's text starts below its icon and its corner control. */
  const notBelowIcon = ({ icon, corner, text }: TileLayout): boolean =>
    text.top < icon.bottom || (corner !== undefined && text.top < corner.bottom);

  describe.each(ENGINES)('%s at 320 with the 141 percent text size, every tile', (engine) => {
    const view: TileView = { width: 320, text: 'large' };

    it(
      'keeps each word of its text whole',
      async () => {
        const tiles = await tilesIn(engine, view);
        const broken = tiles.filter(([, layout]) => layout.brokenWords.length > 0);
        expect(Object.fromEntries(broken.map(([id, layout]) => [id, layout.brokenWords]))).toEqual(
          {}
        );
      },
      TEST_MS
    );

    // Beside the icon and Copy each tile's column is narrower than a word of its text or
    // than six of its ems, the trial limit's by the second alone.
    it(
      'sets its icon and its corner control above its text',
      async () => {
        const tiles = await tilesIn(engine, view);
        expect(offenders(tiles, notBelowIcon)).toEqual([]);
      },
      TEST_MS
    );

    it(
      'keeps its actions below its text',
      async () => {
        const tiles = await tilesIn(engine, view);
        expect(
          offenders(
            tiles,
            ({ actions, text }) => actions !== undefined && actions.top < text.bottom
          )
        ).toEqual([]);
      },
      TEST_MS
    );
  });

  describe.each(ENGINES)(
    '%s at 375 with the 141 percent text size, the trial limit tile',
    (engine) => {
      it(
        'keeps its text beside its icon, its column holding six of its ems',
        async () => {
          const tiles = await tilesIn(engine, { width: 375, text: 'large' });
          const trial = tiles.filter(([id]) => id.startsWith('tile-trial/'));
          expect(trial).toHaveLength(1);
          expect(offenders(trial, notBesideIcon)).toEqual([]);
        },
        TEST_MS
      );
    }
  );

  describe.each(ENGINES)('%s with its container resized across the stacking point', (engine) => {
    const runs: Partial<Record<EngineName, ResizeRun>> = {};

    async function runIn(): Promise<ResizeRun> {
      const browser = browsers[engine];
      if (browser === undefined) throw new Error(`${engine} did not launch`);
      runs[engine] ??= await resizeAcrossStacking(browser, server.url);
      return runs[engine];
    }

    it(
      'stacks and unstacks the tile as its width crosses the point',
      async () => {
        const { stacked } = await runIn();
        expect(stacked).toEqual([true, false, true, false, true, false]);
      },
      TEST_MS
    );

    it(
      'raises no window error',
      async () => {
        const { errors } = await runIn();
        expect(errors).toEqual([]);
      },
      TEST_MS
    );
  });

  describe.each(ENGINES)('%s at default text', (engine) => {
    describe.each([320, 390, 1440])('at %i wide, every tile', (width) => {
      it(
        'keeps its text beside its icon',
        async () => {
          const tiles = await tilesIn(engine, { width, text: 'default' });
          expect(offenders(tiles, notBesideIcon)).toEqual([]);
        },
        TEST_MS
      );
    });
  });
});
