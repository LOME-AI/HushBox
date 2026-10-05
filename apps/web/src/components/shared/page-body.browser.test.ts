import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, firefox, type Browser, type Page } from '@playwright/test';

import { startFixtureServer, type FixtureServer } from '@/test-utils/fixture-server';

/**
 * Lays a page body out in a real engine, under the app's own stylesheet: whether its pinned band
 * sticks to the scroller's top or scrolls with the page, which turns on the band's laid-out height
 * against the scroller's. The DOM the unit tests run in lays nothing out.
 */

const DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(DIRECTORY, 'page-body-fixture');
const SRC_DIR = path.resolve(DIRECTORY, '../..');

/** The first load compiles the app's whole stylesheet, which a busy machine can make slow. */
const LOAD_MS = 90_000;
const TEST_MS = LOAD_MS * 2;
const CLOSE_MS = 45_000;
/** How long a text-size change on the live page may take to reach the band's position. */
const SETTLE_MS = 30_000;

/** The accessibility widget's largest text size. */
const LARGEST_TEXT = '141';
/** How far the tests scroll the page: less than the page's overflow in every case. */
const SCROLL_PX = 200;
/** Tab presses in a focus walk: past the cards that fit under a pinned band at every case. */
const TAB_PRESSES = 40;
/** How far under the pinned band the clicked card's top sits: its lower part stays in view. */
const UNDER_BAND_PX = 40;
/** How far above its bottom edge the pointer clicks the card. */
const CLICK_ABOVE_BOTTOM_PX = 10;
/** The most presses a walk out of the page body may take: past every tab stop it holds. */
const WALK_LIMIT = 120;
/** Long past any resize and scroll a focus change starts. */
const FOCUS_SETTLE_MS = 500;
/** Long past any scroll a focus handler would start on the click. */
const POINTER_SETTLE_MS = 500;
/** Sub-pixel layout rounding the comparison forgives. */
const EDGE_TOLERANCE_PX = 0.5;

interface Viewport {
  width: number;
  height: number;
}

interface BandCase {
  label: string;
  viewport: Viewport;
  scale?: string;
  /** The band content's height, in rem, that gives the measured share at this size. */
  bandRem: number;
  /** The band's height over the scroller's that this case must reproduce. */
  share: { min: number; max: number };
  pinned: boolean;
}

/** The /accessibility page's measured band shares, reproduced in the fixture. */
const BAND_CASES: readonly BandCase[] = [
  {
    label: '768x900 at 100% text (55%)',
    viewport: { width: 768, height: 900 },
    bandRem: 25,
    share: { min: 0.53, max: 0.57 },
    pinned: true,
  },
  {
    label: '1440x900 at the largest text (about 68%)',
    viewport: { width: 1440, height: 900 },
    scale: LARGEST_TEXT,
    bandRem: 21,
    share: { min: 0.66, max: 0.7 },
    pinned: true,
  },
  {
    label: '834x1112 at the largest text (90%)',
    viewport: { width: 834, height: 1112 },
    scale: LARGEST_TEXT,
    bandRem: 36,
    share: { min: 0.88, max: 0.92 },
    pinned: false,
  },
  {
    label: '768x900 at the largest text (over 100%)',
    viewport: { width: 768, height: 900 },
    scale: LARGEST_TEXT,
    bandRem: 40,
    share: { min: 1, max: Number.POSITIVE_INFINITY },
    pinned: false,
  },
];

interface FocusCase {
  label: string;
  viewport: Viewport;
  scale?: string;
  bandRem: number;
  /** The height, in rem, of the band's part that sticks on its own below 768, if it has one. */
  stickyRem?: number;
  /** Whether the band holds /accessibility's own preview as its part that sticks below 768. */
  preview?: boolean;
  /** The height, in rem, of text with no control above the cards, as a section heading's. */
  leadRem?: number;
  /** The widget's other classes on `<html>`. */
  classes?: string[];
  /** The widget's font face. */
  face?: string;
  /** The height, in rem, of a control before the cards, taller than the room under the preview. */
  tallRem?: number;
}

