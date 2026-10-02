import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, firefox, type Browser, type Page } from '@playwright/test';

import { contrastRatio } from '@hushbox/shared/color/contrast';
import { startFixtureServer, type FixtureServer } from '@/test-utils/fixture-server';
import { formatPeriodLabel } from './chart-utilities';
import { FIXTURE_PERIODS } from './spending-over-time-chart-fixture/fixture-periods';

/**
 * Lays the usage page's spending chart out in a real engine, under the app's own stylesheet
 * and the accessibility widget's text-size class: whether a long legend stays inside the
 * chart's block, below the plot, without taking the plot's height or drawing over the
 * blocks around it. The DOM the unit tests run in lays nothing out.
 */

const DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(DIRECTORY, 'spending-over-time-chart-fixture');
const SRC_DIR = path.resolve(DIRECTORY, '../..');

/** The first load compiles the app's whole stylesheet, which a busy machine can make slow. */
const FIXTURE_LOAD_MS = 90_000;
const TEST_MS = FIXTURE_LOAD_MS + 30_000;

/** Sub-pixel layout rounding the comparison forgives. */
const EDGE_TOLERANCE_PX = 0.5;

/** The plot's fixed height, which the legend must not take from. */
const PLOT_HEIGHT_PX = 300;

/**
 * How much of the plot's height the y-axis figures span when nothing else is drawn inside the
 * plot: the x-axis labels and the chart margins take the rest. A legend drawn inside the plot takes
 * its height from here, which is how it squeezes the plot.
 */
const Y_AXIS_SHARE = 0.8;

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  height: number;
}

interface Label {
  text: string;
  left: number;
  right: number;
}

interface Layout {
  before: Rect;
  block: Rect;
  plot: Rect;
  yAxis: Rect;
  legend: Rect;
  entries: Rect[];
  after: Rect;
  xLabels: Label[];
  pageOverflow: number;
}

/** The fixture's first and last periods, as the x-axis prints them. */
const FIRST_DATE = formatPeriodLabel(FIXTURE_PERIODS.at(0) ?? '');
const LAST_DATE = formatPeriodLabel(FIXTURE_PERIODS.at(-1) ?? '');

/** WCAG's floor for text below the large-text size, which the 12px axis figures are. */
const TEXT_CONTRAST_FLOOR = 4.5;

interface AxisFigure {
  axis: 'x' | 'y';
  text: string;
  fill: string;
  background: string;
}

