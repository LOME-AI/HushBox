import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, firefox, type Browser } from '@playwright/test';

import { contrastRatio } from '@hushbox/shared/color/contrast';
import { startFixtureServer, type FixtureServer } from '@/test-utils/fixture-server';

/**
 * Lays the usage page's Cost by Model block out in a real engine, under the app's own
 * stylesheet, at the width the usage page gives the block: whether any name, amount or bar
 * overlaps another or leaves the block, whether the rows switch layout on the block's own
 * width, and whether every text meets the contrast floor. The DOM the unit tests run in lays
 * nothing out.
 */

const DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(DIRECTORY, 'cost-by-model-chart-fixture');
const SRC_DIR = path.resolve(DIRECTORY, '../..');

/** The first load compiles the app's whole stylesheet, which a busy machine can make slow. */
const LOAD_MS = 90_000;
const TEST_MS = LOAD_MS * 2;
const CLOSE_MS = 45_000;

/** Sub-pixel layout rounding the comparison forgives. */
const EDGE_TOLERANCE_PX = 0.5;

/** WCAG's floors: body text, and large text (the block's heading). */
const TEXT_CONTRAST_FLOOR = 4.5;
const LARGE_TEXT_CONTRAST_FLOOR = 3;

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface Row {
  name: Box;
  nameText: string;
  nameClipped: boolean;
  track: Box;
  amount: Box;
  amountText: string;
}

interface Text {
  text: string;
  colour: string;
  background: string;
  large: boolean;
}

interface Layout {
  block: Box;
  rows: Row[];
  texts: Text[];
  pageOverflow: number;
}

type RowLayout = 'track-below' | 'one-line';

interface View {
  label: string;
  /** The viewport, which sets the width band's root size. */
  viewport: number;
  /** The block's width the usage page gives it at that viewport and text size. */
  block: number;
  scale?: string;
  expected: RowLayout;
}

/** The usage page's block widths, measured on the live page at each viewport. */
const PAGE_VIEWS: readonly View[] = [
  { label: '320', viewport: 320, block: 288, expected: 'track-below' },
  { label: '390', viewport: 390, block: 358, expected: 'track-below' },
  { label: '834', viewport: 834, block: 741, expected: 'one-line' },
  { label: '1440', viewport: 1440, block: 438, expected: 'one-line' },
  { label: '320 with 141% text', viewport: 320, block: 272, scale: '141', expected: 'track-below' },
];

const ENGINES = [
  ['chromium', 'light'],
  ['chromium', 'dark'],
  ['firefox', 'light'],
  ['firefox', 'dark'],
] as const;

type EngineName = (typeof ENGINES)[number][0];

function overlaps(a: Box, b: Box): boolean {
  return (
    a.left < b.right - EDGE_TOLERANCE_PX &&
    b.left < a.right - EDGE_TOLERANCE_PX &&
    a.top < b.bottom - EDGE_TOLERANCE_PX &&
    b.top < a.bottom - EDGE_TOLERANCE_PX
  );
}

function inside(inner: Box, outer: Box): boolean {
  return (
    inner.left >= outer.left - EDGE_TOLERANCE_PX && inner.right <= outer.right + EDGE_TOLERANCE_PX
  );
}

function rowLayout({ name, amount, track }: Row): RowLayout {
  return track.top >= Math.max(name.bottom, amount.bottom) - EDGE_TOLERANCE_PX
    ? 'track-below'
    : 'one-line';
}

function expectNothingOverlapsOrOverflows({ block, rows, pageOverflow }: Layout): void {
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    const where = `row "${row.nameText}"`;
    expect(overlaps(row.name, row.amount), `${where}: name over amount`).toBe(false);
    expect(overlaps(row.name, row.track), `${where}: name over bar`).toBe(false);
    expect(overlaps(row.amount, row.track), `${where}: amount over bar`).toBe(false);
    for (const part of [row.name, row.amount, row.track]) {
      expect(inside(part, block), `${where} leaves the block`).toBe(true);
    }
    expect(row.nameClipped, `${where}: name clipped`).toBe(false);
  }
  for (const [index, row] of rows.entries()) {
    const next = rows[index + 1];
    if (next === undefined) continue;
    const bottom = Math.max(row.name.bottom, row.amount.bottom, row.track.bottom);
    const top = Math.min(next.name.top, next.amount.top, next.track.top);
    expect(top, `row "${next.nameText}" over the row above`).toBeGreaterThanOrEqual(
      bottom - EDGE_TOLERANCE_PX
    );
  }
  expect(pageOverflow).toBeLessThanOrEqual(0);
}

