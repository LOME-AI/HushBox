import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, firefox, type Browser, type Page } from '@playwright/test';
import { startFixtureServer, type FixtureServer } from '@/test-utils/fixture-server';
import type { Plugin } from 'vite';

/**
 * Measures where a popover lands in real engines, under the app stylesheet: which side it opens
 * on, how tall it may grow, whether it stays inside a boundary, and what it hangs from. The
 * positioning runs on measured layout, so only a layout engine can settle it.
 *
 * Chromium and Firefox, the engines CI installs, driven through `@playwright/test` over a fixture
 * server; the page and its entry are virtual modules, so no fixture file joins the tree.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, '../../../..');
const SRC_DIR = path.join(WEB_DIR, 'src');

const ENTRY_ID = 'virtual:popover-place-entry';
const PAGE_PATH = '/popover-place.html';

/** The first load compiles the app's whole stylesheet, which a busy machine can make slow. */
const LOAD_MS = 90_000;
const TEST_MS = LOAD_MS + 30_000;
const CLOSE_MS = 45_000;

/**
 * The popover is placed after its content is measured by a ResizeObserver, so a loaded machine
 * can hold the placement back for many seconds; this waits that long before calling it a failure.
 */
const PLACEMENT_MS = 30_000;

const VIEWPORT = { width: 1440, height: 900 } as const;
const PHONE_VIEWPORT = { width: 390, height: 844 } as const;

/** What the component keeps between itself and the viewport's or boundary's edge. */
const COLLISION_PADDING_PX = 16;
/** What the component keeps between itself and what it hangs from. */
const SIDE_OFFSET_PX = 8;

const ANCHOR_RECT = { x: 900, y: 400, width: 20, height: 20 } as const;

const PAGE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>popover placement</title></head>
  <body>
    <div id="root"></div>
    <script type="module" src="/@id/${ENTRY_ID}"></script>
  </body>
