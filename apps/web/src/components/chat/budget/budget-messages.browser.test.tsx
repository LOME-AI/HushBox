import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, firefox, type Browser, type BrowserContextOptions } from '@playwright/test';
import { startFixtureServer, type FixtureServer } from '@/test-utils/fixture-server';
import type { Plugin } from 'vite';

/**
 * Lays out the composer's notice stack under the app stylesheet: the touch target of its
 * dismiss on a coarse pointer, the height that target leaves the notice, and how the text
 * of each notice wraps at phone widths. Hit-testing, pointer media and line breaking are
 * settled only by a layout engine.
 *
 * Chromium and Firefox, the engines CI installs, driven through `@playwright/test` over a fixture
 * server; the page and its entry are virtual modules, so no fixture file joins the tree. The
 * pointer cases run in Chromium alone, the one engine whose Playwright touch emulation turns
 * `(pointer: coarse)` on.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, '../../../..');
const SRC_DIR = path.join(WEB_DIR, 'src');

const ENTRY_ID = 'virtual:budget-messages-entry';
const PAGE_PATH = '/budget-messages.html';

/** The first load compiles the app's whole stylesheet, which a loaded machine can make slow. */
const LOAD_MS = 180_000;
const TEST_MS = LOAD_MS + 30_000;
const CLOSE_MS = 45_000;
const BROWSER_CLOSE_MS = 60_000;
const TEARDOWN_MS = BROWSER_CLOSE_MS + CLOSE_MS + 15_000;

const TOUCH_TARGET_PX = 44;

const PAGE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>budget messages</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/@id/${ENTRY_ID}"></script>
  </body>
</html>`;

// Every severity, each dismissable tone, and the links the notices carry; then a stack holding
// one dismissable notice alone, whose dismiss target meets the stack's top and bottom edges.
// `text=141` sets the accessibility widget's largest text size.
const ENTRY_SOURCE = `
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from '@tanstack/react-router';
import { notices } from '@hushbox/shared';
import '@/app.css';
import { BudgetMessages } from '@/components/chat/budget/budget-messages';

