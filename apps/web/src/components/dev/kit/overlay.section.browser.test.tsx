import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, firefox, type Browser, type Page } from '@playwright/test';
import { startFixtureServer, type FixtureServer } from '@/test-utils/fixture-server';
import type { Plugin } from 'vite';

/**
 * Measures the overlay header's spacing in real engines, under the app stylesheet. A caller's
 * `space-y-*` wrapper and the header's own classes meet in the cascade, and whether their margins
 * add, replace one another or collapse is something only a layout engine settles. It also measures
 * the close's touch target, which only a layout engine hit-tests.
 *
 * Chromium and Firefox, the engines CI installs, driven through `@playwright/test` over a fixture
 * server; the page and its entry are virtual modules, so no fixture file joins the tree.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, '../../../..');
const SRC_DIR = path.join(WEB_DIR, 'src');

const ENTRY_ID = 'virtual:overlay-gap-entry';
const PAGE_PATH = '/overlay-gap.html';

/** The first load compiles the app's whole stylesheet, which a busy machine can make slow. */
const LOAD_MS = 90_000;
const TEST_MS = LOAD_MS + 30_000;
const CLOSE_MS = 45_000;

const PAGE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>overlay gap</title></head>
  <body>
    <div id="root"></div>
    <script type="module" src="/@id/${ENTRY_ID}"></script>
  </body>
