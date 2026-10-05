import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, firefox, type Browser, type Locator, type Page } from '@playwright/test';
import { LAYOUT } from '@hushbox/shared/design-tokens';
import { startFixtureServer, type FixtureServer } from '@/test-utils/fixture-server';

/**
 * Lays a media turn's composer out in real engines.
 *
 * - Where its estimate lands: beside the model chip with "(estimate)" under the figure on a
 *   composer 34rem or wider, and on one line above the field below that. The composer renders
 *   the estimate twice and shows one copy by its own width, a container query no test DOM
 *   evaluates, so which copy a reader sees, and that a locator picking by visibility finds
 *   exactly that one, are read here.
 * - The video settings sheet on a small phone at the largest text size, taller than the screen:
 *   that only the sheet's own body scrolls, so no inner edge parts a heading from its control,
 *   and that each control a Tab reaches comes fully into view with its ring at full strength.
 *
 * The page mounts the real `PromptInput` under the app stylesheet with the turn's model chosen
 * in the real store. The reads that reach the network (the catalog, the funding verdict, the
 * payer's reach, the app's stability and the notice stack under the composer) are virtual stub
 * modules, so no fixture file joins the tree. Chromium and Firefox, the engines CI installs,
 * driven by `@playwright/test` over a private dev server.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, '../../../..');
const SRC_DIR = path.join(WEB_DIR, 'src');
const PROMPT_INPUT_FILE = path.join(HERE, 'prompt-input.tsx');
const STORE_FILE = path.join(SRC_DIR, 'stores', 'model.ts');

const ENTRY_ID = 'virtual:composer-media-entry';

/** Each module the composer reads over the network, and the stand-in served in its place. */
const STUBS: Readonly<Record<string, string>> = {
  '@/hooks/models/models': `
const image = {
  id: 'fictional/image', name: 'Fictional Image', provider: 'Fictional', description: 'Image model.',
  modality: 'image', contextLength: 0, supportedParameters: [], supportedAspectRatios: ['1:1', '16:9'],
  pricing: { perImage: '46000000', dearestPerImage: '46000000' },
};
const video = {
  id: 'fictional/video', name: 'Fictional Video', provider: 'Fictional', description: 'Video model.',
  modality: 'video', contextLength: 0, supportedParameters: [], supportedAspectRatios: ['16:9', '9:16'],
  supportedVideoResolutions: ['720p', '1080p'], supportedVideoDurationsSeconds: [4, 6, 8],
  pricing: {
    perSecondByResolution: { '720p': '100000000', '1080p': '150000000' },
    dearestPerSecondByResolution: { '720p': '100000000', '1080p': '150000000' },
  },
};
export function useModels() {
  return { data: { models: [image, video], premiumIds: new Set() } };
}`,
  '@/hooks/billing/use-prompt-budget': `
export function usePromptBudget() {
  return {
    fundingSource: 'personal_balance', notifications: [], notices: [], payerSwitch: undefined,
    capacityPercent: 0, capacityBand: 'room_to_spare', capacityCurrentUsage: 0, capacityMaxCapacity: 0,
    estimatedCostNanoUsd: undefined, isOverCapacity: false, hasBlockingError: false,
    hasPersistentBlockingError: false, sendRefusal: undefined, isBillingLoading: false, hasContent: true,
    isAffordabilitySettled: true, maxOutputTokens: 0, estimatedInputTokens: 0, mediaOptions: undefined,
    effortDimension: undefined,
  };
}`,
  '@/hooks/models/use-payer-premium-access': `
export function usePayerPremiumAccess() {
  return { status: 'known', canAccessPremium: true };
}`,
  '@/providers/stability-provider': `
export function useStability() {
  return { isAuthStable: true, isBalanceStable: true, isAppStable: true };
}`,
  '@/components/chat/budget/composer-messages': `
export function ComposerMessages() {
  return null;
}`,
};