/**
 * Phones, where the band has no box and a part of it, as tall as /accessibility's preview
 * (160-263px across these sizes), sticks on its own below the links that scroll away.
 */
const PHONE_CASES: readonly FocusCase[] = [
  {
    label: '390x844 at 100% text',
    viewport: { width: 390, height: 844 },
    bandRem: 6,
    stickyRem: 10,
  },
  {
    label: '390x844 at the largest text',
    viewport: { width: 390, height: 844 },
    scale: LARGEST_TEXT,
    bandRem: 6,
    stickyRem: 10,
  },
  {
    label: '320x640 at 100% text',
    viewport: { width: 320, height: 640 },
    bandRem: 6,
    stickyRem: 10,
  },
  {
    label: '320x640 at the largest text',
    viewport: { width: 320, height: 640 },
    scale: LARGEST_TEXT,
    bandRem: 6,
    stickyRem: 10,
  },
];

/**
 * Landscape phones at the largest text, where the part that would stick takes over 70% of the
 * scroller (as /accessibility's preview does, at 81% and 85%), so it scrolls with the page.
 */
const LANDSCAPE_CASES: readonly FocusCase[] = [
  {
    label: '667x375 at the largest text',
    viewport: { width: 667, height: 375 },
    scale: LARGEST_TEXT,
    bandRem: 6,
    stickyRem: 8.5,
  },
  {
    label: '740x360 at the largest text',
    viewport: { width: 740, height: 360 },
    scale: LARGEST_TEXT,
    bandRem: 6,
    stickyRem: 8.5,
  },
];

/**
 * Narrow phones at the largest text with the real preview, which takes about half the scroller
 * at rest and, once keyboard focus on its link lifts its clamp, more than 70% of it or more than
 * all of it. A 6rem lead stands for the Quick starts heading and summary above the first card.
 */
const PREVIEW_CASES: readonly FocusCase[] = [
  {
    label: '320x640 at the largest text, with the preview',
    viewport: { width: 320, height: 640 },
    scale: LARGEST_TEXT,
    bandRem: 6,
    preview: true,
    leadRem: 6,
  },
  {
    label: '320x568 at the largest text, with the preview',
    viewport: { width: 320, height: 568 },
    scale: LARGEST_TEXT,
    bandRem: 6,
    preview: true,
    leadRem: 6,
  },
];

/**
 * The widget at its extremes on a short phone: the largest text, wide lines, wider letters and
 * OpenDyslexic, where the preview's reply, unclamped, would outgrow the scroller, and where a
 * Quick starts card grows taller than the room left under the preview.
 */
const EXTREME_CASE: FocusCase = {
  label: '320x568 at the largest text, wide lines, wider letters and OpenDyslexic',
  viewport: { width: 320, height: 568 },
  scale: LARGEST_TEXT,
  classes: ['a11y-line-height-double', 'a11y-letter-spacing-loosest'],
  face: 'open-dyslexic',
  bandRem: 6,
  preview: true,
  leadRem: 6,
  tallRem: 9,
};

/** A desktop-band page with the preview, where its link stays a link. */
const DESKTOP_PREVIEW_CASE: FocusCase = {
  label: '768x900 at 100% text, with the preview',
  viewport: { width: 768, height: 900 },
  bandRem: 6,
  preview: true,
};

/** The share of the scroller past which nothing at its top may stick. */
const MAX_PINNED_SHARE = 0.7;

/** Every case where something sticks at the scroller's top: the pinned bands and the phones. */
const FOCUS_CASES: readonly FocusCase[] = [
  ...BAND_CASES.filter((bandCase) => bandCase.pinned),
  ...PHONE_CASES,
  ...PREVIEW_CASES,
  EXTREME_CASE,
];