</html>`;

// `wrapper=space` puts the header and the next block in a `space-y-4` div, as several dialogs
// do; `wrapper=none` puts them straight into the content's own column.
const ENTRY_SOURCE = `
import { Fragment, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import '@/app.css';
import { Overlay, OverlayContent, OverlayHeader } from '@hushbox/ui/overlay';

const query = new URLSearchParams(location.search);
const header = h(OverlayHeader, {
  title: 'Set up two-factor authentication',
  ...(query.get('described') === '1' && { description: 'Add an extra layer of security.' }),
  ...(query.get('step') === 'count' && { step: { current: 1, total: 4 } }),
  ...(query.get('step') === 'pending' && { step: 'pending' }),
});
const next = h('div', { id: 'next' }, h('button', { type: 'button' }, 'Get started'));
const body = query.get('wrapper') === 'space' ? h('div', { className: 'space-y-4' }, header, next) : h(Fragment, null, header, next);

const phone = query.get('phone') === 'fullscreen' ? { phonePresentation: 'fullscreen' } : {};
// A second step shows the back button beside the close.
const back = query.get('back') === '1' ? { currentStep: 2, onBack: () => {} } : {};

createRoot(document.getElementById('root')).render(
  h(Overlay, { open: true, onOpenChange: () => {}, ariaLabel: 'Gap', ...phone, ...back }, h(OverlayContent, null, body))
);
`;

function pageModules(): Plugin {
  return {
    name: 'overlay-gap-page',
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

/** A phone, which presents a sheet, and a desktop, which presents a dialog. */
const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
] as const;

interface Layout {
  wrapper: 'space' | 'none';
  described: boolean;
}

/** The space from the header's last line to the next block, in root ems. */
async function gapUnderHeader(
  browser: Browser,
  origin: string,
  viewport: (typeof VIEWPORTS)[number],
  { wrapper, described }: Layout
): Promise<number> {
  const page: Page = await browser.newPage({ viewport });
  try {
    const query = new URLSearchParams({ wrapper, described: described ? '1' : '0' });
    await page.goto(`${origin}${PAGE_PATH}?${query.toString()}`, { timeout: LOAD_MS });
    await page.locator('#next').waitFor({ timeout: LOAD_MS });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() =>
      document.getAnimations().every((animation) => animation.playState !== 'running')
    );
    return await page.evaluate(() => {
      const lastLine = document.querySelector('h2')?.parentElement?.lastElementChild;
      const next = document.querySelector('#next');
      if (!lastLine || !next) throw new Error('the header or the next block is missing');
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
      return (next.getBoundingClientRect().top - lastLine.getBoundingClientRect().bottom) / rem;
    });
  } finally {
    await page.close();
  }
}

type StepKind = 'count' | 'pending' | 'none';

interface StepReading {
  /** The title's distance below the header's top, in root ems. */
  titleOffset: number;
  headerText: string;
}

/** Reads the header with a counted step line, a pending one, or none. */
async function readStep(
  browser: Browser,
  origin: string,
  viewport: (typeof VIEWPORTS)[number],
  step: StepKind
): Promise<StepReading> {
  const page: Page = await browser.newPage({ viewport });
  try {
    const query = new URLSearchParams({ wrapper: 'none', described: '0', step });
    await page.goto(`${origin}${PAGE_PATH}?${query.toString()}`, { timeout: LOAD_MS });
    await page.locator('h2').waitFor({ timeout: LOAD_MS });
    await page.evaluate(() => document.fonts.ready);
    // The dialog zooms in as it opens, and a scaled header reads a scaled offset.
    await page.waitForFunction(() =>
      document.getAnimations().every((animation) => animation.playState !== 'running')
    );
    return await page.evaluate(() => {
      const title = document.querySelector('h2');
      const header = title?.parentElement;
      if (!title || !header) throw new Error('the header is missing');
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
      return {
        titleOffset: (title.getBoundingClientRect().top - header.getBoundingClientRect().top) / rem,
        headerText: header.textContent,
      };
    });
  } finally {
    await page.close();
  }
}

/** Each presentation with a close and a back button, at a width that presents it. */
const NAV_SCENES = [
  { name: 'the dialog', viewport: { width: 834, height: 1112 }, phone: 'sheet' },
  { name: 'the bottom sheet', viewport: { width: 390, height: 844 }, phone: 'sheet' },
  { name: 'the full screen', viewport: { width: 390, height: 844 }, phone: 'fullscreen' },
] as const;

/** Just inside half of a 2.75rem target at a 16px root, and outside the 1.75rem drawn box. */
const PROBE_OFFSET_PX = 21;

/** The overlay's corner buttons, by accessible name. */
const NAV_CONTROLS = [
  { key: 'close', name: 'Close' },
  { key: 'back', name: 'Back' },
] as const;

type NavControl = (typeof NAV_CONTROLS)[number]['key'];

interface NavTarget {
  drawnWidth: number;
  drawnHeight: number;
  targetWidth: number;
  targetHeight: number;
  /** Whether a press this far above, below, left and right of the button's centre lands on it. */
  hits: boolean[];
  rem: number;
}

/** Reads one corner button of a page already settled. */
async function readNavTarget(page: Page, name: string): Promise<NavTarget> {
  return page.getByRole('button', { name }).evaluate((element, offset) => {
    const rect = element.getBoundingClientRect();
    const target = getComputedStyle(element, '::before');
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    // A press on the target reports the button itself, since the target is its pseudo-element.
    const lands = (px: number, py: number): boolean => {
      const hit = document.elementFromPoint(px, py);
      return hit !== null && element.contains(hit);
    };
    return {
      drawnWidth: rect.width,
      drawnHeight: rect.height,
      targetWidth: Number.parseFloat(target.width),
      targetHeight: Number.parseFloat(target.height),
      hits: [
        lands(x, y - offset),
        lands(x, y + offset),
        lands(x - offset, y),
        lands(x + offset, y),
      ],
      rem: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
    };
  }, PROBE_OFFSET_PX);
}

/** Reads both corner buttons under a touch screen, which the engine reports as a coarse pointer. */
async function readNavTargets(
  browser: Browser,
  origin: string,
  scene: (typeof NAV_SCENES)[number]
): Promise<Record<NavControl, NavTarget>> {
  const page: Page = await browser.newPage({ viewport: scene.viewport, hasTouch: true });
  try {
    const query = new URLSearchParams({
      wrapper: 'none',
      described: '0',
      phone: scene.phone,
      back: '1',
    });
    await page.goto(`${origin}${PAGE_PATH}?${query.toString()}`, { timeout: LOAD_MS });
    await page.getByRole('button', { name: 'Back' }).waitFor({ timeout: LOAD_MS });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() =>
      document.getAnimations().every((animation) => animation.playState !== 'running')
    );
    return { close: await readNavTarget(page, 'Close'), back: await readNavTarget(page, 'Back') };
  } finally {
    await page.close();
  }
}

/** Each presentation at every width the back button's row is judged at. */
const HEAD_SCENES = [
  { name: 'the dialog', viewport: { width: 768, height: 1024 }, phone: 'sheet' },
  { name: 'the dialog', viewport: { width: 834, height: 1112 }, phone: 'sheet' },
  { name: 'the dialog', viewport: { width: 1440, height: 900 }, phone: 'sheet' },
  { name: 'the full screen', viewport: { width: 320, height: 568 }, phone: 'fullscreen' },
  { name: 'the full screen', viewport: { width: 390, height: 844 }, phone: 'fullscreen' },
  { name: 'the full screen', viewport: { width: 767, height: 1024 }, phone: 'fullscreen' },
  { name: 'the bottom sheet', viewport: { width: 320, height: 568 }, phone: 'sheet' },
  { name: 'the bottom sheet', viewport: { width: 390, height: 844 }, phone: 'sheet' },
] as const;

type HeadScene = (typeof HEAD_SCENES)[number];

interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

interface HeadReading {
  back: Box | null;
  title: Box;
  stepLine: Box | null;
  /** The title's distance below the top of the overlay's content element, in root ems. */
  titleFromTop: number;
  /** The header's own top padding, in root ems. */
  headerPaddingTop: number;
}

/** Reads the header's boxes, with or without a back button and a counted step line. */
async function readHead(
  browser: Browser,
  origin: string,
  scene: HeadScene,
  { back, step }: { back: boolean; step: boolean }
): Promise<HeadReading> {
  const page: Page = await browser.newPage({ viewport: scene.viewport });
  try {
    const query = new URLSearchParams({
      wrapper: 'none',
      described: '0',
      phone: scene.phone,
      back: back ? '1' : '0',
      step: step ? 'count' : 'none',
    });
    await page.goto(`${origin}${PAGE_PATH}?${query.toString()}`, { timeout: LOAD_MS });
    await page.locator('h2').waitFor({ timeout: LOAD_MS });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() =>
      document.getAnimations().every((animation) => animation.playState !== 'running')
    );
    return await page.evaluate(() => {
      const box = (element: Element | null): Box | null => {
        if (element === null) return null;
        const { top, bottom, left, right } = element.getBoundingClientRect();
        return { top, bottom, left, right };
      };
      const title = document.querySelector('h2');
      const header = title?.parentElement;
      const content = document.querySelector('[data-slot="overlay-content"]');
      if (!title || !header || !content) throw new Error('the header or the overlay is missing');
      const backButton = [...document.querySelectorAll('button')].find(
        (button) => button.textContent === 'Back'
      );
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
      const titleBox = box(title);
      if (titleBox === null) throw new Error('the title is missing');
      return {
        back: box(backButton ?? null),
        title: titleBox,
        stepLine: box(header.querySelector('[data-slot="overlay-step"]')),
        titleFromTop: (titleBox.top - content.getBoundingClientRect().top) / rem,
        headerPaddingTop: Number.parseFloat(getComputedStyle(header).paddingTop) / rem,
      };
    });
  } finally {
    await page.close();
  }
}

function intersects(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/**
 * Where the title sits below the overlay's top with no back button, in root ems, as the
 * presentation's own chrome puts it: the dialog's 0.5rem inset, its panel's 1px border and 1.5rem
 * padding; the sheet's 1.25rem handle, 0.5rem inset and 0.75rem padding; the full screen's 1.5rem.
 */
const TITLE_FROM_TOP: Record<HeadScene['name'], number> = {
  'the dialog': 0.5 + 1 / 16 + 1.5,
  'the bottom sheet': 1.25 + 0.5 + 0.75,
  'the full screen': 1.5,
};

describe('the overlay in a real engine', () => {
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

  // One reading per engine and width, shared by the cases that judge it.
  const stepReadings = new Map<string, Promise<Record<StepKind, StepReading>>>();

  function stepsAt(
    engine: EngineName,
    viewport: (typeof VIEWPORTS)[number]
  ): Promise<Record<StepKind, StepReading>> {
    const key = `${engine}-${String(viewport.width)}`;
    const cached = stepReadings.get(key);
    if (cached !== undefined) return cached;
    const reading = (async (): Promise<Record<StepKind, StepReading>> => {
      const browser = browserFor(engine);
      return {
        count: await readStep(browser, server.url, viewport, 'count'),
        pending: await readStep(browser, server.url, viewport, 'pending'),
        none: await readStep(browser, server.url, viewport, 'none'),
      };
    })();
    stepReadings.set(key, reading);
    return reading;
  }

  describe.each(ENGINES)('%s', (engine) => {
    describe.each(VIEWPORTS)('at $width', (viewport) => {
      it(
        'holds the title where a counted step line puts it while the step is pending',
        async () => {
          const { count, pending } = await stepsAt(engine, viewport);
          expect(pending.titleOffset).toBeCloseTo(count.titleOffset, 2);
        },
        4 * TEST_MS
      );

      it(
        'writes no step text while the step is pending',
        async () => {
          const { pending } = await stepsAt(engine, viewport);
          expect(pending.headerText).not.toMatch(/Step/);
        },
        4 * TEST_MS
      );

      it(
        'drops the title below a step line, which takes space above it',
        async () => {
          const { count, none } = await stepsAt(engine, viewport);
          expect(none.titleOffset).toBeCloseTo(0, 2);
          expect(count.titleOffset).toBeGreaterThan(1);
        },
        4 * TEST_MS
      );

      it(
        "adds 0.5rem to a space-y wrapper's 1rem under a description",
        async () => {
          const gap = await gapUnderHeader(browserFor(engine), server.url, viewport, {
            wrapper: 'space',
            described: true,
          });
          expect(gap).toBeCloseTo(1.5, 1);
        },
        TEST_MS
      );

      it(
        "adds 0.5rem to the content column's 1rem under a description",
        async () => {
          const gap = await gapUnderHeader(browserFor(engine), server.url, viewport, {
            wrapper: 'none',
            described: true,
          });
          expect(gap).toBeCloseTo(1.5, 1);
        },
        TEST_MS
      );

      it(
        "keeps a space-y wrapper's 1rem under a header with no description",
        async () => {
          const gap = await gapUnderHeader(browserFor(engine), server.url, viewport, {
            wrapper: 'space',
            described: false,
          });
          expect(gap).toBeCloseTo(1, 1);
        },
        TEST_MS
      );
    });
  });

  // One reading per engine and scene, shared by the cases that judge it.
  const navTargets = new Map<string, Promise<Record<NavControl, NavTarget>>>();

  function navTargetsOf(
    engine: EngineName,
    scene: (typeof NAV_SCENES)[number]
  ): Promise<Record<NavControl, NavTarget>> {
    const key = `${engine}-${scene.name}`;
    const cached = navTargets.get(key);
    if (cached !== undefined) return cached;
    const reading = readNavTargets(browserFor(engine), server.url, scene);
    navTargets.set(key, reading);
    return reading;
  }

  describe.each(ENGINES)('%s under a touch pointer', (engine) => {
    describe.each(NAV_SCENES)('$name at $viewport.width', (scene) => {
      describe.each(NAV_CONTROLS)('its $key button', ({ key }) => {
        it(
          'extends to a 2.75rem target',
          async () => {
            const targets = await navTargetsOf(engine, scene);
            const button = targets[key];
            expect(button.targetWidth).toBeCloseTo(2.75 * button.rem, 1);
            expect(button.targetHeight).toBeCloseTo(2.75 * button.rem, 1);
          },
          TEST_MS
        );

        it(
          'stays drawn at 1.75rem',
          async () => {
            const targets = await navTargetsOf(engine, scene);
            const button = targets[key];
            expect(button.drawnWidth).toBeCloseTo(1.75 * button.rem, 1);
            expect(button.drawnHeight).toBeCloseTo(1.75 * button.rem, 1);
          },
          TEST_MS
        );

        it(
          'takes a press 21px from its centre on every side',
          async () => {
            const targets = await navTargetsOf(engine, scene);
            const button = targets[key];
            expect(button.hits).toEqual([true, true, true, true]);
          },
          TEST_MS
        );
      });
    });
  });

  // One reading per engine, scene and header, shared by the cases that judge it.
  const headReadings = new Map<string, Promise<HeadReading>>();

  function headOf(
    engine: EngineName,
    scene: HeadScene,
    header: { back: boolean; step: boolean }
  ): Promise<HeadReading> {
    const key = [
      engine,
      scene.name,
      String(scene.viewport.width),
      String(header.back),
      String(header.step),
    ].join('-');
    const cached = headReadings.get(key);
    if (cached !== undefined) return cached;
    const reading = readHead(browserFor(engine), server.url, scene, header);
    headReadings.set(key, reading);
    return reading;
  }

  describe.each(ENGINES)('%s with a back button', (engine) => {
    describe.each(HEAD_SCENES)('$name at $viewport.width', (scene) => {
      describe.each([
        { lines: 'a title alone', step: false },
        { lines: 'a step line', step: true },
      ])('over $lines', ({ step }) => {
        it(
          'keeps the title clear of the back button',
          async () => {
            const { back, title } = await headOf(engine, scene, { back: true, step });
            if (back === null) throw new Error('the back button is missing');
            expect(intersects(back, title)).toBe(false);
          },
          TEST_MS
        );
      });

      it(
        'keeps the step line clear of the back button',
        async () => {
          const { back, stepLine } = await headOf(engine, scene, { back: true, step: true });
          if (back === null || stepLine === null) throw new Error('a line is missing');
          expect(intersects(back, stepLine)).toBe(false);
        },
        TEST_MS
      );
    });
  });

  describe.each(ENGINES)('%s without a back button', (engine) => {
    describe.each(HEAD_SCENES)('$name at $viewport.width', (scene) => {
      it(
        'sets the title where the presentation alone puts it',
        async () => {
          const { back, titleFromTop } = await headOf(engine, scene, { back: false, step: false });
          expect(back).toBeNull();
          expect(titleFromTop).toBeCloseTo(TITLE_FROM_TOP[scene.name], 2);
        },
        TEST_MS
      );

      it(
        'gives the header no top padding',
        async () => {
          const { headerPaddingTop } = await headOf(engine, scene, { back: false, step: false });
          expect(headerPaddingTop).toBe(0);
        },
        TEST_MS
      );
    });
  });
});