/**
 * The app's source alias for every specifier but the stubbed ones, which Vite's alias stage
 * would otherwise rewrite to a file path before the page's own resolver sees them.
 */
const UNSTUBBED_SOURCE = new RegExp(
  `^@/(?!(?:${Object.keys(STUBS)
    .map((specifier) => specifier.slice('@/'.length))
    .join('|')})$)(.*)$`,
  'u'
);

/** The virtual id a stubbed specifier resolves to. */
function stubId(specifier: string): string {
  return `\0virtual:composer-media-stub:${specifier}`;
}

const PAGE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>composer media</title></head>
  <body>
    <div id="root"></div>
    <script type="module" src="/@id/${ENTRY_ID}"></script>
  </body>
</html>`;

const ENTRY_SOURCE = `
import { StrictMode, createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@/app.css';
import { useModelStore } from ${JSON.stringify(STORE_FILE)};
import { PromptInput } from ${JSON.stringify(PROMPT_INPUT_FILE)};

const params = new URLSearchParams(location.search);
const modality = params.get('modality');
const width = params.get('width');

useModelStore.setState({
  activeModality: modality,
  imageConfig: { aspectRatio: '1:1' },
  videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
  selections: {
    text: [],
    image: [{ id: 'fictional/image', name: 'Fictional Image' }],
    audio: [],
    video: [{ id: 'fictional/video', name: 'Fictional Video' }],
  },
});

function Composer() {
  const [value, setValue] = useState('A watercolour map of a hill town at dusk');
  return h(PromptInput, {
    value, onChange: setValue, onSubmit: () => undefined, isAuthenticated: true,
    activeModality: modality, onSelectModality: () => undefined,
    modelControl: h('button', { type: 'button', id: 'model-chip', className: 'h-8 px-2.5' }, 'Fictional'),
  });
}

createRoot(document.getElementById('root')).render(h(StrictMode, null,
  h('main', { style: { padding: '64px 16px' } },
    h('div', { style: width === null ? {} : { width: width + 'rem' } }, h(Composer)))));
globalThis.__composerMediaReady = true;
`;

function pageModules(): Plugin {
  return {
    name: 'composer-media-page',
    enforce: 'pre',
    resolveId(id) {
      if (id === ENTRY_ID) return `\0${ENTRY_ID}`;
      return id in STUBS ? stubId(id) : undefined;
    },
    load(id) {
      if (id === `\0${ENTRY_ID}`) return ENTRY_SOURCE;
      const stubbed = Object.keys(STUBS).find((specifier) => stubId(specifier) === id);
      return stubbed === undefined ? undefined : STUBS[stubbed];
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = request.url;
        if (!url?.startsWith('/composer-media.html')) {
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
  var __composerMediaReady: boolean | undefined;
}

/** The first load compiles the app's whole stylesheet, which a busy machine can make slow. */
const LOAD_MS = 90_000;
const TEST_MS = LOAD_MS + 30_000;

/** The composer width below which the bar gives the estimate up, in rem. */
const COMPACT_REM = Number.parseFloat(LAYOUT.containers['composer-compact']);
/** A composer comfortably wider and comfortably narrower than that step. */
const WIDE_REM = COMPACT_REM + 6;
const NARROW_REM = COMPACT_REM - 4;
/** Layout boxes compared across two elements round differently per engine; this much is rounding. */
const SUBPIXEL_PX = 1;

const FIGURE_PATTERN = /^≈\s+\$\d+\.\d{3}$/u;

interface EstimateReading {
  /** How many copies of the figure the composer renders, shown or not. */
  readonly copies: number;
  /** How many of them a reader can see. */
  readonly shown: number;
  /** Where the shown copy sits: in the control bar, or on the line above the field. */
  readonly place: 'bar' | 'above';
  /** Whether the caption sits under the figure (true) or on its line (false). */
  readonly captionUnder: boolean;
  /** The shown copy's left less the model chip's right. */
  readonly afterModel: number;
  /** Whether the shown copy and the model chip share a row. */
  readonly besideModel: boolean;
  /** The shown copy's bottom less the field's top. */
  readonly aboveField: number;
  /** How many copies a locator that filters by visibility finds. */
  readonly visibleMatches: number;
}

async function readEstimate(
  page: Page,
  origin: string,
  modality: 'image' | 'video',
  widthRem: number
): Promise<EstimateReading> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${origin}/composer-media.html?modality=${modality}&width=${String(widthRem)}`, {
    waitUntil: 'commit',
    timeout: LOAD_MS,
  });
  await page.waitForFunction(() => globalThis.__composerMediaReady === true, undefined, {
    timeout: LOAD_MS,
  });
  const composer = page.locator('[data-slot="composer"]');
  await composer.getByText(FIGURE_PATTERN).first().waitFor({ state: 'attached', timeout: LOAD_MS });
  await page.evaluate(() => document.fonts.ready);
  const visibleMatches = await composer.getByText(FIGURE_PATTERN).filter({ visible: true }).count();

  const geometry = await page.evaluate((patternSource) => {
    const pattern = new RegExp(patternSource, 'u');
    const root = document.querySelector('[data-slot="composer"]');
    const field = document.querySelector('[data-slot="composer-field"]');
    const model = document.querySelector('#model-chip');
    if (root === null || field === null || model === null) throw new TypeError('no composer');
    const figures = [...root.querySelectorAll('span')].filter((span) =>
      pattern.test(span.textContent)
    );
    const shown = figures.filter((figure) => figure.getClientRects().length > 0);
    const figure = shown[0];
    // A reading with no copy shown fails here, by name, rather than as a later mismatch.
    if (figure === undefined) throw new TypeError('no estimate is shown');
    const caption = figure.nextElementSibling;
    const line = figure.parentElement;
    if (caption === null || line === null) throw new TypeError('the estimate has no caption');
    const figureBox = figure.getBoundingClientRect();
    const captionBox = caption.getBoundingClientRect();
    const lineBox = line.getBoundingClientRect();
    const modelBox = model.getBoundingClientRect();
    return {
      copies: figures.length,
      shown: shown.length,
      place:
        line.closest('[data-slot="composer-bar"]') === null ? ('above' as const) : ('bar' as const),
      captionUnder: captionBox.top >= figureBox.bottom - 1,
      afterModel: lineBox.left - modelBox.right,
      besideModel: lineBox.top < modelBox.bottom && lineBox.bottom > modelBox.top,
      aboveField: lineBox.bottom - field.getBoundingClientRect().top,
    };
  }, FIGURE_PATTERN.source);
  return { ...geometry, visibleMatches };
}