/** The live text-size change: pinned at 100% text and scrolling at the largest at 768x900. */
const LIVE_CASE = { viewport: { width: 768, height: 900 }, bandRem: 25 } as const;

const ENGINES = ['chromium', 'firefox'] as const;

type EngineName = (typeof ENGINES)[number];

interface FocusWalk {
  /** For each content control the walk focused, its top edge less the band's bottom edge. */
  clearances: number[];
  /** Each band control the walk focused, the preview's link included, that the scroller cuts off. */
  cutOff: string[];
  scrollTop: number;
  /** The furthest the frame around the page body scrolled during the walk. */
  frameShift: number;
}

interface Reading {
  position: string;
  top: number;
  bandHeight: number;
  scrollerHeight: number;
  scrollTop: number;
  frameScrollTop: number;
}

/**
 * Runs in the page: scrolls the first content card until its top sits `under` px below the pinned
 * band's bottom, and returns a point `above` px over the card's bottom edge and the scroll offset.
 */
function placeCardUnderBand({ under, above }: { under: number; above: number }): {
  x: number;
  y: number;
  scrollTop: number;
} {
  const scroller = document.querySelector<HTMLElement>('[data-page-scroller]');
  const band = scroller?.querySelector<HTMLElement>('[data-page-pinned]');
  const card = [...(scroller?.querySelectorAll<HTMLElement>('button') ?? [])].find(
    (button) => !band?.contains(button)
  );
  if (!scroller || !band || !card) throw new Error('the page has no card to click');
  const offset = card.getBoundingClientRect().top - band.getBoundingClientRect().bottom;
  scroller.scrollTop += offset + under;
  const rect = card.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.bottom - above, scrollTop: scroller.scrollTop };
}

