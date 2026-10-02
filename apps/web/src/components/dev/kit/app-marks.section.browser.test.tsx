import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Plugin, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, firefox, type Browser, type Page } from '@playwright/test';

/**
 * Measures the app marks in real engines: a trust line's wrapped geometry, a clipped model
 * name and the state looks keyed off ARIA attributes exist only once the browser lays the
 * page out under the app stylesheet, which no test DOM does. The page mounts the kit
 * section and reads the samples it marks `data-sample`.
 *
 * Chromium and Firefox, the engines CI installs, driven by `@playwright/test` over a
 * private dev server; the page and its entry are virtual modules, so no fixture file
 * joins the tree.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, '../../../..');
const SRC_DIR = path.join(WEB_DIR, 'src');
const SECTION_FILE = path.join(HERE, 'app-marks.section.tsx');

const ENTRY_ID = 'virtual:app-marks-entry';

/** The first load compiles the app's whole stylesheet, which a busy machine can make slow. */
const LOAD_MS = 90_000;
const TEST_MS = LOAD_MS + 30_000;
/** Layout rounding a measured length may carry. */
const TOLERANCE_PX = 0.5;
/** Firefox reports a computed line height rounded to its layout unit, 1/60px. */
const LAYOUT_UNIT_PX = 1 / 60;

const PAGE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>app marks</title></head>
  <body>
    <div id="root"></div>
    <script type="module" src="/@id/${ENTRY_ID}"></script>
  </body>
</html>`;

const ENTRY_SOURCE = `
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import '@/app.css';
import section from ${JSON.stringify(SECTION_FILE)};

createRoot(document.getElementById('root')).render(createElement('div', null, section.render()));
globalThis.__appMarksReady = true;
`;

function pageModules(): Plugin {
  return {
    name: 'app-marks-page',
    resolveId(id) {
      return id === ENTRY_ID ? `\0${id}` : undefined;
    },
    load(id) {
      return id === `\0${ENTRY_ID}` ? ENTRY_SOURCE : undefined;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = request.url;
        if (!url?.startsWith('/app-marks.html')) {
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

async function startServer(): Promise<{ origin: string; close: () => Promise<void> }> {
  // A private dependency cache: the app's `node_modules/.vite` is the running dev server's,
  // and a second optimiser rewriting it leaves that server answering 504.
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'app-marks-vite-'));
  const server: ViteDevServer = await createServer({
    root: WEB_DIR,
    configFile: false,
    cacheDir,
    logLevel: 'error',
    plugins: [react(), tailwindcss(), pageModules()],
    resolve: { alias: [{ find: /^@\/(.*)$/, replacement: path.join(SRC_DIR, '$1') }] },
    server: { port: 0, host: '127.0.0.1', hmr: false },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (address === null || address === undefined || typeof address === 'string') {
    throw new Error('app marks server has no port');
  }
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    close: async () => {
      await server.close();
      await rm(cacheDir, { recursive: true, force: true });
    },
  };
}

declare global {
  var __appMarksReady: boolean | undefined;
}

interface TrustReading {
  lines: number;
  lineHeight: number;
  lineTop: number;
  iconTop: number;
  iconBottom: number;
}

/** Reads the trust line and its icon in the sample named `sample`. */
async function readTrustLine(page: Page, sample: string): Promise<TrustReading> {
  return page.evaluate((sample) => {
    const line = document.querySelector(`[data-sample="${sample}"] p`);
    const icon = line?.querySelector('svg');
    if (!(line instanceof HTMLElement) || !(icon instanceof SVGElement)) {
      throw new TypeError(`no trust line with an icon in sample ${sample}`);
    }
    const lineHeight = Number.parseFloat(getComputedStyle(line).lineHeight);
    const lineBox = line.getBoundingClientRect();
    const iconBox = icon.getBoundingClientRect();
    return {
      lines: Math.round(lineBox.height / lineHeight),
      lineHeight,
      lineTop: lineBox.top,
      iconTop: iconBox.top,
      iconBottom: iconBox.bottom,
    };
  }, sample);
}

interface LabelReading {
  width: number;
  eighteenCh: number;
  clipped: boolean;
}

/** Reads the model name's visible label in the sample named `sample`. */
async function readModelLabel(page: Page, sample: string): Promise<LabelReading> {
  return page.evaluate((sample) => {
    const label = [
      ...document.querySelectorAll<HTMLElement>(`[data-sample="${sample}"] button span`),
    ].find(
      (span) => span.dataset['slot'] !== 'swatch' && getComputedStyle(span).display !== 'none'
    );
    if (label === undefined) throw new Error(`no visible model label in sample ${sample}`);
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;width:18ch;padding:0';
    label.append(probe);
    const eighteenCh = probe.getBoundingClientRect().width;
    probe.remove();
    return {
      width: label.getBoundingClientRect().width,
      eighteenCh,
      clipped: label.scrollWidth > label.clientWidth,
    };
  }, sample);
}

/** The visible text of the model chip in the sample named `sample`. */
async function visibleModelText(page: Page, sample: string): Promise<string> {
  return page.evaluate((sample) => {
    const button = document.querySelector(`[data-sample="${sample}"] button`);
    if (!(button instanceof HTMLElement)) throw new Error(`no chip in sample ${sample}`);
    return [...button.querySelectorAll('span')]
      .filter((span) => getComputedStyle(span).display !== 'none')
      .map((span) => span.textContent)
      .join('');
  }, sample);
}

interface ChipReading {
  height: number;
  rootPx: number;
  background: string;
  borderColor: string;
  borderStyle: string;
  iconColor: string;
}

/** Reads the chip in the sample named `sample`, beside the colours its states name. */
async function readChip(page: Page, sample: string): Promise<ChipReading> {
  return page.evaluate((sample) => {
    const chip = document.querySelector(`[data-sample="${sample}"] button`);
    if (!(chip instanceof HTMLElement)) throw new Error(`no chip in sample ${sample}`);
    const style = getComputedStyle(chip);
    const icon = chip.querySelector('svg');
    return {
      height: chip.getBoundingClientRect().height,
      rootPx: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
      background: style.backgroundColor,
      borderColor: style.borderTopColor,
      borderStyle: style.borderTopStyle,
      iconColor: icon === null ? '' : getComputedStyle(icon).color,
    };
  }, sample);
}

/** Resolves a theme custom property to the colour string the engine computes for it. */
async function resolveColour(page: Page, property: string): Promise<string> {
  return page.evaluate((property) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${property})`;
    document.body.append(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  }, property);
}

