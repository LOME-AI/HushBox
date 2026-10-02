import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, firefox, type Browser, type Page } from '@playwright/test';

/**
 * Measures the context gauge where it sits, on the composer's top border, in real
 * engines: its fit is a matter of the composer's container width and the page's
 * root size, and its focus tab and touch area are pseudo-elements, none of which
 * the DOM the app's other tests run in lays out.
 *
 * It drives the composer bar's fixture (`composer-bar-fixture/`), which mounts the
 * real `PromptInput` in a phone column's 1rem gutters with its data hooks stubbed:
 * a text turn 12% into its window, so the gauge draws. The page global it mounts
 * through, `__composerBar`, is typed by that fixture's entry.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, 'composer-bar-fixture');
const SRC_DIR = path.resolve(HERE, '../../..');

/** The first load compiles the app's whole stylesheet, which a busy machine can make slow. */
const FIXTURE_LOAD_MS = 90_000;
const TEST_MS = FIXTURE_LOAD_MS + 30_000;

type EngineName = 'chromium' | 'firefox';
const ENGINES: readonly EngineName[] = ['chromium', 'firefox'];

/** The phone widths the gauge must fit at twice the root size. */
const PHONE_WIDTHS = [320, 360, 375, 390, 414, 430] as const;

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
}

/** The gauge's own background while the pointer rests on it. */
interface HoverReading {
  image: string;
  color: string;
}

interface GaugeReading {
  rootPx: number;
  composer: Box;
  field: Box;
  gauge: Box;
  bar: Box;
  textarea: Box;
  /** Whether the label or the value shows less text than it holds. */
  textClipped: boolean;
  /** What a pointer lands on 4px below the gauge's lower edge, at its centre. */
  belowHit: string;
  /** What a pointer lands on 4px above the gauge's top edge, at its centre. */
  aboveHit: string;
  /** The focus tab's display and top-border colour. */
  tab: { display: string; color: string };
}

const STUBS: readonly (readonly [string, string])[] = [
  ['@/hooks/billing/use-prompt-budget', 'prompt-budget-stub.ts'],
  ['@/hooks/models/use-payer-premium-access', 'payer-premium-access-stub.ts'],
  ['@/hooks/chat/use-reasoning-effort', 'reasoning-effort-stub.ts'],
  ['@/providers/stability-provider', 'stability-stub.ts'],
  ['@/components/chat/budget/composer-messages', 'composer-messages-stub.ts'],
];

function escapeForPattern(specifier: string): string {
  return specifier.replaceAll(/[.*+?^${}()|[\]\\/]/g, String.raw`\$&`);
}

async function startFixtureServer(): Promise<{ origin: string; close: () => Promise<void> }> {
  // A private dependency cache in the OS temp directory: the app's own `node_modules/.vite`
  // is the one the running dev server serves from, and optimising into it under that
  // server leaves it answering 504 for every module it had.
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'context-gauge-vite-'));
  const server: ViteDevServer = await createServer({
    root: FIXTURE_DIR,
    cacheDir,
    logLevel: 'error',
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: [
        ...STUBS.map(([specifier, stub]) => ({
          find: new RegExp(`^${escapeForPattern(specifier)}$`),
          replacement: path.join(FIXTURE_DIR, stub),
        })),
        { find: /^@\/(.*)$/, replacement: path.join(SRC_DIR, '$1') },
      ],
    },
    // hmr disabled: every reading here is one-shot — nothing needs a live-reload push.
    server: { port: 0, host: '127.0.0.1', hmr: false },
  });
  try {
    await server.listen();
  } catch (error) {
    await server.close();
    await rm(cacheDir, { recursive: true, force: true });
    throw error;
  }
  const address = server.httpServer?.address();
  if (address === null || address === undefined || typeof address === 'string') {
    await server.close();
    await rm(cacheDir, { recursive: true, force: true });
    throw new Error('context gauge fixture server has no port');
  }
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    close: async () => {
      try {
        await server.close();
      } finally {
        await rm(cacheDir, { recursive: true, force: true });
      }
    },
  };
}

interface PageSetup {
  width: number;
  /** Twice the page's root size, as 200% browser text gives. */
  doubledRoot?: boolean;
  dark?: boolean;
}