describe('page body pinned band (real browser)', () => {
  let server: FixtureServer;
  const browsers: Partial<Record<EngineName, Browser>> = {};

  beforeAll(async () => {
    server = await startFixtureServer({
      root: FIXTURE_DIR,
      configFile: false,
      plugins: [react(), tailwindcss()],
      // The real preview reaches its own modules through the app's source alias.
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

  /** Opens the fixture page in `engine`, mounted with its fonts loaded, and runs `use` on it. */
  async function withPage<T>(
    engine: EngineName,
    {
      viewport,
      scale,
      bandRem,
      stickyRem,
      preview,
      leadRem,
      classes,
      face,
      tallRem,
    }: {
      viewport: Viewport;
      scale?: string;
      bandRem: number;
      stickyRem?: number;
      preview?: boolean;
      leadRem?: number;
      classes?: string[];
      face?: string;
      tallRem?: number;
    },
    use: (page: Page) => Promise<T>
  ): Promise<T> {
    const browser = browsers[engine];
    if (browser === undefined) throw new Error(`${engine} did not launch`);
    const context = await browser.newContext({ viewport });
    try {
      const page = await context.newPage();
      const query = new URLSearchParams({ band: String(bandRem) });
      if (scale !== undefined) query.set('scale', scale);
      if (stickyRem !== undefined) query.set('sticky', String(stickyRem));
      if (preview === true) query.set('preview', '');
      if (leadRem !== undefined) query.set('lead', String(leadRem));
      if (classes !== undefined) query.set('classes', classes.join(','));
      if (face !== undefined) query.set('face', face);
      if (tallRem !== undefined) query.set('tall', String(tallRem));
      await page.goto(`${server.url}/page-body.html?${query.toString()}`, {
        waitUntil: 'commit',
        timeout: LOAD_MS,
      });
      await page.waitForFunction(
        () => globalThis.__pageBody !== undefined && document.fonts.status === 'loaded',
        undefined,
        { timeout: LOAD_MS }
      );
      return await use(page);
    } finally {
      await context.close();
    }
  }

  function read(page: Page): Promise<Reading> {
    return page.evaluate(() => {
      if (__pageBody === undefined) throw new Error('__pageBody not ready');
      return __pageBody.read();
    });
  }

  /** The band's reading at the page's top and again after the page scrolls by `SCROLL_PX`. */
  async function readBeforeAndAfterScroll(page: Page): Promise<[Reading, Reading]> {
    const before = await read(page);
    await page.evaluate((top) => {
      __pageBody?.scrollTo(top);
    }, SCROLL_PX);
    return [before, await read(page)];
  }

  /** The focused control's top less the bottom of what covers the scroller, if a control has focus. */
  async function clearance(page: Page): Promise<number | null> {
    const reading = await page.evaluate(() => __pageBody?.focusAgainstBand() ?? null);
    return reading === null ? null : reading.control - reading.band;
  }

  /** Tabs from the page's top through its controls, reading each focused control against the band. */
  async function walkFocus(page: Page): Promise<FocusWalk> {
    const walk: FocusWalk = { clearances: [], cutOff: [], scrollTop: 0, frameShift: 0 };
    for (let press = 0; press < TAB_PRESSES; press += 1) {
      await page.keyboard.press('Tab');
      await recordStep(page, walk);
    }
    const end = await read(page);
    walk.scrollTop = end.scrollTop;
    return walk;
  }

  /**
   * Walks by keyboard, forward from the page's top or back from its last control until focus
   * leaves the page body, and counts the elements focused in it and those inside the preview.
   */
  async function walkForPreviewFocus(
    page: Page,
    direction: 'forward' | 'back'
  ): Promise<{ focused: number; insidePreview: number }> {
    const back = direction === 'back';
    if (back) await page.evaluate(() => __pageBody?.focusLast());
    const key = back ? 'Shift+Tab' : 'Tab';
    const tally = { focused: 0, insidePreview: 0 };
    for (let press = 0; press < WALK_LIMIT; press += 1) {
      await page.keyboard.press(key);
      const where = await whereFocused(page);
      // Walking back, focus leaving the page body after it has been in it ends the walk.
      if (back && !where.inPage && tally.focused > 0) break;
      tally.focused += Number(where.inPage);
      tally.insidePreview += Number(where.inPreview);
    }
    return tally;
  }

  /** Whether focus is in the page body, and whether inside the preview. */
  function whereFocused(page: Page): Promise<{ inPage: boolean; inPreview: boolean }> {
    return page.evaluate(() => ({
      inPage: __pageBody?.focusedAgainstScroller() !== null,
      inPreview: __pageBody?.focusInsideStickyPart() === true,
    }));
  }

  /** The preview's link text: its element, whether a Tab reaches it, and its link styling. */
  function readPreviewLink(
    page: Page
  ): Promise<{ tag: string; tabbable: boolean; decoration: string; classes: string[] }> {
    return page.evaluate(() => {
      const part = document.querySelector('[data-page-pinned-sticky]');
      const text = [...(part?.querySelectorAll<HTMLElement>('*') ?? [])].find(
        (element) => element.textContent === 'hydration guide'
      );
      if (!text) throw new Error('the preview has no link text');
      return {
        tag: text.tagName,
        tabbable: text.tabIndex >= 0,
        decoration: getComputedStyle(text).textDecorationLine,
        classes: [...text.classList],
      };
    });
  }

  /** How far the focused element sits inside the scroller's top and bottom edges, if in it. */
  function shown(page: Page): Promise<{ top: number; bottom: number; inBand: boolean } | null> {
    return page.evaluate(() => __pageBody?.focusedAgainstScroller() ?? null);
  }

  /**
   * Reads the focused element: a content control against what covers the scroller's top, and a
   * band control against the scroller's own edges, once its focus has settled, since focus on the
   * preview's link grows the preview.
   */
  async function recordStep(page: Page, walk: FocusWalk): Promise<void> {
    const reading = await clearance(page);
    if (reading !== null) walk.clearances.push(reading);
    const { frameScrollTop } = await read(page);
    walk.frameShift = Math.max(walk.frameShift, frameScrollTop);
    let edges = await shown(page);
    if (edges?.inBand === true) {
      await page.waitForTimeout(FOCUS_SETTLE_MS);
      edges = await shown(page);
    }
    if (edges?.inBand === true && Math.min(edges.top, edges.bottom) < -EDGE_TOLERANCE_PX) {
      walk.cutOff.push(`band control cut off by ${String(edges.top)}, ${String(edges.bottom)}`);
    }
  }

  /**
   * Focuses the page's last control and walks back to its first with Shift+Tab, reading each
   * focused control against what covers the scroller's top. Its `scrollTop` is how far the walk
   * scrolled the page back up.
   */
  async function walkBack(page: Page): Promise<FocusWalk> {
    const controls = await page.evaluate(() => __pageBody?.focusLast() ?? 0);
    const start = await read(page);
    const walk: FocusWalk = { clearances: [], cutOff: [], scrollTop: 0, frameShift: 0 };
    await recordStep(page, walk);
    // One press past the first content control, so the walk reaches the band's last control.
    for (let press = 1; press <= controls; press += 1) {
      await page.keyboard.press('Shift+Tab');
      await recordStep(page, walk);
    }
    const end = await read(page);
    walk.scrollTop = start.scrollTop - end.scrollTop;
    return walk;
  }

  /** Whether anything in the band sticks: the band itself, or its marked part. */
  function anythingSticks(page: Page): Promise<boolean> {
    return page.evaluate(() => {
      const band = document.querySelector<HTMLElement>('[data-page-pinned]');
      const part = band?.querySelector<HTMLElement>('[data-page-pinned-sticky]') ?? null;
      return [band, part].some(
        (element) => element !== null && getComputedStyle(element).position === 'sticky'
      );
    });
  }

  /** Counts the focused control, if it is a content control, and whether anything sticks over it. */
  async function tallyFocus(
    page: Page,
    tally: { focused: number; underSomething: number }
  ): Promise<void> {
    if ((await clearance(page)) === null) return;
    tally.focused += 1;
    if (await anythingSticks(page)) tally.underSomething += 1;
  }

  /**
   * Walks the page's controls by keyboard, forward from the top or back from the last, and
   * counts the content controls focused and those focused while anything in the band sticks.
   */
  async function walkForStickiness(
    page: Page,
    direction: 'forward' | 'back'
  ): Promise<{ focused: number; underSomething: number }> {
    const back = direction === 'back';
    const presses = back ? await page.evaluate(() => __pageBody?.focusLast() ?? 0) : TAB_PRESSES;
    const tally = { focused: 0, underSomething: 0 };
    if (back) await tallyFocus(page, tally);
    for (let press = back ? 1 : 0; press < presses; press += 1) {
      await page.keyboard.press(back ? 'Shift+Tab' : 'Tab');
      await tallyFocus(page, tally);
    }
    return tally;
  }

  /** The marked part's computed position and its share of the scroller's height. */
  function readPart(page: Page): Promise<{ position: string; share: number }> {
    return page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('[data-page-scroller]');
      const part = scroller?.querySelector<HTMLElement>('[data-page-pinned-sticky]');
      if (!scroller || !part) throw new Error('the page has no marked part');
      return {
        position: getComputedStyle(part).position,
        share: part.offsetHeight / scroller.clientHeight,
      };
    });
  }

  function setScale(page: Page, scale: string | null): Promise<void> {
    return page.evaluate((next) => {
      __pageBody?.setScale(next);
    }, scale);
  }

  function waitForPosition(page: Page, position: string): Promise<unknown> {
    return page.waitForFunction((expected) => __pageBody?.read().position === expected, position, {
      timeout: SETTLE_MS,
    });
  }

  describe.each(ENGINES)('in %s', (engine) => {
    it.each(BAND_CASES)(
      'reproduces the measured band share at $label',
      async (bandCase) => {
        const [before] = await withPage(engine, bandCase, readBeforeAndAfterScroll);
        const share = before.bandHeight / before.scrollerHeight;
        expect(share).toBeGreaterThanOrEqual(bandCase.share.min);
        expect(share).toBeLessThanOrEqual(bandCase.share.max);
      },
      TEST_MS
    );

    it.each(BAND_CASES.filter((bandCase) => bandCase.pinned))(
      'keeps the band at the scroller top as the page scrolls at $label',
      async (bandCase) => {
        const [, after] = await withPage(engine, bandCase, readBeforeAndAfterScroll);
        expect(after.position).toBe('sticky');
        expect(Math.abs(after.top)).toBeLessThanOrEqual(EDGE_TOLERANCE_PX);
      },
      TEST_MS
    );

    it.each(BAND_CASES.filter((bandCase) => !bandCase.pinned))(
      'scrolls the band with the page at $label',
      async (bandCase) => {
        const [before, after] = await withPage(engine, bandCase, readBeforeAndAfterScroll);
        expect(after.position).toBe('static');
        expect(Math.abs(after.top - (before.top - SCROLL_PX))).toBeLessThanOrEqual(
          EDGE_TOLERANCE_PX
        );
      },
      TEST_MS
    );

    it.each(PHONE_CASES)(
      'keeps the part that fits stuck at the scroller top at $label',
      async (phoneCase) => {
        const part = await withPage(engine, phoneCase, readPart);
        expect(part.share).toBeLessThanOrEqual(MAX_PINNED_SHARE);
        expect(part.position).toBe('sticky');
      },
      TEST_MS
    );

    it.each(LANDSCAPE_CASES)(
      'lets a part taller than 70% of the scroller scroll with the page at $label',
      async (landscapeCase) => {
        const part = await withPage(engine, landscapeCase, readPart);
        expect(part.share).toBeGreaterThan(MAX_PINNED_SHARE);
        expect(part.position).toBe('static');
      },
      TEST_MS
    );

    it.each(LANDSCAPE_CASES)(
      'focuses every control with nothing stuck over the page, both ways, at $label',
      async (landscapeCase) => {
        const walks = await withPage(engine, landscapeCase, async (page) => {
          const forward = await walkForStickiness(page, 'forward');
          const back = await walkForStickiness(page, 'back');
          return { forward, back };
        });
        expect(walks.forward.focused).toBeGreaterThan(0);
        expect(walks.back.focused).toBeGreaterThan(0);
        expect(walks.forward.underSomething).toBe(0);
        expect(walks.back.underSomething).toBe(0);
      },
      TEST_MS
    );

    it(
      'never focuses inside the preview on a keyboard walk either way at the widget extremes',
      async () => {
        const walks = await withPage(engine, EXTREME_CASE, async (page) => {
          const forward = await walkForPreviewFocus(page, 'forward');
          const back = await walkForPreviewFocus(page, 'back');
          return { forward, back };
        });
        expect(walks.forward.focused).toBeGreaterThan(0);
        expect(walks.back.focused).toBeGreaterThan(0);
        expect(walks.forward.insidePreview).toBe(0);
        expect(walks.back.insidePreview).toBe(0);
      },
      TEST_MS
    );

    it.each([EXTREME_CASE, ...PREVIEW_CASES])(
      "draws the preview's link as text in the link's styling below 768 at $label",
      async (phoneCase) => {
        const link = await withPage(engine, phoneCase, readPreviewLink);
        expect(link.tag).not.toBe('A');
        expect(link.tabbable).toBe(false);
        expect(link.decoration).toContain('underline');
        expect(link.classes).toEqual(expect.arrayContaining(['text-brand-red', 'underline']));
      },
      TEST_MS
    );

    it(
      "keeps the preview's link a link a Tab walk reaches from 768",
      async () => {
        const reached = await withPage(engine, DESKTOP_PREVIEW_CASE, async (page) => {
          const link = await readPreviewLink(page);
          let focused = false;
          for (let press = 0; press < TAB_PRESSES && !focused; press += 1) {
            await page.keyboard.press('Tab');
            focused = await page.evaluate(
              () => document.activeElement?.textContent === 'hydration guide'
            );
          }
          return { tag: link.tag, focused };
        });
        expect(reached.tag).toBe('A');
        expect(reached.focused).toBe(true);
      },
      TEST_MS
    );

    it.each(FOCUS_CASES)(
      'keeps every control a Tab walk focuses clear of what sticks at $label',
      async (focusCase) => {
        const walk = await withPage(engine, focusCase, walkFocus);
        expect(walk.clearances.length).toBeGreaterThan(0);
        expect(walk.scrollTop).toBeGreaterThan(0);
        for (const reading of walk.clearances) {
          expect(reading).toBeGreaterThanOrEqual(-EDGE_TOLERANCE_PX);
        }
        expect(walk.cutOff).toEqual([]);
        expect(walk.frameShift).toBe(0);
      },
      TEST_MS
    );

    it.each(FOCUS_CASES)(
      'keeps every control a Shift+Tab walk back focuses clear of what sticks at $label',
      async (focusCase) => {
        const walk = await withPage(engine, focusCase, walkBack);
        expect(walk.clearances.length).toBeGreaterThan(0);
        expect(walk.scrollTop).toBeGreaterThan(0);
        for (const reading of walk.clearances) {
          expect(reading).toBeGreaterThanOrEqual(-EDGE_TOLERANCE_PX);
        }
        expect(walk.cutOff).toEqual([]);
        expect(walk.frameShift).toBe(0);
      },
      TEST_MS
    );

    it(
      'leaves the page where it is when a pointer focuses a card partly under the pinned band',
      async () => {
        const pinnedCase = FOCUS_CASES[0];
        if (pinnedCase === undefined) throw new Error('no pinned case');
        const result = await withPage(engine, pinnedCase, async (page) => {
          const target = await page.evaluate(placeCardUnderBand, {
            under: UNDER_BAND_PX,
            above: CLICK_ABOVE_BOTTOM_PX,
          });
          await page.mouse.click(target.x, target.y);
          await page.waitForTimeout(POINTER_SETTLE_MS);
          const after = await read(page);
          const focusedInContent = await page.evaluate(
            () => __pageBody?.focusAgainstBand() !== null
          );
          return { before: target.scrollTop, after: after.scrollTop, focusedInContent };
        });
        expect(result.focusedInContent).toBe(true);
        expect(result.after).toBe(result.before);
      },
      TEST_MS
    );

    it(
      'unpins the band when the largest text is set on the open page',
      async () => {
        const position = await withPage(engine, LIVE_CASE, async (page) => {
          await setScale(page, LARGEST_TEXT);
          await waitForPosition(page, 'static');
          const reading = await read(page);
          return reading.position;
        });
        expect(position).toBe('static');
      },
      TEST_MS
    );

    it(
      'pins the band again when the largest text is cleared on the open page',
      async () => {
        const position = await withPage(
          engine,
          { ...LIVE_CASE, scale: LARGEST_TEXT },
          async (page) => {
            await setScale(page, null);
            await waitForPosition(page, 'sticky');
            const reading = await read(page);
            return reading.position;
          }
        );
        expect(position).toBe('sticky');
      },
      TEST_MS
    );

    it(
      "settles the band's position before a later resize observer of the band reads it",
      async () => {
        const positions = await withPage(engine, LIVE_CASE, async (page) => {
          await setScale(page, LARGEST_TEXT);
          await waitForPosition(page, 'static');
          return page.evaluate(() => __pageBody?.laterObserverPositions ?? []);
        });
        expect(positions.at(-1)).toBe('static');
      },
      TEST_MS
    );
  });
});