/** Reads the box shadow of the avatar at `index` in the sample named `sample`. */
async function avatarShadow(page: Page, sample: string, index: number): Promise<string> {
  return page.evaluate(
    ({ sample, index }) => {
      const avatar = document.querySelectorAll(`[data-sample="${sample}"] [data-slot="avatar"]`)[
        index
      ];
      if (!(avatar instanceof HTMLElement)) throw new Error(`no avatar ${String(index)}`);
      return getComputedStyle(avatar).boxShadow;
    },
    { sample, index }
  );
}

/** The cursor each button in the sample named `sample` computes. */
async function cursorsIn(page: Page, sample: string): Promise<string[]> {
  return page.evaluate((sample) => {
    const buttons = [...document.querySelectorAll(`[data-sample="${sample}"] button`)];
    if (buttons.length === 0) throw new Error(`no button in sample ${sample}`);
    return buttons.map((button) => getComputedStyle(button).cursor);
  }, sample);
}

/** The trust line's font size in the sample named `sample`, in root ems. */
async function trustLineRem(page: Page, sample: string): Promise<number> {
  return page.evaluate((sample) => {
    const line = document.querySelector(`[data-sample="${sample}"] p`);
    if (!(line instanceof HTMLElement)) throw new Error(`no trust line in sample ${sample}`);
    const rootPx = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    return Number.parseFloat(getComputedStyle(line).fontSize) / rootPx;
  }, sample);
}

/** The trust line's computed line height in the sample named `sample`, in px. */
async function trustLineHeightPx(page: Page, sample: string): Promise<number> {
  return page.evaluate((sample) => {
    const line = document.querySelector(`[data-sample="${sample}"] p`);
    if (!(line instanceof HTMLElement)) throw new Error(`no trust line in sample ${sample}`);
    return Number.parseFloat(getComputedStyle(line).lineHeight);
  }, sample);
}

/** Every sample that draws an enabled chip. */
const ENABLED_CHIP_SAMPLES = [
  'chip-icon',
  'chip-unpressed',
  'chip-pressed',
  'chip-expanded',
  'chip-model',
  'model-truncate',
  'model-compact',
] as const;

type EngineName = 'chromium' | 'firefox';
const ENGINES: readonly EngineName[] = ['chromium', 'firefox'];

/** The desktop and phone widths the round-3 references are measured at. */
const DESKTOP_WIDTH = 1440;
const PHONE_WIDTH = 390;

