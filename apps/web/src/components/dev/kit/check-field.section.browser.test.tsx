import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, firefox, type Browser, type Page } from '@playwright/test';
import { startFixtureServer, type FixtureServer } from '@/test-utils/fixture-server';
import type { Plugin } from 'vite';

/**
 * Measures the kit's checkbox rows in real engines, under the app stylesheet: the checkbox's touch
 * target on a coarse pointer, and the drawn box and row, which that target must leave as they are
 * on either pointer. Only a layout engine hit-tests a press or lays the row out.
 *
 * Chromium and Firefox, the engines CI installs, driven through `@playwright/test` over a fixture
 * server; the page and its entry are virtual modules, so no fixture file joins the tree.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, '../../../..');
const SRC_DIR = path.join(WEB_DIR, 'src');
const SECTION_FILE = path.join(HERE, 'choices.section.tsx');

const ENTRY_ID = 'virtual:check-field-entry';
const PAGE_PATH = '/check-field.html';

/** The first load compiles the app's whole stylesheet, which a busy machine can make slow. */
const LOAD_MS = 90_000;
const TEST_MS = LOAD_MS + 30_000;
const CLOSE_MS = 45_000;

const PHONE_VIEWPORT = { width: 390, height: 844 } as const;

/** The one-line rows the stack scene draws, in order. */
const STACK_LABELS = ['spring-launch', 'newsletter', 'podcast', 'reddit'];

/** How long a tap may take to change a box's checked state. */
const TAP_MS = 5000;

/** Where on a drawn box a press lands: its centre and 1px inside each edge. */
const BOX_POINTS = ['centre', 'top edge', 'bottom edge', 'left edge', 'right edge'] as const;

/** The checkbox the overlay scene draws in its body. */
const OVERLAY_LABEL = 'Give access to all history';

/**
 * Each box size in an overlay's body, on a phone, which presents a bottom sheet, and on a desktop,
 * which presents a dialog.
 */
const OVERLAY_SCENES = [
  { name: 'the 24px box at 390', size: 'lg', viewport: { width: 390, height: 844 } },
  { name: 'the 24px box at 1440', size: 'lg', viewport: { width: 1440, height: 900 } },
  { name: 'the 1rem box at 390', size: 'md', viewport: { width: 390, height: 844 } },
  { name: 'the 1rem box at 1440', size: 'md', viewport: { width: 1440, height: 900 } },
] as const;

/** Just inside half of a 2.75rem target at a 16px root, and outside both drawn boxes. */
const PROBE_OFFSET_PX = 21;

const PAGE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>check field</title></head>
  <body>
    <div id="root"></div>
    <script type="module" src="/@id/${ENTRY_ID}"></script>
  </body>
