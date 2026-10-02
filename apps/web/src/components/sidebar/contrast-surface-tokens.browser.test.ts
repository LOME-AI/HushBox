import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import tailwindcss from '@tailwindcss/vite';
import { chromium, firefox, type Browser, type Page } from '@playwright/test';

import { startFixtureServer, type FixtureServer } from '@/test-utils/fixture-server';

/**
 * Resolves the accessibility contrast tiers' surface tokens in real engines, through the
 * opacity modifier the sidebar's hover fill uses (`chat-item.tsx`). Each tier declares
 * those tokens as a `color-mix()` over other custom properties, and the utility wraps the
 * result in a second `color-mix()` — so what a reader sees depends on a `var()` chain
 * being resolved twice, by a cascade, in a browser. No source-parsing test reaches that,
 * and the DOM this package's other tests run in returns the empty string for a computed
 * `color-mix()`, so a chain that stopped resolving would ship as an invisible hover.
 *
 * `@vitest/browser` is not installed. This follows the repo's established pattern for
 * driving real Playwright from ordinary Vitest: a fixture server started through
 * `startFixtureServer` (`src/test-utils/fixture-server.ts`) plus `@playwright/test` launched
 * directly.
 *
 * Chromium and Firefox only: CI installs those two, so a WebKit launch here would pass
 * locally and fail there.
 */

const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'contrast-surface-tokens-fixture'
);

type EngineName = 'chromium' | 'firefox';
const ENGINES: readonly EngineName[] = ['chromium', 'firefox'];

const THEMES = ['light', 'dark'] as const;
type ThemeName = (typeof THEMES)[number];

interface Pixel {
  r: number;
  g: number;
  b: number;
  a: number;
}

interface Reading {
  railComputed: string;
  fillComputed: string;
  rail: Pixel;
  fill: Pixel;
  composite: Pixel;
}

interface Cell {
  label: string;
  theme: ThemeName;
  /** Null for the untiered document each tier is compared against. */
  tier: string | null;
  reading: Reading;
}

/** Largest absolute per-channel difference between two opaque colours, in 0-255 steps. */
function channelDistance(left: Pixel, right: Pixel): number {
  return Math.max(
    Math.abs(left.r - right.r),
    Math.abs(left.g - right.g),
    Math.abs(left.b - right.b)
  );
}

/**
 * How far a hover fill must sit from the rail beneath it, as the largest per-channel
 * difference in 0-255 steps. Every tier that carries a full-strength rail step lands at 18
 * or more; the floor is set a step under the thinnest of them so an engine rounding a
 * channel differently is not a failure, while a fill that collapsed toward its rail is.
 */
const RAIL_DISTANCE_FLOOR = 17;

/**
 * The cells the low tier's capped rail step puts under that floor, each held to the
 * distance it does keep. A tier added later is held to the shared floor until someone
 * measures it and decides otherwise here.
 */
const RAIL_DISTANCE_FLOOR_BY_CELL: ReadonlyMap<string, number> = new Map([
  // Muted text on the rail fill needs 4.5:1, which caps this tier's rail step at 7% in
  // `packages/ui/src/components/accessibility/styles/contrast.css`. In the light half the
  // sidebar's own step darkens the rail in the same direction the fill's ink step moves,
  // so the two land a single byte apart — 1.009:1 composited, which nobody can see. That
  // is the ruled cost of putting the text floor first, not a defect, and the fix named
  // alongside that ruling is giving the active row its own mark rather than widening this
  // step. One byte is all this cell can assert, and what it asserts is that the chain
  // still resolves and still moves, never that the result is visible.
  ['a11y-contrast-low/light', 1],
  // The same 7% step, but the dark half's ink sits above its canvas while the sidebar's
  // step sits below it, so fill and rail move apart instead of together and the gap
  // survives at 6 bytes / 1.064:1. Thin, and real: held to its own floor rather than
  // waved through with the light half.
  ['a11y-contrast-low/dark', 5],
]);

function railDistanceFloor(label: string): number {
  return RAIL_DISTANCE_FLOOR_BY_CELL.get(label) ?? RAIL_DISTANCE_FLOOR;
}

/**
 * Opens the fixture and reads every cell in one round trip. A page that dies takes its
 * whole test with it rather than half a matrix, and the caller closes it either way.
 */