/** A small phone, and the accessibility widget's largest text step. */
const SMALL_PHONE = { width: 320, height: 640 } as const;
const LARGEST_TEXT_CLASS = 'a11y-font-scale-141';
/** The duration slider's tick buttons, which name themselves "Set duration to N seconds". */
const TICK_NAME_PREFIX = 'Set duration to';
/**
 * A control's focus ring at half its colour's alpha, as `ring-ring/50` draws one, applied to the
 * duration slider to show the full-strength reading tells the two apart.
 */
const HALF_ALPHA_RING_STYLE = `input[type="range"]:focus-visible {
  outline-color: color-mix(in srgb, currentColor 50%, transparent) !important;
  box-shadow: 0 0 0 2px color-mix(in srgb, currentColor 50%, transparent) !important;
}`;
/** How many Tab presses the walk may take before it gives up looking for the way round. */
const TAB_LIMIT = 30;

/** Opens the video settings as a phone sheet at the largest text step. */
async function openVideoSheet(page: Page, origin: string): Promise<Locator> {
  await page.setViewportSize(SMALL_PHONE);
  await page.goto(`${origin}/composer-media.html?modality=video`, {
    waitUntil: 'commit',
    timeout: LOAD_MS,
  });
  await page.waitForFunction(() => globalThis.__composerMediaReady === true, undefined, {
    timeout: LOAD_MS,
  });
  await page.evaluate((name) => {
    document.documentElement.classList.add(name);
  }, LARGEST_TEXT_CLASS);
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole('button', { name: /^Video settings:/u }).click({ timeout: LOAD_MS });
  const sheet = page.getByRole('dialog', { name: 'Video settings' });
  await sheet.getByRole('slider').waitFor({ timeout: LOAD_MS });
  await sheet.evaluate((dialog) =>
    Promise.all(dialog.getAnimations({ subtree: true }).map((animation) => animation.finished))
  );
  return sheet;
}