async function openComposer(browser: Browser, origin: string, setup: PageSetup): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: setup.width, height: 900 } });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${origin}/composer-bar.html`, { waitUntil: 'commit', timeout: FIXTURE_LOAD_MS });
  await page
    .waitForFunction(() => globalThis.__composerBar !== undefined, undefined, {
      timeout: FIXTURE_LOAD_MS,
    })
    .catch((error: unknown) => {
      throw new Error(`the fixture never loaded; page errors: ${pageErrors.join(' | ')}`, {
        cause: error,
      });
    });
  await page.evaluate(
    ({ doubled, dark }) => {
      if (doubled) document.documentElement.style.fontSize = '200%';
      document.documentElement.classList.toggle('dark', dark);
      if (globalThis.__composerBar === undefined) throw new Error('__composerBar not ready');
      globalThis.__composerBar.mountComposer({ effort: true, modality: 'text' });
    },
    { doubled: setup.doubledRoot === true, dark: setup.dark === true }
  );
  return page;
}

/** Switches the page to a coarse pointer, as a phone's touchscreen reports. Chromium only. */
async function useCoarsePointer(page: Page): Promise<void> {
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setEmitTouchEventsForMouse', {
    enabled: true,
    configuration: 'mobile',
  });
  await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
}

async function readHover(page: Page): Promise<HoverReading> {
  await page.hover('[role="meter"]');
  return page.evaluate(() => {
    const gauge = document.querySelector('[role="meter"]');
    if (gauge === null) throw new Error('the fixture has no gauge');
    const style = getComputedStyle(gauge);
    return { image: style.backgroundImage, color: style.backgroundColor };
  });
}

async function readGauge(page: Page): Promise<GaugeReading> {
  return page.evaluate(() => {
    function boxOf(element: Element): Box {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
      };
    }
    function requireElement(selector: string): HTMLElement {
      const element = document.querySelector<HTMLElement>(selector);
      if (element === null) throw new Error(`the fixture has no ${selector}`);
      return element;
    }
    function hitAt(x: number, y: number): string {
      const hit = document.elementFromPoint(x, y);
      if (hit === null) return 'nothing';
      if (hit.matches('textarea')) return 'textarea';
      if (hit.closest('[role="meter"]') !== null) return 'gauge';
      return hit.closest<HTMLElement>('[data-slot]')?.dataset['slot'] ?? hit.tagName.toLowerCase();
    }
    const gauge = requireElement('[role="meter"]');
    const texts = [
      requireElement('[data-slot="context-gauge-label"]'),
      requireElement('[data-slot="context-gauge-value"]'),
    ];
    const gaugeBox = boxOf(gauge);
    const centre = (gaugeBox.left + gaugeBox.right) / 2;
    const tab = getComputedStyle(gauge, '::after');
    return {
      rootPx: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
      composer: boxOf(requireElement('[data-slot="composer"]')),
      field: boxOf(requireElement('[data-slot="composer-field"]')),
      gauge: gaugeBox,
      bar: boxOf(requireElement('[data-slot="context-gauge-bar"]')),
      textarea: boxOf(requireElement('textarea')),
      textClipped: texts.some((text) => text.scrollWidth > text.clientWidth + 1),
      belowHit: hitAt(centre, gaugeBox.bottom + 4),
      aboveHit: hitAt(centre, gaugeBox.top - 4),
      tab: { display: tab.display, color: tab.borderTopColor },
    };
  });
}

describe('context gauge (real browser)', () => {
  let server: { origin: string; close: () => Promise<void> };
  const browsers: Partial<Record<EngineName, Browser>> = {};

  beforeAll(async () => {
    server = await startFixtureServer();
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

  async function withComposer<T>(
    engine: EngineName,
    setup: PageSetup,
    use: (page: Page) => Promise<T>
  ): Promise<T> {
    const browser = browsers[engine];
    if (browser === undefined) throw new Error(`${engine} did not launch`);
    const page = await openComposer(browser, server.origin, setup);
    try {
      return await use(page);
    } finally {
      await page.context().close();
    }
  }

  describe.each(ENGINES)('on %s', (engine) => {
    it(
      'sits on the top border at the right, 0.75rem in, at its full 4.5rem bar',
      async () => {
        await withComposer(engine, { width: 390 }, async (page) => {
          const reading = await readGauge(page);
          expect(reading.composer.right - reading.gauge.right).toBeCloseTo(
            0.75 * reading.rootPx,
            0
          );
          expect((reading.gauge.top + reading.gauge.bottom) / 2).toBeCloseTo(
            reading.composer.top,
            0
          );
          expect(reading.bar.width).toBeCloseTo(4.5 * reading.rootPx, 0);
        });
      },
      TEST_MS
    );

    it.each(PHONE_WIDTHS)(
      "lies inside the composer's box at %ipx with the root doubled",
      async (width) => {
        await withComposer(engine, { width, doubledRoot: true }, async (page) => {
          const reading = await readGauge(page);
          expect(reading.rootPx).toBe(32);
          expect(reading.gauge.left).toBeGreaterThanOrEqual(reading.composer.left - 0.5);
          expect(reading.gauge.right).toBeLessThanOrEqual(reading.composer.right + 0.5);
          expect(reading.textClipped).toBe(false);
        });
      },
      TEST_MS
    );

    it(
      'narrows its bar, not its words, to fit a 320 phone with the root doubled',
      async () => {
        await withComposer(engine, { width: 320, doubledRoot: true }, async (page) => {
          const reading = await readGauge(page);
          expect(reading.bar.width).toBeLessThan(4.5 * reading.rootPx);
          expect(reading.textClipped).toBe(false);
        });
      },
      TEST_MS
    );

    it(
      'costs the composer no height: the text box and its margin fill the old minimum',
      async () => {
        await withComposer(engine, { width: 1440 }, async (page) => {
          const reading = await readGauge(page);
          expect(reading.textarea.bottom - reading.field.top).toBeCloseTo(
            1 + 4 * reading.rootPx,
            0
          );
        });
      },
      TEST_MS
    );

    it.each([
      { theme: 'light', dark: false, accent: 'rgb(229, 226, 219)' },
      { theme: 'dark', dark: true, accent: 'rgb(45, 43, 40)' },
    ])(
      'tints the whole pill with the accent on hover in the $theme theme',
      async ({ dark, accent }) => {
        await withComposer(engine, { width: 390, dark }, async (page) => {
          const hover = await readHover(page);
          expect(hover.image).toBe('none');
          expect(hover.color).toBe(accent);
        });
      },
      TEST_MS
    );

    it(
      "starts the text's scroll area below its lower edge",
      async () => {
        await withComposer(engine, { width: 390 }, async (page) => {
          const reading = await readGauge(page);
          expect(reading.textarea.top).toBeGreaterThanOrEqual(reading.gauge.bottom - 0.5);
        });
      },
      TEST_MS
    );

    it(
      'lets a tap 4px inside the field below it focus the text box',
      async () => {
        await withComposer(engine, { width: 390 }, async (page) => {
          const reading = await readGauge(page);
          expect(reading.belowHit).toBe('textarea');
          await page.mouse.click(
            (reading.gauge.left + reading.gauge.right) / 2,
            reading.gauge.bottom + 4
          );
          expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA');
        });
      },
      TEST_MS
    );

    it(
      'raises no tab while the composer has no focus',
      async () => {
        await withComposer(engine, { width: 390 }, async (page) => {
          const { tab } = await readGauge(page);
          expect(tab.display).toBe('none');
        });
      },
      TEST_MS
    );

    it(
      'raises the Signal Red ring around it as a tab while the text box has focus',
      async () => {
        await withComposer(engine, { width: 390 }, async (page) => {
          await page.focus('textarea');
          const { tab } = await readGauge(page);
          expect(tab.display).toBe('block');
          expect(tab.color).toBe('rgb(236, 71, 85)');
        });
      },
      TEST_MS
    );
  });

  describe('on a coarse pointer (chromium)', () => {
    it(
      'grows its touch area upward',
      async () => {
        await withComposer('chromium', { width: 390 }, async (page) => {
          await useCoarsePointer(page);
          expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
          const { aboveHit } = await readGauge(page);
          expect(aboveHit).toBe('gauge');
        });
      },
      TEST_MS
    );

    it(
      'stops its touch area at its lower edge, so a tap 4px below reaches the text box',
      async () => {
        await withComposer('chromium', { width: 390 }, async (page) => {
          await useCoarsePointer(page);
          const { belowHit } = await readGauge(page);
          expect(belowHit).toBe('textarea');
        });
      },
      TEST_MS
    );
  });

  it(
    'keeps its touch area to its own box on a fine pointer',
    async () => {
      await withComposer('chromium', { width: 390 }, async (page) => {
        const { aboveHit } = await readGauge(page);
        expect(aboveHit).not.toBe('gauge');
      });
    },
    TEST_MS
  );
});