async function openPage(
  browser: Browser,
  origin: string,
  hasTouch: boolean,
  width = DESKTOP_WIDTH
): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 1000 }, hasTouch });
  await page.goto(`${origin}/app-marks.html`, { waitUntil: 'commit', timeout: LOAD_MS });
  await page.waitForFunction(() => globalThis.__appMarksReady === true, undefined, {
    timeout: LOAD_MS,
  });
  await page.evaluate(() => document.fonts.ready);
  return page;
}

describe('app marks (real browser)', () => {
  let server: { origin: string; close: () => Promise<void> };
  const browsers: Partial<Record<EngineName, Browser>> = {};
  const pages: Partial<Record<EngineName, Page>> = {};
  const phonePages: Partial<Record<EngineName, Page>> = {};
  let touchPage: Page | undefined;

  beforeAll(async () => {
    server = await startServer();
    const [chromiumBrowser, firefoxBrowser] = await Promise.all([
      chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] }),
      firefox.launch(),
    ]);
    browsers.chromium = chromiumBrowser;
    browsers.firefox = firefoxBrowser;
    for (const engine of ENGINES) {
      const browser = browsers[engine];
      if (browser === undefined) throw new Error(`${engine} did not launch`);
      pages[engine] = await openPage(browser, server.origin, false);
      phonePages[engine] = await openPage(browser, server.origin, false, PHONE_WIDTH);
    }
    touchPage = await openPage(chromiumBrowser, server.origin, true);
  }, 4 * LOAD_MS);

  afterAll(async () => {
    await Promise.all(Object.values(browsers).map((browser) => browser.close()));
    await server.close();
  });

  function pageFor(engine: EngineName): Page {
    const page = pages[engine];
    if (page === undefined) throw new Error(`${engine} has no page`);
    return page;
  }

  function phonePageFor(engine: EngineName): Page {
    const page = phonePages[engine];
    if (page === undefined) throw new Error(`${engine} has no phone page`);
    return page;
  }

  describe.each(ENGINES)('on %s', (engine) => {
    it(
      'wraps the narrow trust line',
      async () => {
        const reading = await readTrustLine(pageFor(engine), 'trust-wrapped');

        expect(reading.lines).toBeGreaterThanOrEqual(2);
      },
      TEST_MS
    );

    it(
      'keeps the trust line icon on the first line of a wrapped line',
      async () => {
        const reading = await readTrustLine(pageFor(engine), 'trust-wrapped');

        expect(reading.iconTop).toBeGreaterThanOrEqual(reading.lineTop - TOLERANCE_PX);
        expect(reading.iconBottom).toBeLessThanOrEqual(
          reading.lineTop + reading.lineHeight + TOLERANCE_PX
        );
      },
      TEST_MS
    );

    it(
      'clips a long model name at 18ch',
      async () => {
        const reading = await readModelLabel(pageFor(engine), 'model-truncate');

        expect(reading.clipped).toBe(true);
        expect(reading.width).toBeLessThanOrEqual(reading.eighteenCh + TOLERANCE_PX);
      },
      TEST_MS
    );

    it(
      'shows the short model name inside a compact composer',
      async () => {
        expect(await visibleModelText(pageFor(engine), 'model-compact')).toBe('Flash');
      },
      TEST_MS
    );

    it(
      'shows the full model name outside a composer',
      async () => {
        expect(await visibleModelText(pageFor(engine), 'chip-model')).toBe('GPT-5');
      },
      TEST_MS
    );

    it(
      'draws a chip 2rem tall',
      async () => {
        const reading = await readChip(pageFor(engine), 'chip-unpressed');

        expect(Math.abs(reading.height - 2 * reading.rootPx)).toBeLessThanOrEqual(TOLERANCE_PX);
      },
      TEST_MS
    );

    it(
      'draws a pressed chip on the red-subtle fill with a red border and a red icon',
      async () => {
        const page = pageFor(engine);
        const reading = await readChip(page, 'chip-pressed');

        expect(reading.background).toBe(await resolveColour(page, '--brand-red-subtle'));
        expect(reading.borderColor).toBe(await resolveColour(page, '--brand-red'));
        expect(reading.iconColor).toBe(await resolveColour(page, '--brand-red'));
      },
      TEST_MS
    );

    it(
      'draws a disabled chip with a dashed border',
      async () => {
        const reading = await readChip(pageFor(engine), 'chip-disabled');

        expect(reading.borderStyle).toBe('dashed');
      },
      TEST_MS
    );

    it(
      'draws an open chip on the accent fill',
      async () => {
        const page = pageFor(engine);
        const reading = await readChip(page, 'chip-expanded');

        expect(reading.background).toBe(await resolveColour(page, '--accent'));
      },
      TEST_MS
    );

    it(
      'draws an unpressed chip on the control border with no fill',
      async () => {
        const page = pageFor(engine);
        const reading = await readChip(page, 'chip-unpressed');

        expect(reading.borderColor).toBe(await resolveColour(page, '--border-control'));
        expect(reading.background).toBe('rgba(0, 0, 0, 0)');
      },
      TEST_MS
    );

    it.each(ENABLED_CHIP_SAMPLES)(
      'shows the pointer on the enabled chip in %s',
      async (sample) => {
        expect(await cursorsIn(pageFor(engine), sample)).toEqual(['pointer']);
      },
      TEST_MS
    );

    it(
      'shows the not-allowed cursor on the disabled chip',
      async () => {
        expect(await cursorsIn(pageFor(engine), 'chip-disabled')).toEqual(['not-allowed']);
      },
      TEST_MS
    );

    it(
      'shows the pointer on both facepiles',
      async () => {
        expect(await cursorsIn(pageFor(engine), 'facepile')).toEqual(['pointer', 'pointer']);
      },
      TEST_MS
    );

    it(
      'sets the small ui trust line at 0.8125rem',
      async () => {
        expect(await trustLineRem(pageFor(engine), 'trust-ui-sm')).toBeCloseTo(0.8125, 3);
      },
      TEST_MS
    );

    it(
      'sets the caption trust line at 0.75rem',
      async () => {
        expect(await trustLineRem(pageFor(engine), 'trust-start')).toBeCloseTo(0.75, 3);
      },
      TEST_MS
    );

    it(
      'sets the small ui trust line 17.55px tall on a phone',
      async () => {
        expect(
          Math.abs((await trustLineHeightPx(phonePageFor(engine), 'trust-ui-sm')) - 17.55)
        ).toBeLessThanOrEqual(LAYOUT_UNIT_PX);
      },
      TEST_MS
    );

    it(
      'sets the small ui trust line 18.65px tall on a desktop',
      async () => {
        expect(
          Math.abs((await trustLineHeightPx(pageFor(engine), 'trust-ui-sm')) - 18.65)
        ).toBeLessThanOrEqual(LAYOUT_UNIT_PX);
      },
      TEST_MS
    );

    it(
      'sets the caption trust line 16.2px tall on a phone',
      async () => {
        expect(
          Math.abs((await trustLineHeightPx(phonePageFor(engine), 'trust-start')) - 16.2)
        ).toBeLessThanOrEqual(LAYOUT_UNIT_PX);
      },
      TEST_MS
    );

    it(
      'sets the caption trust line 17.21px tall on a desktop',
      async () => {
        expect(
          Math.abs((await trustLineHeightPx(pageFor(engine), 'trust-start')) - 17.21)
        ).toBeLessThanOrEqual(LAYOUT_UNIT_PX);
      },
      TEST_MS
    );

    it(
      'rings a lone online avatar 2px clear of its disc',
      async () => {
        const shadow = await avatarShadow(pageFor(engine), 'avatars', 0);

        expect(shadow).toContain('0px 0px 0px 4px');
      },
      TEST_MS
    );

    it(
      'rings an online avatar in the facepile more thinly',
      async () => {
        const shadow = await avatarShadow(pageFor(engine), 'facepile', 0);

        expect(shadow).toContain('0px 0px 0px 3.5px');
      },
      TEST_MS
    );

    it(
      'rims an offline avatar in the facepile in the page colour only',
      async () => {
        const shadow = await avatarShadow(pageFor(engine), 'facepile', 1);

        expect(shadow).toContain('0px 0px 0px 2px');
        expect(shadow).not.toContain('3.5px');
      },
      TEST_MS
    );
  });

  it(
    'extends a chip target to 2.75rem on a coarse pointer',
    async () => {
      if (touchPage === undefined) throw new Error('no touch page');
      const reading = await touchPage.evaluate(() => {
        const chip = document.querySelector('[data-sample="chip-unpressed"] button');
        if (!(chip instanceof HTMLElement)) throw new Error('no chip');
        return {
          target: Number.parseFloat(getComputedStyle(chip, '::before').height),
          box: chip.getBoundingClientRect().height,
          rootPx: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
        };
      });

      expect(Math.abs(reading.target - 2.75 * reading.rootPx)).toBeLessThanOrEqual(TOLERANCE_PX);
      expect(Math.abs(reading.box - 2 * reading.rootPx)).toBeLessThanOrEqual(TOLERANCE_PX);
    },
    TEST_MS
  );
});