if (new URLSearchParams(location.search).get('text') === '141') {
  document.documentElement.classList.add('a11y-font-scale-141');
}
const errors = [
  notices('insufficient_funds'),
  notices('funds_held_by_run'),
  notices('answer_may_be_shortened'),
  notices('free_allowance_pays'),
  notices('trial_preview_pays'),
  notices('premium_requires_account'),
];
const alone = [notices('answer_may_be_shortened')];
function Page() {
  return h('div', { style: { padding: '0 1rem' } },
    h('div', { 'data-ready': '' }, h(BudgetMessages, { errors, className: 'mt-2' })),
    h('div', { 'data-alone': '' }, h(BudgetMessages, { errors: alone, className: 'mt-2' })));
}
const router = createRouter({
  routeTree: createRootRoute({ component: Page }),
  history: createMemoryHistory({ initialEntries: ['/'] }),
});
createRoot(document.getElementById('root')).render(h(RouterProvider, { router }));
`;

function pageModules(): Plugin {
  return {
    name: 'budget-messages-page',
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

interface Reading {
  /** Whether the page's pointer media reads coarse. */
  coarse: boolean;
  /** Each notice's drawn height, by its test id. */
  heights: Record<string, number>;
  /** Per dismiss, the probe points of the centred target square that reach another element. */
  missedProbes: Record<string, string[]>;
  /** Per notice, the link words a line break splits. */
  brokenLinks: Record<string, string[]>;
  /** The notices whose last line holds one word alone. */
  loneLastWords: string[];
}

async function read(
  browser: Browser,
  origin: string,
  context: BrowserContextOptions,
  text: 'default' | '141'
): Promise<Reading> {
  const page = await browser.newPage(context);
  try {
    await page.goto(`${origin}${PAGE_PATH}?text=${text}`, {
      timeout: LOAD_MS,
      waitUntil: 'commit',
    });
    await page.locator('[data-alone] [data-slot="notice"]').first().waitFor({ timeout: LOAD_MS });
    await page.evaluate(() => document.fonts.ready);
    // The stacks have grown in once every height tween stands at its content's height and
    // every fade at full opacity.
    await page.waitForFunction(
      () => {
        const settled = (tween: HTMLElement): boolean => {
          const content = tween.firstElementChild;
          // A notice's fade wraps its severity mark; the stack's height tween wraps the stack.
          const tweensHeight = !(
            content instanceof HTMLElement && Object.hasOwn(content.dataset, 'severity')
          );
          const atHeight =
            content instanceof HTMLElement &&
            Math.abs(tween.getBoundingClientRect().height - content.offsetHeight) < 0.5;
          return (!tweensHeight || atHeight) && getComputedStyle(tween).opacity === '1';
        };
        const tweens = [...document.querySelectorAll<HTMLElement>('[data-animated="true"]')];
        return tweens.length > 0 && tweens.every((tween) => settled(tween));
      },
      undefined,
      { timeout: LOAD_MS }
    );
    return await page.evaluate((target) => {
      const lineTops = (range: Range): Set<number> =>
        new Set(
          [...range.getClientRects()]
            .filter((rect) => rect.width > 0)
            .map((rect) => Math.round(rect.top))
        );
      // The points of the target square, centred on the dismiss, that reach another element.
      const missedProbesOf = (dismiss: HTMLElement): string[] => {
        const rect = dismiss.getBoundingClientRect();
        const reach = target / 2 - 0.1;
        const offsets = [-reach, 0, reach];
        return offsets.flatMap((dx) =>
          offsets
            .filter((dy) => {
              const hit = document.elementFromPoint(
                rect.left + rect.width / 2 + dx,
                rect.top + rect.height / 2 + dy
              );
              return hit === null || !dismiss.contains(hit);
            })
            .map((dy) => `${String(dx)},${String(dy)}`)
        );
      };
      const brokenLinksOf = (notice: HTMLElement): string[] =>
        [...notice.querySelectorAll('a')]
          .filter((link) => {
            const range = document.createRange();
            range.selectNodeContents(link);
            return lineTops(range).size > 1;
          })
          .map((link) => link.textContent);
      // The line each word of the text block ends on, as that line's top.
      const wordTops = (body: Element): number[] => {
        const tops: number[] = [];
        const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          for (const word of (node.textContent ?? '').matchAll(/\S+/g)) {
            const range = document.createRange();
            range.setStart(node, word.index);
            range.setEnd(node, word.index + word[0].length);
            tops.push(Math.max(...lineTops(range)));
          }
        }
        return tops;
      };
      const hasLoneLastWord = (body: Element): boolean => {
        const tops = wordTops(body);
        const lastTop = Math.max(...tops);
        return lastTop !== Math.min(...tops) && tops.filter((top) => top === lastTop).length === 1;
      };
      const notices = [
        ...document.querySelectorAll<HTMLElement>(
          '[data-ready] [data-slot="notice"], [data-alone] [data-slot="notice"]'
        ),
      ];
      const reading: Omit<Reading, 'coarse'> = {
        heights: {},
        missedProbes: {},
        brokenLinks: {},
        loneLastWords: [],
      };
      for (const notice of notices) {
        const stack = notice.closest('[data-alone]') === null ? 'stack' : 'alone';
        const id = `${stack}/${String(notice.dataset['testid'])}`;
        const body = notice.children[1];
        if (body === undefined) throw new Error(`${id} has no text block`);
        reading.heights[id] = notice.getBoundingClientRect().height;
        const dismiss = notice.querySelector('button');
        if (dismiss !== null) reading.missedProbes[id] = missedProbesOf(dismiss);
        reading.brokenLinks[id] = brokenLinksOf(notice);
        if (hasLoneLastWord(body)) reading.loneLastWords.push(id);
      }
      return { coarse: matchMedia('(pointer: coarse)').matches, ...reading };
    }, TOUCH_TARGET_PX);
  } finally {
    await page.close();
  }
}

const PHONE = { width: 390, height: 1200 } as const;
const FINE: BrowserContextOptions = { viewport: PHONE };
const COARSE: BrowserContextOptions = { viewport: PHONE, hasTouch: true, isMobile: true };
/** A tablet's width, where each notice fits one line and is shorter than the touch target. */
const TABLET = { width: 1024, height: 1200 } as const;
const COARSE_TABLET: BrowserContextOptions = { viewport: TABLET, hasTouch: true, isMobile: true };
const FINE_TABLET: BrowserContextOptions = { viewport: TABLET };

describe('the composer notice stack in a real engine', () => {
  let server: FixtureServer;
  const browsers: Partial<Record<EngineName, Browser>> = {};
  const readings: Record<string, Reading> = {};

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

  async function readingIn(
    engine: EngineName,
    name: string,
    context: BrowserContextOptions,
    text: 'default' | '141'
  ): Promise<Reading> {
    const browser = browsers[engine];
    if (browser === undefined) throw new Error(`${engine} did not launch`);
    const key = `${engine}/${name}/${text}`;
    readings[key] ??= await read(browser, server.url, context, text);
    return readings[key];
  }

  describe('chromium on a coarse pointer', () => {
    it(
      'reads the pointer as coarse',
      async () => {
        const coarse = await readingIn('chromium', 'coarse-phone', COARSE, 'default');
        expect(coarse.coarse).toBe(true);
      },
      TEST_MS
    );

    describe.each([
      { name: 'phone', coarse: COARSE, fine: FINE },
      { name: 'tablet', coarse: COARSE_TABLET, fine: FINE_TABLET },
    ])('at a $name width', ({ name, coarse: coarseContext, fine: fineContext }) => {
      it(
        'answers every point of a 44px square centred on each dismiss',
        async () => {
          const coarse = await readingIn('chromium', `coarse-${name}`, coarseContext, 'default');
          expect(coarse.missedProbes).toEqual({
            'stack/budget-message-answer_may_be_shortened': [],
            'stack/budget-message-free_allowance_pays': [],
            'stack/budget-message-trial_preview_pays': [],
            'alone/budget-message-answer_may_be_shortened': [],
          });
        },
        TEST_MS
      );

      it(
        "keeps each notice at a fine pointer's height",
        async () => {
          const fine = await readingIn('chromium', `fine-${name}`, fineContext, 'default');
          const coarse = await readingIn('chromium', `coarse-${name}`, coarseContext, 'default');
          expect(fine.coarse).toBe(false);
          expect(coarse.heights).toEqual(fine.heights);
        },
        TEST_MS
      );
    });
  });

  // A literal percent sign in a `describe.each` title is read as a placeholder.
  describe.each(ENGINES)('%s', (engine) => {
    describe.each([
      { width: 320, text: 'default' as const, label: 'default text' },
      { width: 390, text: 'default' as const, label: 'default text' },
      { width: 320, text: '141' as const, label: 'the 141 percent text size' },
      { width: 390, text: '141' as const, label: 'the 141 percent text size' },
    ])('at $width wide with $label', ({ width, text }) => {
      const context: BrowserContextOptions = { viewport: { width, height: 1200 } };
      const name = `fine-${String(width)}`;

      it(
        'keeps the words of every link on one line',
        async () => {
          const reading = await readingIn(engine, name, context, text);
          const broken = Object.entries(reading.brokenLinks).filter(
            ([, words]) => words.length > 0
          );
          expect(Object.fromEntries(broken)).toEqual({});
        },
        TEST_MS
      );

      it(
        'leaves no notice a last line of one word',
        async () => {
          const reading = await readingIn(engine, name, context, text);
          expect(reading.loneLastWords).toEqual([]);
        },
        TEST_MS
      );
    });
  });
});