</html>`;

// `case` picks the scene; `top` places the trigger, `body` sizes the popover's content,
// `bounded` hands the column to the popover as its boundary and `height` sets the column's height.
const ENTRY_SOURCE = `
import { createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@/app.css';
import { Popover, PopoverFact, Tooltip, TooltipTrigger, TooltipContent } from '@hushbox/ui/popover';
import { Lock } from '@hushbox/ui/icons';

const query = new URLSearchParams(location.search);
const noop = () => {};
const body = h('div', { id: 'body', style: { height: (query.get('body') ?? '200') + 'px' } }, 'Body');
const anchor = {
  getBoundingClientRect: () =>
    new DOMRect(${String(ANCHOR_RECT.x)}, ${String(ANCHOR_RECT.y)}, ${String(ANCHOR_RECT.width)}, ${String(ANCHOR_RECT.height)}),
};

function fixedTrigger(top, left) {
  return h('button', { id: 'trigger', type: 'button', style: { position: 'fixed', top, left } }, 'Open');
}

function Column() {
  const [column, setColumn] = useState(null);
  return h(
    'div',
    { id: 'column', ref: setColumn, style: { position: 'fixed', left: '0px', top: '100px', width: '500px', height: (query.get('height') ?? '600') + 'px' } },
    h(
      Popover,
      {
        trigger: h('button', { id: 'trigger', type: 'button', style: { position: 'absolute', right: '8px', top: '8px' } }, 'Open'),
        title: 'Held',
        width: 'lg',
        open: column !== null,
        onOpenChange: noop,
        boundary: query.get('bounded') === '1' ? column : null,
        'data-testid': 'pop',
      },
      body
    )
  );
}

function Scene() {
  switch (query.get('case')) {
    case 'column':
      return h(Column);
    case 'anchor':
      return h(Popover, { trigger: fixedTrigger('40px', '40px'), title: 'Peek', anchor, open: true, onOpenChange: noop, 'data-testid': 'pop' }, body);
    case 'fact':
      return h('div', { id: 'fact', style: { width: '12rem' } }, h(PopoverFact, { icon: Lock }, 'A fact long enough to take two lines'));
    case 'sheet':
      return h(Popover, { trigger: fixedTrigger('40px', '40px'), title: 'Aspect ratio', open: true, onOpenChange: noop, 'data-testid': 'pop' }, body);
    case 'tooltip':
      return h(
        Tooltip,
        { open: true },
        h(TooltipTrigger, { style: { position: 'fixed', top: '200px', left: '600px' } }, 'Why'),
        h(TooltipContent, { 'data-testid': 'tip' }, 'We only partner with AI providers that never store or train on your data.')
      );
    default:
      return h(Popover, { trigger: fixedTrigger(query.get('top') + 'px', '600px'), title: 'Place', open: true, onOpenChange: noop, 'data-testid': 'pop' }, body);
  }
}

createRoot(document.getElementById('root')).render(h(Scene));
`;

function pageModules(): Plugin {
  return {
    name: 'popover-place-page',
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

interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
  height: number;
  width: number;
}

interface Placement {
  side: string | null;
  popover: Box;
  trigger: Box;
  scrolls: boolean;
  column: Box | null;
  rem: number;
}

interface SceneOptions {
  viewport?: { width: number; height: number };
  /** Opens the page with a touch screen, which the engine reports as a coarse pointer. */
  touch?: boolean;
}

async function openScene(
  browser: Browser,
  origin: string,
  query: string,
  { viewport = VIEWPORT, touch = false }: SceneOptions = {}
): Promise<Page> {
  const page = await browser.newPage({ viewport, hasTouch: touch });
  await page.goto(`${origin}${PAGE_PATH}?${query}`, { timeout: LOAD_MS });
  await page.evaluate(() => document.fonts.ready);
  return page;
}

async function settle(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      document.getAnimations().every((animation) => animation.playState !== 'running') &&
      document.querySelector<HTMLElement>('[data-testid="pop"]')?.dataset['side'] !== undefined,
    undefined,
    { timeout: PLACEMENT_MS }
  );
}

/** A popover sheet at phone width, open and done animating. */
async function openSheet(browser: Browser, origin: string, touch = false): Promise<Page> {
  const page = await openScene(browser, origin, 'case=sheet', {
    viewport: PHONE_VIEWPORT,
    touch,
  });
  await page.getByRole('button', { name: 'Close' }).waitFor({ timeout: LOAD_MS });
  await page.waitForFunction(
    () => document.getAnimations().every((animation) => animation.playState !== 'running'),
    undefined,
    { timeout: PLACEMENT_MS }
  );
  return page;
}

interface CloseLook {
  width: number;
  height: number;
  opacity: string;
  slot: string | null;
  targetWidth: string;
  rem: number;
}

async function closeLook(page: Page): Promise<CloseLook> {
  return page.getByRole('button', { name: 'Close' }).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      width: rect.width,
      height: rect.height,
      opacity: getComputedStyle(element).opacity,
      slot: element.dataset['slot'] ?? null,
      targetWidth: getComputedStyle(element, '::before').width,
      rem: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
    };
  });
}

/** Just inside half of a 2.75rem target at a 16px root, and outside the 1.75rem drawn box. */
const PROBE_OFFSET_PX = 21;

/** Whether a press this far above, below, left and right of the close's centre lands on it. */
async function closeHits(page: Page): Promise<boolean[]> {
  return page.getByRole('button', { name: 'Close' }).evaluate((element, offset) => {
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const lands = (px: number, py: number): boolean =>
      document.elementFromPoint(px, py)?.closest('[data-slot="overlay-close"]') === element;
    return [lands(x, y - offset), lands(x, y + offset), lands(x - offset, y), lands(x + offset, y)];
  }, PROBE_OFFSET_PX);
}

/** Where the popover landed, once Radix has placed it. */
async function placement(browser: Browser, origin: string, query: string): Promise<Placement> {
  const page = await openScene(browser, origin, query);
  try {
    await page.locator('[data-testid="pop"]').waitFor({ timeout: LOAD_MS });
    // Radix parks the unplaced popover at -200% until its first measurement lands.
    await page.waitForFunction(
      () =>
        !document
          .querySelector<HTMLElement>('[data-radix-popper-content-wrapper]')
          ?.style.transform.includes('-200%'),
      undefined,
      { timeout: PLACEMENT_MS }
    );
    await settle(page);
    return await page.evaluate(() => {
      const box = (element: Element | null): Box | null => {
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return {
          top: rect.top,
          bottom: rect.bottom,
          left: rect.left,
          right: rect.right,
          height: rect.height,
          width: rect.width,
        };
      };
      const popover = document.querySelector<HTMLElement>('[data-testid="pop"]');
      const popoverBox = box(popover);
      const triggerBox = box(document.querySelector('#trigger'));
      if (!popover || !popoverBox || !triggerBox) throw new Error('the scene did not render');
      return {
        side: popover.dataset['side'] ?? null,
        popover: popoverBox,
        trigger: triggerBox,
        scrolls: popover.scrollHeight > popover.clientHeight,
        column: box(document.querySelector('#column')),
        rem: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
      };
    });
  } finally {
    await page.close();
  }
}

describe('popover placement in a real engine', () => {
  let server: FixtureServer;
  const browsers: Partial<Record<EngineName, Browser>> = {};

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

  function browserFor(engine: EngineName): Browser {
    const browser = browsers[engine];
    if (browser === undefined) throw new Error(`${engine} did not launch`);
    return browser;
  }

  describe.each(ENGINES)('%s', (engine) => {
    it(
      'opens below its trigger when the room below holds it',
      async () => {
        const landed = await placement(browserFor(engine), server.url, 'top=100');
        expect(landed.side).toBe('bottom');
        expect(landed.popover.top).toBeGreaterThanOrEqual(landed.trigger.bottom);
      },
      TEST_MS
    );

    it(
      "flips above its trigger when the trigger sits near the viewport's foot",
      async () => {
        const landed = await placement(browserFor(engine), server.url, 'top=820');
        expect(landed.side).toBe('top');
        expect(landed.popover.bottom).toBeLessThanOrEqual(landed.trigger.top);
      },
      TEST_MS
    );

    it(
      'grows no taller than the room on its side',
      async () => {
        const landed = await placement(browserFor(engine), server.url, 'top=300&body=3000');
        const room =
          VIEWPORT.height - landed.trigger.bottom - SIDE_OFFSET_PX - COLLISION_PADDING_PX;
        expect(landed.side).toBe('bottom');
        expect(landed.popover.height).toBeLessThanOrEqual(room + 1);
      },
      TEST_MS
    );

    it(
      'scrolls a body taller than its room',
      async () => {
        const landed = await placement(browserFor(engine), server.url, 'top=300&body=3000');
        expect(landed.scrolls).toBe(true);
      },
      TEST_MS
    );

    it(
      "stays inside its boundary's box",
      async () => {
        const landed = await placement(browserFor(engine), server.url, 'case=column&bounded=1');
        const column = landed.column;
        if (column === null) throw new Error('the column did not render');
        expect(landed.popover.left).toBeGreaterThanOrEqual(column.left - 0.5);
        expect(landed.popover.right).toBeLessThanOrEqual(column.right + 0.5);
      },
      TEST_MS
    );

    it(
      'leaves the column when it has no boundary',
      async () => {
        const landed = await placement(browserFor(engine), server.url, 'case=column&bounded=0');
        const column = landed.column;
        if (column === null) throw new Error('the column did not render');
        expect(landed.popover.right).toBeGreaterThan(column.right + 0.5);
      },
      TEST_MS
    );

    it(
      'hangs from its anchor rectangle rather than its trigger',
      async () => {
        const landed = await placement(browserFor(engine), server.url, 'case=anchor');
        const anchorBottom = ANCHOR_RECT.y + ANCHOR_RECT.height;
        const anchorCentre = ANCHOR_RECT.x + ANCHOR_RECT.width / 2;
        expect(landed.popover.top).toBeCloseTo(anchorBottom + SIDE_OFFSET_PX, 0);
        expect(landed.popover.left + landed.popover.width / 2).toBeCloseTo(anchorCentre, 0);
      },
      TEST_MS
    );

    it(
      "centres a fact line's icon on its two lines of text",
      async () => {
        const page = await openScene(browserFor(engine), server.url, 'case=fact');
        try {
          await page.locator('#fact svg').waitFor({ timeout: LOAD_MS });
          const { icon, text, lineHeight } = await page.evaluate(() => {
            const svg = document.querySelector('#fact svg');
            const words = document.querySelector('#fact span:last-child');
            if (!svg || !words) throw new Error('the fact did not render');
            const iconRect = svg.getBoundingClientRect();
            const textRect = words.getBoundingClientRect();
            return {
              icon: { top: iconRect.top, height: iconRect.height },
              text: { top: textRect.top, height: textRect.height },
              lineHeight: Number.parseFloat(getComputedStyle(words).lineHeight),
            };
          });
          expect(text.height).toBeGreaterThan(lineHeight * 1.5);
          expect(icon.top + icon.height / 2).toBeCloseTo(text.top + text.height / 2, 0);
        } finally {
          await page.close();
        }
      },
      TEST_MS
    );

    it(
      "centres a sheet's close button on its title",
      async () => {
        const page = await openScene(browserFor(engine), server.url, 'case=sheet', {
          viewport: PHONE_VIEWPORT,
        });
        try {
          const close = page.getByRole('button', { name: 'Close' });
          await close.waitFor({ timeout: LOAD_MS });
          await page.waitForFunction(
            () => document.getAnimations().every((animation) => animation.playState !== 'running'),
            undefined,
            { timeout: PLACEMENT_MS }
          );
          const title = page.getByRole('heading', { name: 'Aspect ratio' });
          const [closeBox, titleBox] = await Promise.all([
            close.boundingBox(),
            title.boundingBox(),
          ]);
          if (closeBox === null || titleBox === null)
            throw new Error('the sheet head did not render');
          expect(closeBox.y + closeBox.height / 2).toBeCloseTo(titleBox.y + titleBox.height / 2, 0);
        } finally {
          await page.close();
        }
      },
      TEST_MS
    );

    it(
      "draws a sheet's close button as a 1.75rem box at 70% opacity",
      async () => {
        const page = await openSheet(browserFor(engine), server.url);
        try {
          const look = await closeLook(page);
          expect(look.width).toBeCloseTo(1.75 * look.rem, 0);
          expect(look.height).toBeCloseTo(1.75 * look.rem, 0);
          expect(look.opacity).toBe('0.7');
        } finally {
          await page.close();
        }
      },
      TEST_MS
    );

    it(
      "extends a sheet's close button to a 2.75rem target under a touch pointer",
      async () => {
        const page = await openSheet(browserFor(engine), server.url, true);
        try {
          const look = await closeLook(page);
          expect(Number.parseFloat(look.targetWidth)).toBeCloseTo(2.75 * look.rem, 0);
        } finally {
          await page.close();
        }
      },
      TEST_MS
    );

    it(
      "takes a press 21px from a sheet's close centre on every side under a touch pointer",
      async () => {
        const page = await openSheet(browserFor(engine), server.url, true);
        try {
          expect(await closeHits(page)).toEqual([true, true, true, true]);
        } finally {
          await page.close();
        }
      },
      TEST_MS
    );

    it(
      "marks a sheet's close button as the overlay close",
      async () => {
        const page = await openSheet(browserFor(engine), server.url);
        try {
          const look = await closeLook(page);
          expect(look.slot).toBe('overlay-close');
        } finally {
          await page.close();
        }
      },
      TEST_MS
    );

    it(
      "sets a sheet's text at 0.875rem",
      async () => {
        const page = await openSheet(browserFor(engine), server.url);
        try {
          const { size, rem } = await page.locator('#body').evaluate((element) => ({
            size: Number.parseFloat(getComputedStyle(element).fontSize),
            rem: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
          }));
          expect(size).toBeCloseTo(0.875 * rem, 1);
        } finally {
          await page.close();
        }
      },
      TEST_MS
    );

    it(
      'keeps a 10rem height under a boundary shorter than that',
      async () => {
        const landed = await placement(
          browserFor(engine),
          server.url,
          'case=column&bounded=1&height=60&body=400'
        );
        expect(landed.popover.height).toBeCloseTo(10 * landed.rem, 0);
      },
      TEST_MS
    );

    it(
      'wraps a long tooltip label at 16rem',
      async () => {
        const page = await openScene(browserFor(engine), server.url, 'case=tooltip');
        try {
          const tip = page.locator('[data-testid="tip"]');
          await tip.waitFor({ timeout: LOAD_MS });
          const { width, rem } = await tip.evaluate((element) => ({
            width: element.getBoundingClientRect().width,
            rem: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
          }));
          expect(width).toBeLessThanOrEqual(16 * rem + 0.5);
        } finally {
          await page.close();
        }
      },
      TEST_MS
    );
  });
});