interface SheetLayoutReading {
  /** The root font size the sheet was laid out under, in px. */
  readonly rootPx: number;
  /** Each axis heading's text, beside whether the box that clips it is the sheet's own body. */
  readonly headings: readonly { readonly text: string; readonly clippedBySheet: boolean }[];
}

/**
 * Reads, for each axis heading, the nearest box that scrolls around it: the sheet's own body,
 * which also holds its close, or a box inside it whose edge could part the heading from its
 * control.
 */
async function readSheetLayout(sheet: Locator): Promise<SheetLayoutReading> {
  return sheet.evaluate((dialog) => {
    const close = dialog.querySelector('[data-slot="overlay-close"]');
    if (close === null) throw new TypeError('no sheet close');
    function scroller(from: Element): Element | null {
      for (let node = from.parentElement; node !== null; node = node.parentElement) {
        const overflow = getComputedStyle(node).overflowY;
        const scrolls = overflow === 'auto' || overflow === 'scroll';
        if (scrolls && node.scrollHeight > node.clientHeight + 1) return node;
      }
      return null;
    }
    const headings = [...dialog.querySelectorAll('section > h3')].map((heading) => ({
      text: heading.textContent,
      clippedBySheet: scroller(heading)?.contains(close) === true,
    }));
    return {
      rootPx: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
      headings,
    };
  });
}

interface FocusStop {
  /** The focused control's accessible name, or its tag where it has none. */
  readonly name: string;
  /** Whether the control and its focus ring lie inside every box that clips it and the screen. */
  readonly inView: boolean;
  /** The first element, itself or above it, that masks it or lowers its opacity, or `null`. */
  readonly dimmedBy: string | null;
  /** Whether it draws a focus ring at all. */
  readonly ringDrawn: boolean;
  /** The drawn ring colour's alpha, 0 to 1; a ring with no colour of its own reads 0. */
  readonly ringAlpha: number;
}