</html>`;

// `scene=overlay` puts a row in an overlay's body: at `size=lg` a 24px box with a description, as
// the member dialogs draw it; otherwise a 1rem box with a two-line label under a paragraph, as the
// delete-account dialog draws it. `scene=stack` stacks one-line rows 0.375rem apart, as the admin
// campaign filter does. Without a scene the section renders padded, so a press beside a checkbox
// lands on the page.
const ENTRY_SOURCE = `
import { createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@/app.css';
import { CheckField } from '@hushbox/ui/field';
import { Overlay, OverlayBody, OverlayContent, OverlayHeader } from '@hushbox/ui/overlay';
import section from ${JSON.stringify(SECTION_FILE)};

const query = new URLSearchParams(location.search);

function InOverlay() {
  const [checked, setChecked] = useState(false);
  const large = query.get('size') === 'lg';
  return h(
    Overlay,
    { open: true, onOpenChange: () => {}, ariaLabel: 'Invite' },
    h(
      OverlayContent,
      null,
      h(OverlayHeader, { title: 'Invite via Link' }),
      h(
        OverlayBody,
        null,
        large ? null : h('p', null, 'Credit cannot be refunded or moved to another account.'),
        h(CheckField, {
          checked,
          onCheckedChange: setChecked,
          label: ${JSON.stringify(OVERLAY_LABEL)},
          ...(large
            ? { size: 'lg', description: 'Leaving this unchecked will only show messages from now on' }
            : { description: 'The balance is forfeited and cannot be refunded.' }),
        })
      )
    )
  );
}

const STACK = ${JSON.stringify(STACK_LABELS)};

function Stack() {
  const [chosen, setChosen] = useState([]);
  return h(
    'div',
    { className: 'flex flex-col gap-1.5' },
    STACK.map((label) =>
      h(CheckField, {
        key: label,
        label,
        checked: chosen.includes(label),
        onCheckedChange: (next) => {
          setChosen((current) => (next ? [...current, label] : current.filter((item) => item !== label)));
        },
      })
    )
  );
}

const scene = query.get('scene');
createRoot(document.getElementById('root')).render(
  scene === 'overlay'
    ? h(InOverlay)
    : h('div', { style: { padding: '3rem' } }, scene === 'stack' ? h(Stack) : section.render())
);
`;

function pageModules(): Plugin {
  return {
    name: 'check-field-page',
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

type Pointer = 'fine' | 'coarse';

/** The kit's checkboxes, each found by the label it carries, with its drawn box in root ems. */
const SAMPLES = [
  { name: 'the two-line row', label: 'Email me when my balance runs low', box: 1 },
  { name: 'the described row', label: 'Forfeit my balance', box: 1 },
  { name: 'the 24px row', label: 'Keep me signed in', box: 1.5 },
] as const;

type Sample = (typeof SAMPLES)[number];

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface CheckReading {
  coarse: boolean;
  drawn: Box;
  row: Box;
  labelBlock: Box;
  firstLine: Box;
  targetWidth: number;
  targetHeight: number;
  /** Whether a press this far above, below, left and right of the box's centre lands on it. */
  hits: boolean[];
  rem: number;
}

/** Reads one checkbox of a page already settled. */
async function readCheck(page: Page, label: string): Promise<CheckReading> {
  return page.getByRole('checkbox', { name: label }).evaluate((element, offset) => {
    const box = (target: Element): Box => {
      const { top, left, width, height } = target.getBoundingClientRect();
      return { top, left, width, height };
    };
    const row = element.parentElement;
    const labelBlock = [...(row?.children ?? [])].find((child) => child !== element);
    const firstLine = labelBlock?.firstElementChild;
    if (row === null || labelBlock === undefined || firstLine === null || firstLine === undefined) {
      throw new Error('the checkbox has no row');
    }
    const rect = element.getBoundingClientRect();
    const target = getComputedStyle(element, '::before');
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    // A press on the target reports the checkbox itself, since the target is its pseudo-element.
    const lands = (px: number, py: number): boolean => {
      const hit = document.elementFromPoint(px, py);
      return hit !== null && element.contains(hit);
    };
    return {
      coarse: matchMedia('(pointer: coarse)').matches,
      drawn: box(element),
      row: box(row),
      labelBlock: box(labelBlock),
      firstLine: box(firstLine),
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

/** Reads every sample on a phone, under a touch screen for a coarse pointer. */
async function readChecks(
  browser: Browser,
  origin: string,
  pointer: Pointer
): Promise<Record<string, CheckReading>> {
  const page: Page = await browser.newPage({
    viewport: PHONE_VIEWPORT,
    hasTouch: pointer === 'coarse',
  });
  try {
    await page.goto(`${origin}${PAGE_PATH}`, { timeout: LOAD_MS });
    await page.getByRole('checkbox', { name: SAMPLES[0].label }).waitFor({ timeout: LOAD_MS });
    await page.evaluate(() => document.fonts.ready);
    const readings: Record<string, CheckReading> = {};
    for (const sample of SAMPLES) readings[sample.label] = await readCheck(page, sample.label);
    return readings;
  } finally {
    await page.close();
  }
}

/** Reads the overlay scene's checkbox under a touch screen, once the overlay has settled. */
async function readOverlayCheck(
  browser: Browser,
  origin: string,
  scene: (typeof OVERLAY_SCENES)[number]
): Promise<CheckReading> {
  const page: Page = await browser.newPage({ viewport: scene.viewport, hasTouch: true });
  try {
    const query = new URLSearchParams({ scene: 'overlay', size: scene.size });
    await page.goto(`${origin}${PAGE_PATH}?${query.toString()}`, { timeout: LOAD_MS });
    await page.getByRole('checkbox', { name: OVERLAY_LABEL }).waitFor({ timeout: LOAD_MS });
    await page.evaluate(() => document.fonts.ready);
    // The overlay slides in as it opens, and a moving checkbox reads a moving centre.
    await page.waitForFunction(() =>
      document.getAnimations().every((animation) => animation.playState !== 'running')
    );
    return await readCheck(page, OVERLAY_LABEL);
  } finally {
    await page.close();
  }
}

/**
 * Presses every box of the stack scene under a touch screen, at its centre and just inside each
 * edge, and reports, per press, the stack's rows whose checked state changed.
 */
async function pressStack(browser: Browser, origin: string): Promise<number[][]> {
  const page: Page = await browser.newPage({ viewport: PHONE_VIEWPORT, hasTouch: true });
  try {
    await page.goto(`${origin}${PAGE_PATH}?scene=stack`, { timeout: LOAD_MS });
    const boxes = page.getByRole('checkbox');
    await boxes.first().waitFor({ timeout: LOAD_MS });
    await page.evaluate(() => document.fonts.ready);
    const states = async (): Promise<(string | null)[]> =>
      boxes.evaluateAll((all) => all.map((box) => box.getAttribute('aria-checked')));
    const changes: number[][] = [];
    for (let index = 0; index < STACK_LABELS.length; index += 1) {
      const rect = await boxes.nth(index).boundingBox();
      if (rect === null) throw new Error(`box ${String(index)} is not drawn`);
      const middleX = rect.x + rect.width / 2;
      const middleY = rect.y + rect.height / 2;
      const points: Record<(typeof BOX_POINTS)[number], [number, number]> = {
        centre: [middleX, middleY],
        'top edge': [middleX, rect.y + 1],
        'bottom edge': [middleX, rect.y + rect.height - 1],
        'left edge': [rect.x + 1, middleY],
        'right edge': [rect.x + rect.width - 1, middleY],
      };
      for (const where of BOX_POINTS) {
        const before = await states();
        const [x, y] = points[where];
        await page.touchscreen.tap(x, y);
        // The engine turns a tap into a click after the touch ends, so the state lands later; a tap
        // that toggles nothing times out here.
        await page.waitForFunction(
          (prior) =>
            [...document.querySelectorAll('[role="checkbox"]')]
              .map((box) => box.getAttribute('aria-checked'))
              .join(',') !== prior,
          before.join(','),
          { timeout: TAP_MS }
        );
        const after = await states();
        changes.push(before.flatMap((state, row) => (state === after[row] ? [] : [row])));
      }
    }
    return changes;
  } finally {
    await page.close();
  }
}

describe('the checkbox row in a real engine', () => {
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

  // One reading per engine and pointer, shared by the cases that judge it.
  const readings = new Map<string, Promise<Record<string, CheckReading>>>();

  async function readingOf(
    engine: EngineName,
    pointer: Pointer,
    sample: Sample
  ): Promise<CheckReading> {
    const key = `${engine}-${pointer}`;
    let pending = readings.get(key);
    if (pending === undefined) {
      const browser = browsers[engine];
      if (browser === undefined) throw new Error(`${engine} did not launch`);
      pending = readChecks(browser, server.url, pointer);
      readings.set(key, pending);
    }
    const all = await pending;
    const reading = all[sample.label];
    if (reading === undefined) throw new Error(`no reading for ${sample.label}`);
    return reading;
  }

  describe.each(ENGINES)('on %s', (engine) => {
    it(
      'reports a coarse pointer under a touch screen',
      async () => {
        const reading = await readingOf(engine, 'coarse', SAMPLES[0]);

        expect(reading.coarse).toBe(true);
      },
      TEST_MS
    );

    it(
      'reports a fine pointer without one',
      async () => {
        const reading = await readingOf(engine, 'fine', SAMPLES[0]);

        expect(reading.coarse).toBe(false);
      },
      TEST_MS
    );

    describe.each(SAMPLES)('$name', (sample) => {
      it(
        'extends the checkbox to a 2.75rem target on a coarse pointer',
        async () => {
          const reading = await readingOf(engine, 'coarse', sample);

          expect(reading.targetWidth).toBeCloseTo(2.75 * reading.rem, 1);
          expect(reading.targetHeight).toBeCloseTo(2.75 * reading.rem, 1);
        },
        TEST_MS
      );

      it(
        'takes a press 21px from its centre on every side on a coarse pointer',
        async () => {
          const reading = await readingOf(engine, 'coarse', sample);

          expect(reading.hits).toEqual([true, true, true, true]);
        },
        TEST_MS
      );

      it(
        'takes no press 21px from its centre on a fine pointer',
        async () => {
          const reading = await readingOf(engine, 'fine', sample);

          expect(reading.hits).toEqual([false, false, false, false]);
        },
        TEST_MS
      );

      it.each(['fine', 'coarse'] as const)(
        'draws its box at its size on a %s pointer',
        async (pointer) => {
          const reading = await readingOf(engine, pointer, sample);

          expect(reading.drawn.width).toBeCloseTo(sample.box * reading.rem, 1);
          expect(reading.drawn.height).toBeCloseTo(sample.box * reading.rem, 1);
        },
        TEST_MS
      );

      it.each(['fine', 'coarse'] as const)(
        'starts its label 0.5rem after the box on a %s pointer',
        async (pointer) => {
          const reading = await readingOf(engine, pointer, sample);

          expect(reading.labelBlock.left - (reading.drawn.left + reading.drawn.width)).toBeCloseTo(
            0.5 * reading.rem,
            1
          );
        },
        TEST_MS
      );

      it(
        "keeps its box where it sits against its label's first line on a coarse pointer",
        async () => {
          const fine = await readingOf(engine, 'fine', sample);
          const coarse = await readingOf(engine, 'coarse', sample);
          const offset = (reading: CheckReading): number[] => [
            reading.drawn.left - reading.firstLine.left,
            reading.drawn.top - reading.firstLine.top,
          ];

          expect(offset(coarse)).toEqual(offset(fine));
        },
        TEST_MS
      );

      it(
        'stands its row at least 2.75rem tall on a coarse pointer',
        async () => {
          const reading = await readingOf(engine, 'coarse', sample);

          expect(reading.row.height).toBeGreaterThanOrEqual(2.75 * reading.rem - 0.01);
        },
        TEST_MS
      );

      it(
        'fits its row to the box and the label on a fine pointer',
        async () => {
          const reading = await readingOf(engine, 'fine', sample);

          expect(reading.row.height).toBeCloseTo(
            Math.max(reading.drawn.height, reading.labelBlock.height),
            1
          );
        },
        TEST_MS
      );
    });

    it(
      'toggles only the pressed box of a stack of one-line rows, wherever on the box the press lands',
      async () => {
        const browser = browsers[engine];
        if (browser === undefined) throw new Error(`${engine} did not launch`);
        const changes = await pressStack(browser, server.url);

        expect(changes).toEqual(STACK_LABELS.flatMap((_label, row) => BOX_POINTS.map(() => [row])));
      },
      TEST_MS
    );

    it.each(OVERLAY_SCENES)(
      'takes a press 21px from its centre on every side inside an overlay body, $name',
      async (scene) => {
        const browser = browsers[engine];
        if (browser === undefined) throw new Error(`${engine} did not launch`);
        const reading = await readOverlayCheck(browser, server.url, scene);

        expect(reading.hits).toEqual([true, true, true, true]);
      },
      TEST_MS
    );
  });
});