async function readCells(browser: Browser, origin: string): Promise<Cell[]> {
  const page: Page = await browser.newPage();
  try {
    await page.goto(`${origin}/contrast-surface-tokens.html`);
    // The stylesheet is what the tier list is read out of, so a non-empty list is also
    // the signal that the cascade under test has arrived.
    await page.waitForFunction(() => (__surfaces?.tierClasses().length ?? 0) > 0);
    return await page.evaluate((themes) => {
      if (__surfaces === undefined) throw new Error('__surfaces not ready');
      const surfaces = __surfaces;
      const cells = [];
      for (const theme of themes) {
        const suffix = theme === 'dark' ? 'dark' : '';
        cells.push({
          label: `untiered/${theme}`,
          theme,
          tier: null,
          reading: surfaces.measure(suffix),
        });
        for (const tier of surfaces.tierClasses()) {
          cells.push({
            label: `${tier}/${theme}`,
            theme,
            tier,
            reading: surfaces.measure(`${tier} ${suffix}`.trim()),
          });
        }
      }
      return cells;
    }, THEMES);
  } finally {
    await page.close();
  }
}

function tieredCells(cells: readonly Cell[]): Cell[] {
  return cells.filter((cell) => cell.tier !== null);
}

function untieredCell(cells: readonly Cell[], theme: ThemeName): Cell {
  const cell = cells.find((candidate) => candidate.tier === null && candidate.theme === theme);
  if (cell === undefined) throw new Error(`no untiered reading for the ${theme} theme`);
  return cell;
}

describe('contrast tier surface tokens (real browser)', () => {
  let server: FixtureServer;
  const browsers: Partial<Record<EngineName, Browser>> = {};

  beforeAll(async () => {
    server = await startFixtureServer({ root: FIXTURE_DIR, plugins: [tailwindcss()] });
    const [chromiumBrowser, firefoxBrowser] = await Promise.all([
      chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] }),
      firefox.launch(),
    ]);
    browsers.chromium = chromiumBrowser;
    browsers.firefox = firefoxBrowser;
  }, 120_000);

  afterAll(async () => {
    await Promise.all(Object.values(browsers).map((browser) => browser.close()));
    await server.close();
  });

  function requireBrowser(engine: EngineName): Browser {
    const browser = browsers[engine];
    if (browser === undefined) throw new Error(`${engine} did not launch`);
    return browser;
  }

  it.each(ENGINES)(
    'the sidebar hover fill paints a partly transparent colour under every contrast tier, on %s',
    async (engine) => {
      const cells = await readCells(requireBrowser(engine), server.url);
      expect(tieredCells(cells).length).toBeGreaterThan(0);
      for (const cell of tieredCells(cells)) {
        // Zero would mean the token chain collapsed to the initial `transparent`; full
        // opacity would mean the modifier was dropped on the way through.
        expect(cell.reading.fill.a, `${cell.label} alpha`).toBeGreaterThan(0);
        expect(cell.reading.fill.a, `${cell.label} alpha`).toBeLessThan(255);
      }
    },
    120_000
  );

  it.each(ENGINES)(
    'the sidebar hover fill holds its floor against the rail beneath it under every contrast tier, on %s',
    async (engine) => {
      const cells = await readCells(requireBrowser(engine), server.url);
      expect(tieredCells(cells).length).toBeGreaterThan(0);
      const measured = tieredCells(cells).map((cell) => ({
        cell: cell.label,
        distance: channelDistance(cell.reading.composite, cell.reading.rail),
        floor: railDistanceFloor(cell.label),
      }));
      // Collected rather than asserted cell by cell: a retuned step thins several cells at
      // once, and the failure should name all of them instead of stopping at the first.
      expect(measured.filter((entry) => entry.distance < entry.floor)).toEqual([]);
    },
    120_000
  );

  it.each(ENGINES)(
    'every contrast tier moves the sidebar hover fill off the untiered colour, on %s',
    async (engine) => {
      const cells = await readCells(requireBrowser(engine), server.url);
      expect(tieredCells(cells).length).toBeGreaterThan(0);
      for (const cell of tieredCells(cells)) {
        const untiered = untieredCell(cells, cell.theme);
        expect(
          channelDistance(cell.reading.composite, untiered.reading.composite),
          `${cell.label} hover fill against ${untiered.label}`
        ).toBeGreaterThanOrEqual(1);
      }
    },
    120_000
  );
});