/** Tabs through the open sheet and reads each video control the focus lands on. */
async function tabThroughSheet(page: Page, sheet: Locator): Promise<readonly FocusStop[]> {
  const stops: FocusStop[] = [];
  const seen = new Set<string>();
  for (let press = 0; press < TAB_LIMIT; press += 1) {
    await page.keyboard.press('Tab');
    const stop = await sheet.evaluate((dialog) => {
      /** How far the focus ring reaches past the control's border box. */
      function ringReach(style: CSSStyleDeclaration): number {
        if (style.outlineStyle === 'none') return 0;
        const offset = Number.parseFloat(style.outlineOffset) || 0;
        return (Number.parseFloat(style.outlineWidth) || 0) + Math.max(0, offset);
      }
      function drawsRing(style: CSSStyleDeclaration): boolean {
        const outline = style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0;
        return outline || style.boxShadow !== 'none';
      }
      /** A CSS colour's alpha, 0 to 1, read back from a pixel painted in it. */
      function alphaOf(color: string): number {
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        const context = canvas.getContext('2d');
        if (context === null) throw new TypeError('no 2d canvas');
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        return (context.getImageData(0, 0, 1, 1).data[3] ?? 0) / 255;
      }
      /**
       * The drawn ring's colour alpha: the outline's, or else the strongest box-shadow layer
       * that spreads past the box, which is how a `ring-*` utility draws.
       */
      function ringAlpha(style: CSSStyleDeclaration): number {
        if (style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0) {
          return alphaOf(style.outlineColor);
        }
        if (style.boxShadow === 'none') return 0;
        const layers = style.boxShadow.split(/,(?![^(]*\))/u);
        const spread = layers.filter((layer) => /\s[1-9][\d.]*px\s*$/u.test(layer.trim()));
        const colors = spread.map((layer) => layer.trim().replace(/(\s-?[\d.]+px)+$/u, ''));
        return Math.max(0, ...colors.map((color) => alphaOf(color)));
      }
      /** Whether the box reaches past the screen or past any box above it that clips. */
      function clipped(focused: Element, reach: DOMRect): boolean {
        const pastScreen =
          reach.top < -0.5 ||
          reach.left < -0.5 ||
          reach.bottom > innerHeight + 0.5 ||
          reach.right > innerWidth + 0.5;
        if (pastScreen) return true;
        for (let node = focused.parentElement; node !== null; node = node.parentElement) {
          if (getComputedStyle(node).overflowY === 'visible') continue;
          const clip = node.getBoundingClientRect();
          if (reach.top < clip.top - 0.5 || reach.bottom > clip.bottom + 0.5) return true;
        }
        return false;
      }
      /** The first element, the control or above it, that masks it or lowers its opacity. */
      function dimmer(focused: Element): string | null {
        for (let node: Element | null = focused; node !== null; node = node.parentElement) {
          const style = getComputedStyle(node);
          const mask = style.maskImage || style.getPropertyValue('-webkit-mask-image');
          const masked = mask !== '' && mask !== 'none';
          if (masked || Number.parseFloat(style.opacity) < 1) {
            return `${node.tagName.toLowerCase()}.${node.getAttribute('class') ?? ''} opacity ${style.opacity} mask ${mask}`;
          }
        }
        return null;
      }

      const focused = document.activeElement;
      if (!(focused instanceof HTMLElement) || !dialog.contains(focused)) return null;
      if (focused.closest('section') === null) return { key: focused.outerHTML, reading: null };
      const style = getComputedStyle(focused);
      const ring = ringReach(style);
      const box = focused.getBoundingClientRect();
      const reach = new DOMRect(
        box.x - ring,
        box.y - ring,
        box.width + 2 * ring,
        box.height + 2 * ring
      );
      return {
        key: focused.outerHTML,
        reading: {
          name: focused.getAttribute('aria-label') ?? focused.textContent,
          inView: !clipped(focused, reach),
          dimmedBy: dimmer(focused),
          ringDrawn: drawsRing(style),
          ringAlpha: Math.round(ringAlpha(style) * 100) / 100,
        },
      };
    });
    if (stop === null) continue;
    if (seen.has(stop.key)) break;
    seen.add(stop.key);
    if (stop.reading !== null) stops.push(stop.reading);
  }
  return stops;
}

type EngineName = 'chromium' | 'firefox';
const ENGINES: readonly EngineName[] = ['chromium', 'firefox'];
const MODALITIES = ['image', 'video'] as const;