/** An engine's computed `rgb(r, g, b)` or `rgba(r, g, b, a)` colour, as its three channels. */
function channels(colour: string): [number, number, number] {
  const match = /^rgba?\((\d+), (\d+), (\d+)/.exec(colour);
  if (match === null) throw new Error(`not a computed rgb colour: ${colour}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * How long the chart may take to lay its dates out again after the text grows under it. The
 * wait ends as soon as the dates stand apart; past it, the assertions report what was drawn.
 */
const RELAYOUT_MS = 10_000;

const WIDTHS = [320, 390, 834, 1440, 1920];

interface View {
  width: number;
  query: string;
  /** Run once the chart has drawn, before it is measured. */
  afterDraw?: (page: Page) => Promise<void>;
}

async function layoutAt(
  browser: Browser,
  origin: string,
  { width, query, afterDraw }: View
): Promise<Layout> {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  try {
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    // Navigation takes the load budget too: Playwright's own 30s default would cut a slow
    // first compile short. The drawn-axis wait below is what proves the page arrived.
    await page.goto(`${origin}/spending-over-time-chart.html?${query}`, {
      waitUntil: 'commit',
      timeout: FIXTURE_LOAD_MS,
    });
    await page
      .waitForFunction(
        () =>
          globalThis.__chart !== undefined &&
          document.querySelector('[data-chart] .recharts-yAxis-tick-labels text') !== null,
        undefined,
        { timeout: FIXTURE_LOAD_MS }
      )
      .catch((error: unknown) => {
        // A plot squeezed to nothing draws no axis, so a squeeze fails here too.
        throw new Error(`the chart never drew its axis; page errors: ${pageErrors.join(' | ')}`, {
          cause: error,
        });
      });
    await afterDraw?.(page);
    return await page.evaluate(() => {
      if (__chart === undefined) throw new Error('__chart not ready');
      return __chart.measure();
    });
  } finally {
    await context.close();
  }
}

function expectLegendInsideBlock({ block, plot, legend, entries }: Layout): void {
  expect(legend.top).toBeGreaterThanOrEqual(plot.bottom - EDGE_TOLERANCE_PX);
  expect(legend.bottom).toBeLessThanOrEqual(block.bottom + EDGE_TOLERANCE_PX);
  for (const entry of entries) {
    expect(entry.left).toBeGreaterThanOrEqual(block.left - EDGE_TOLERANCE_PX);
    expect(entry.right).toBeLessThanOrEqual(block.right + EDGE_TOLERANCE_PX);
    expect(entry.bottom).toBeLessThanOrEqual(block.bottom + EDGE_TOLERANCE_PX);
  }
}

/** The axis figures of the chart as drawn at 390, under the fixture query given. */
async function figuresAt(browser: Browser, origin: string, query: string): Promise<AxisFigure[]> {
  let figures: AxisFigure[] = [];
  await layoutAt(browser, origin, {
    width: 390,
    query,
    afterDraw: async (page) => {
      figures = await page.evaluate(() => {
        if (__chart === undefined) throw new Error('__chart not ready');
        return __chart.axisFigures();
      });
    },
  });
  return figures;
}

/** Grows the text to the widget's largest step with the chart on screen, as the widget does. */
async function growTextTo141(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (__chart === undefined) throw new Error('__chart not ready');
    __chart.setScale('141');
  });
  await page
    .waitForFunction(
      () =>
        __chart
          ?.xLabels()
          .every(
            (label, index, labels) =>
              index === 0 || label.left >= (labels[index - 1]?.right ?? Number.NEGATIVE_INFINITY)
          ),
      undefined,
      { timeout: RELAYOUT_MS }
    )
    .catch(() => {
      // The dates never stood apart; the assertions report how they were drawn.
    });
}

function expectDatesApart({ xLabels }: Layout): void {
  for (const [index, label] of xLabels.entries()) {
    const previous = xLabels[index - 1];
    if (previous !== undefined) {
      expect(label.left, `${previous.text} and ${label.text}`).toBeGreaterThanOrEqual(
        previous.right - EDGE_TOLERANCE_PX
      );
    }
  }
  expect(xLabels.at(0)?.text).toBe(FIRST_DATE);
  expect(xLabels.at(-1)?.text).toBe(LAST_DATE);
}

describe('spending over time chart (real browser)', () => {
  let server: FixtureServer;
  let browser: Browser;
  let firefoxBrowser: Browser;

  beforeAll(async () => {
    server = await startFixtureServer({
      root: FIXTURE_DIR,
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
    });
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    firefoxBrowser = await firefox.launch();
  }, 120_000);

  afterAll(async () => {
    await Promise.all([browser.close(), firefoxBrowser.close()]);
    await server.close();
  });

  it(
    'keeps the legend inside its block, below the plot, at 320 with 141% text',
    async () => {
      expectLegendInsideBlock(
        await layoutAt(browser, server.url, { width: 320, query: 'scale=141' })
      );
    },
    TEST_MS
  );

  it(
    "keeps the plot's full height at 320 with 141% text",
    async () => {
      const { plot, yAxis } = await layoutAt(browser, server.url, {
        width: 320,
        query: 'scale=141',
      });
      expect(plot.height).toBeCloseTo(PLOT_HEIGHT_PX, 0);
      expect(yAxis.height).toBeGreaterThanOrEqual(PLOT_HEIGHT_PX * Y_AXIS_SHARE);
    },
    TEST_MS
  );

  it(
    'draws the legend over neither the block before it nor the one after at 320 with 141% text',
    async () => {
      const { before, legend, after } = await layoutAt(browser, server.url, {
        width: 320,
        query: 'scale=141',
      });
      expect(legend.top).toBeGreaterThanOrEqual(before.bottom - EDGE_TOLERANCE_PX);
      expect(after.top).toBeGreaterThanOrEqual(legend.bottom - EDGE_TOLERANCE_PX);
    },
    TEST_MS
  );

  it(
    'scrolls the page no wider than the screen at 320 with 141% text',
    async () => {
      const { pageOverflow } = await layoutAt(browser, server.url, {
        width: 320,
        query: 'scale=141',
      });
      expect(pageOverflow).toBeLessThanOrEqual(0);
    },
    TEST_MS
  );

  it(
    "keeps the plot's full height at 390",
    async () => {
      const { plot, yAxis } = await layoutAt(browser, server.url, { width: 390, query: '' });
      expect(plot.height).toBeCloseTo(PLOT_HEIGHT_PX, 0);
      expect(yAxis.height).toBeGreaterThanOrEqual(PLOT_HEIGHT_PX * Y_AXIS_SHARE);
    },
    TEST_MS
  );

  it(
    'keeps the legend inside its block at 1440',
    async () => {
      expectLegendInsideBlock(await layoutAt(browser, server.url, { width: 1440, query: '' }));
    },
    TEST_MS
  );

  describe.each([
    ['chromium', (): Browser => browser],
    ['firefox', (): Browser => firefoxBrowser],
  ])('the axis figures in %s', (_engine, engine) => {
    it.each(['light', 'dark'])(
      'draws every axis figure at text contrast against the page, %s',
      async (theme) => {
        const figures = await figuresAt(engine(), server.url, `theme=${theme}`);
        expect(figures.map((figure) => figure.axis)).toEqual(expect.arrayContaining(['x', 'y']));
        for (const figure of figures) {
          const ratio = contrastRatio(channels(figure.fill), channels(figure.background));
          expect(ratio, `${figure.axis}-axis "${figure.text}"`).toBeGreaterThanOrEqual(
            TEXT_CONTRAST_FLOOR
          );
        }
      },
      TEST_MS
    );
  });

  describe.each([
    ['chromium', (): Browser => browser],
    ['firefox', (): Browser => firefoxBrowser],
  ])('the x-axis dates in %s', (_engine, engine) => {
    it(
      'keeps the dates apart at 320 with 141% text, the first and last kept',
      async () => {
        expectDatesApart(await layoutAt(engine(), server.url, { width: 320, query: 'scale=141' }));
      },
      TEST_MS
    );

    it(
      'keeps the dates apart when the text grows to 141% with the chart on screen at 320',
      async () => {
        expectDatesApart(
          await layoutAt(engine(), server.url, { width: 320, query: '', afterDraw: growTextTo141 })
        );
      },
      TEST_MS
    );

    it(
      'keeps the dates apart at every width, at the default text and at 141%',
      async () => {
        for (const width of WIDTHS) {
          for (const query of ['', 'scale=141']) {
            expectDatesApart(await layoutAt(engine(), server.url, { width, query }));
          }
        }
      },
      TEST_MS * 2
    );
  });
});