/** An engine's computed `rgb(r, g, b)` or `rgba(r, g, b, a)` colour: its channels and alpha. */
function channels(colour: string): { rgb: [number, number, number]; alpha: number } {
  const match = /^rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)$/.exec(colour);
  if (match === null) throw new Error(`not a computed rgb colour: ${colour}`);
  return {
    rgb: [Number(match[1]), Number(match[2]), Number(match[3])],
    alpha: match[4] === undefined ? 1 : Number(match[4]),
  };
}

/** A see-through text colour as it lands on the background it is drawn over. */
function painted(text: string, background: string): [number, number, number] {
  const { rgb, alpha } = channels(text);
  const under = channels(background).rgb;
  const mix = (top: number, bottom: number): number =>
    Math.round(top * alpha + bottom * (1 - alpha));
  return [mix(rgb[0], under[0]), mix(rgb[1], under[1]), mix(rgb[2], under[2])];
}

function expectTextContrast({ texts }: Layout): void {
  expect(texts.length).toBeGreaterThan(1);
  for (const text of texts) {
    const ratio = contrastRatio(
      painted(text.colour, text.background),
      channels(text.background).rgb
    );
    expect(ratio, `"${text.text}"`).toBeGreaterThanOrEqual(
      text.large ? LARGE_TEXT_CONTRAST_FLOOR : TEXT_CONTRAST_FLOOR
    );
  }
}

describe('cost by model block (real browser)', () => {
  let server: FixtureServer;
  const browsers: Partial<Record<EngineName, Browser>> = {};

  beforeAll(async () => {
    server = await startFixtureServer({
      root: FIXTURE_DIR,
      configFile: false,
      plugins: [react(), tailwindcss()],
      resolve: {
        alias: [
          // The catalog is served by the fixture, so the page's labels need no network.
          {
            find: /^@\/hooks\/models\/models$/,
            replacement: path.join(FIXTURE_DIR, 'models-stub.ts'),
          },
          { find: /^@\/(.*)$/, replacement: path.join(SRC_DIR, '$1') },
        ],
      },
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

  async function layoutAt(
    engine: EngineName,
    theme: string,
    { viewport, block, scale }: Omit<View, 'label' | 'expected'>
  ): Promise<Layout> {
    const browser = browsers[engine];
    if (browser === undefined) throw new Error(`${engine} did not launch`);
    const context = await browser.newContext({ viewport: { width: viewport, height: 900 } });
    try {
      const page = await context.newPage();
      const query = new URLSearchParams({ block: String(block), theme });
      if (scale !== undefined) query.set('scale', scale);
      await page.goto(`${server.url}/cost-by-model-chart.html?${query.toString()}`, {
        waitUntil: 'commit',
        timeout: LOAD_MS,
      });
      await page.waitForFunction(
        () => globalThis.__costByModel !== undefined && document.fonts.status === 'loaded',
        undefined,
        { timeout: LOAD_MS }
      );
      return await page.evaluate(() => {
        if (__costByModel === undefined) throw new Error('__costByModel not ready');
        return __costByModel.measure();
      });
    } finally {
      await context.close();
    }
  }

  // One load per engine, theme and view: the cases below read the same laid-out page.
  const layouts = new Map<string, Promise<Layout>>();
  function layoutOnce(
    engine: EngineName,
    theme: string,
    view: Omit<View, 'label' | 'expected'>
  ): Promise<Layout> {
    const key = JSON.stringify([engine, theme, view.viewport, view.block, view.scale]);
    const cached = layouts.get(key);
    if (cached !== undefined) return cached;
    const layout = layoutAt(engine, theme, view);
    layouts.set(key, layout);
    return layout;
  }

  describe.each(ENGINES)('in %s, %s', (engine, theme) => {
    it.each(PAGE_VIEWS)(
      'lays the rows out with nothing overlapping or leaving the block at $label',
      async (view) => {
        expectNothingOverlapsOrOverflows(await layoutOnce(engine, theme, view));
      },
      TEST_MS
    );

    it.each(PAGE_VIEWS)(
      'switches the row layout on the block width at $label',
      async (view) => {
        const { rows } = await layoutOnce(engine, theme, view);
        expect(rows.map((row) => rowLayout(row))).toEqual(rows.map(() => view.expected));
      },
      TEST_MS
    );

    it.each(PAGE_VIEWS)(
      'draws every text at the contrast floor at $label',
      async (view) => {
        expectTextContrast(await layoutOnce(engine, theme, view));
      },
      TEST_MS
    );

    it(
      'puts the bar on its own line when the block is narrow in a wide viewport',
      async () => {
        const { rows } = await layoutOnce(engine, theme, { viewport: 1440, block: 288 });
        expect(rows.map((row) => rowLayout(row))).toEqual(rows.map(() => 'track-below'));
      },
      TEST_MS
    );
  });
});