describe('the media composer (real browser)', () => {
  let server: FixtureServer;
  const browsers: Partial<Record<EngineName, Browser>> = {};

  beforeAll(async () => {
    server = await startFixtureServer({
      root: WEB_DIR,
      configFile: false,
      plugins: [pageModules(), react(), tailwindcss()],
      resolve: {
        alias: [{ find: UNSTUBBED_SOURCE, replacement: path.join(SRC_DIR, '$1') }],
      },
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
    modality: 'image' | 'video',
    widthRem: number
  ): Promise<EstimateReading> {
    const browser = browsers[engine];
    if (browser === undefined) throw new Error(`${engine} did not launch`);
    const page = await browser.newPage();
    try {
      return await readEstimate(page, server.url, modality, widthRem);
    } finally {
      await page.close();
    }
  }

  describe.each(ENGINES)('on %s', (engine) => {
    /** Runs one reading on a fresh page of this engine. */
    async function onPage<T>(read: (page: Page) => Promise<T>): Promise<T> {
      const browser = browsers[engine];
      if (browser === undefined) throw new Error(`${engine} did not launch`);
      const page = await browser.newPage();
      try {
        return await read(page);
      } finally {
        await page.close();
      }
    }

    it(
      'shows no axis heading without its control on a small phone at the largest text, but where the sheet itself scrolls',
      async () => {
        const reading = await onPage(async (page) =>
          readSheetLayout(await openVideoSheet(page, server.url))
        );

        expect(reading.rootPx).toBe(24);
        expect(reading.headings.map((heading) => heading.text)).toEqual([
          'Aspect ratio',
          'Resolution',
          'Duration',
        ]);
        for (const heading of reading.headings)
          expect(heading).toMatchObject({ clippedBySheet: true });
      },
      TEST_MS
    );

    it(
      'brings each video control a Tab reaches fully into view, its ring at full strength, on a small phone at the largest text',
      async () => {
        const stops = await onPage(async (page) =>
          tabThroughSheet(page, await openVideoSheet(page, server.url))
        );

        expect(stops.map((stop) => stop.name)).toEqual(
          expect.arrayContaining(['16:9', '9:16', '720p', '1080p', 'Video duration in seconds'])
        );
        // The duration ticks are `DurationSnapSlider`'s own buttons, whose focus treatment
        // that module decides; this case holds the controls the settings render around them.
        const composerControls = stops.filter((stop) => !stop.name.startsWith(TICK_NAME_PREFIX));
        for (const stop of composerControls) {
          expect(stop).toMatchObject({
            inView: true,
            dimmedBy: null,
            ringDrawn: true,
            ringAlpha: 1,
          });
        }
      },
      TEST_MS
    );

    it(
      'reads a half-strength ring as weaker than full, so the full-strength case can fail',
      async () => {
        const stops = await onPage(async (page) => {
          const sheet = await openVideoSheet(page, server.url);
          await page.addStyleTag({ content: HALF_ALPHA_RING_STYLE });
          return tabThroughSheet(page, sheet);
        });

        const slider = stops.find((stop) => stop.name === 'Video duration in seconds');
        expect(slider?.ringDrawn).toBe(true);
        expect(slider?.ringAlpha).toBeGreaterThan(0.4);
        expect(slider?.ringAlpha).toBeLessThan(0.6);
      },
      TEST_MS
    );

    describe.each(MODALITIES)('for a %s turn', (modality) => {
      it(
        'sits beside the model chip, its caption under the figure, on a wide composer',
        async () => {
          const reading = await readOn(engine, modality, WIDE_REM);

          expect(reading.copies).toBe(2);
          expect(reading.shown).toBe(1);
          expect(reading.place).toBe('bar');
          expect(reading.besideModel).toBe(true);
          expect(reading.afterModel).toBeGreaterThanOrEqual(-SUBPIXEL_PX);
          expect(reading.captionUnder).toBe(true);
        },
        TEST_MS
      );

      it(
        'rides one line above the field on a composer under the compact step',
        async () => {
          const reading = await readOn(engine, modality, NARROW_REM);

          expect(reading.copies).toBe(2);
          expect(reading.shown).toBe(1);
          expect(reading.place).toBe('above');
          expect(reading.aboveField).toBeLessThanOrEqual(SUBPIXEL_PX);
          expect(reading.captionUnder).toBe(false);
        },
        TEST_MS
      );

      it.each([
        ['wide', WIDE_REM],
        ['narrow', NARROW_REM],
      ])(
        'is found once by a locator that picks the copy a reader sees, on a %s composer',
        async (_label, widthRem) => {
          const reading = await readOn(engine, modality, widthRem);

          expect(reading.visibleMatches).toBe(1);
        },
        TEST_MS
      );
    });
  });
});
