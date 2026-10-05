import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, firefox, type Browser, type Page } from '@playwright/test';
import { startFixtureServer, type FixtureServer } from '@/test-utils/fixture-server';

/**
 * Lays the document panel out in real engines, inside main columns of several widths, the way
 * the chat layout hosts it: a `panehost` container holding the thread column and the panel. It
 * reads where the panel docks, how much thread it leaves, where python's run button sits, and
 * which header tools a phone keeps, at the default text size and at the accessibility widget's
 * largest. The page and its entry are virtual modules, so no fixture file joins the tree.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, '../../..');
const SRC_DIR = path.join(WEB_DIR, 'src');
const PANEL_FILE = path.join(HERE, 'document-panel.tsx');
const STORE_FILE = path.join(SRC_DIR, 'stores', 'document.ts');

const ENTRY_ID = 'virtual:document-panel-hosts-entry';

/** The first load compiles the app's whole stylesheet, which a busy machine can make slow. */
const LOAD_MS = 90_000;
const TEST_MS = LOAD_MS + 30_000;
/** Subpixel layout allowance for widths read back from the engine. */
const LAYOUT_PX = 1;
/** The share of the main column a docked panel takes. */
const DOCKED_SHARE = 0.45;
/** The thread a docked panel must leave beside it, in the reader's rem. */
const THREAD_FLOOR_REM = 20;
/** Main-column widths: two either side of the dock line at default text, one past it at 141%. */
const HOST_WIDTHS = [800, 900, 1100, 1300] as const;
type HostWidth = (typeof HOST_WIDTHS)[number];

// A port nothing listens on: the panel's frame is not under test, only the bar it sits under.
const SANDBOX_ORIGIN = 'http://127.0.0.1:1';

/** Each page by its path, with the class its root carries: none, or the widget's largest text. */
const PAGE_CLASSES: ReadonlyMap<string, string> = new Map([
  ['/default.html', ''],
  ['/large.html', 'a11y-font-scale-141'],
]);

function pageHtml(htmlClass: string): string {
  return `<!doctype html>
<html lang="en" class="${htmlClass}">
  <head><meta charset="UTF-8" /><title>document panel</title></head>
  <body>
    <div id="root"></div>
    <script type="module" src="/@id/${ENTRY_ID}"></script>
  </body>
</html>`;
}

const ENTRY_SOURCE = `
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import '@/app.css';
import { DocumentPanel } from ${JSON.stringify(PANEL_FILE)};
import { useDocumentStore } from ${JSON.stringify(STORE_FILE)};

const content = Array.from({ length: 12 }, (_, i) => 'print(' + String(i) + ')').join(String.fromCharCode(10));
useDocumentStore.setState({
  isPanelOpen: true,
  isFullscreen: false,
  activeDocumentId: 'doc-1',
  activeSelectionId: 1,
  activeDocument: { id: 'doc-1', type: 'python', language: 'python', title: 'Spending by category',
    content, lineCount: 12, isStreaming: false },
});

const hosts = ${JSON.stringify(HOST_WIDTHS)};
createRoot(document.getElementById('root')).render(
  h('div', null, hosts.map((width) =>
    h('div', { key: width, id: 'host-' + String(width),
        className: '@container/panehost relative flex overflow-hidden', style: { width: width + 'px', height: '640px' } },
      h('div', { className: 'thread min-w-0 flex-1' }),
      h(DocumentPanel)))));
globalThis.__documentPanelReady = true;
`;

function pageModules(): Plugin {
  return {
    name: 'document-panel-hosts-page',
    config() {
      return {
        define: { 'import.meta.env.VITE_SANDBOX_ORIGIN_URL': JSON.stringify(SANDBOX_ORIGIN) },
      };
    },
    resolveId(id) {
      return id === ENTRY_ID ? `\0${id}` : undefined;
    },
    load(id) {
      return id === `\0${ENTRY_ID}` ? ENTRY_SOURCE : undefined;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = request.url;
        const htmlClass = url === undefined ? undefined : PAGE_CLASSES.get(url.split('?')[0] ?? '');
        if (htmlClass === undefined || url === undefined) {
          next();
          return;
        }
        void (async (): Promise<void> => {
          try {
            const html = await server.transformIndexHtml(url, pageHtml(htmlClass));
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
  var __documentPanelReady: boolean | undefined;
}

interface HostReading {
  hostPx: number;
  panelPx: number;
  threadPx: number;
  /** Whether the panel lies over the thread rather than beside it. */
  over: boolean;
  /** The panel's box, to compare with the window's. */
  panelBox: { top: number; left: number; width: number; height: number };
  /** Whether the run button sits on a row below the view toggle. */
  runOwnRow: boolean;
  runPx: number;
  barInnerPx: number;
  /** Whether Fullscreen is on screen, which it is only where the panel docks. */
  fullscreenShown: boolean;
}

interface PageReading {
  rootPx: number;
  hosts: Record<string, HostReading>;
  /** The header tools a reader can see, by name. */
  visibleTools: string[];
}

async function readPage(page: Page): Promise<PageReading> {
  return page.evaluate(() => {
    /** Whether an element is on screen, which a hidden or missing one is not. */
    const drawn = (element: Element | null): boolean =>
      (element?.getBoundingClientRect().width ?? 0) > 0;
    const hosts: Record<string, HostReading> = {};
    let visibleTools: string[] = [];
    for (const host of document.querySelectorAll<HTMLElement>('[id^="host-"]')) {
      const panel = host.querySelector<HTMLElement>('aside');
      const thread = host.querySelector<HTMLElement>('.thread');
      if (panel === null || thread === null) throw new TypeError(`${host.id} has no panel`);
      const radios = panel.querySelectorAll<HTMLElement>('[role="radio"]');
      const toggle = radios[0]?.parentElement;
      const bar = toggle?.parentElement;
      // The bar's last control is python's action, whichever word it reads: this page's frame
      // never answers, so it reads Stop.
      const run = bar?.lastElementChild;
      if (!toggle || !run) throw new TypeError(`${host.id} has no bar`);
      const barStyle = getComputedStyle(bar);
      const panelBox = panel.getBoundingClientRect();
      hosts[host.id] = {
        hostPx: host.getBoundingClientRect().width,
        panelPx: panelBox.width,
        threadPx: panelBox.left - host.getBoundingClientRect().left,
        over: ['absolute', 'fixed'].includes(getComputedStyle(panel).position),
        panelBox: {
          top: panelBox.top,
          left: panelBox.left,
          width: panelBox.width,
          height: panelBox.height,
        },
        runOwnRow: run.getBoundingClientRect().top >= toggle.getBoundingClientRect().bottom,
        runPx: run.getBoundingClientRect().width,
        fullscreenShown: drawn(panel.querySelector('button[aria-label="Fullscreen"]')),
        barInnerPx:
          bar.clientWidth -
          Number.parseFloat(barStyle.paddingLeft) -
          Number.parseFloat(barStyle.paddingRight),
      };
      visibleTools = [...panel.querySelectorAll<HTMLElement>('button[aria-label]')]
        .filter((button) => button.getBoundingClientRect().width > 0)
        .map((button) => button.getAttribute('aria-label') ?? '');
    }
    return {
      rootPx: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
      hosts,
      visibleTools,
    };
  });
}

type EngineName = 'chromium' | 'firefox';
const ENGINES: readonly EngineName[] = ['chromium', 'firefox'];
type Setup = 'default' | 'large' | 'phone';
const SETUPS: readonly { setup: Setup; page: string; width: number; height: number }[] = [
  { setup: 'default', page: 'default.html', width: 1440, height: 900 },
  { setup: 'large', page: 'large.html', width: 1440, height: 900 },
  { setup: 'phone', page: 'default.html', width: 390, height: 844 },
];

describe('document panel in main columns of several widths (real browser)', () => {
  let server: FixtureServer;
  const browsers: Partial<Record<EngineName, Browser>> = {};
  const readings: Partial<Record<`${EngineName} ${Setup}`, PageReading>> = {};

  beforeAll(
    async () => {
      server = await startFixtureServer({
        root: WEB_DIR,
        configFile: false,
        plugins: [react(), tailwindcss(), pageModules()],
        resolve: { alias: [{ find: /^@\/(.*)$/, replacement: path.join(SRC_DIR, '$1') }] },
      });
      const [chromiumBrowser, firefoxBrowser] = await Promise.all([
        chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] }),
        firefox.launch(),
      ]);
      browsers.chromium = chromiumBrowser;
      browsers.firefox = firefoxBrowser;
      for (const engine of ENGINES) {
        const browser = browsers[engine];
        if (browser === undefined) throw new Error(`${engine} did not launch`);
        for (const { setup, page: file, width, height } of SETUPS) {
          const page = await browser.newPage({ viewport: { width, height } });
          await page.goto(`${server.url}/${file}`, { waitUntil: 'commit', timeout: LOAD_MS });
          await page.waitForFunction(() => globalThis.__documentPanelReady === true, undefined, {
            timeout: LOAD_MS,
          });
          await page.locator('aside').first().waitFor({ timeout: LOAD_MS });
          await page.evaluate(() => document.fonts.ready);
          readings[`${engine} ${setup}`] = await readPage(page);
          await page.close();
        }
      }
    },
    TEST_MS * ENGINES.length * SETUPS.length
  );

  afterAll(async () => {
    await Promise.all(Object.values(browsers).map((browser) => browser.close()));
    await server.close();
  }, TEST_MS);

  function host(engine: EngineName, setup: Setup, width: HostWidth): HostReading {
    const value = readings[`${engine} ${setup}`]?.hosts[`host-${String(width)}`];
    if (value === undefined)
      throw new Error(`${engine} ${setup} has no reading at ${String(width)}`);
    return value;
  }

  function rootPx(engine: EngineName, setup: Setup): number {
    const value = readings[`${engine} ${setup}`]?.rootPx;
    if (value === undefined) throw new Error(`${engine} ${setup} has no reading`);
    return value;
  }

  it.each(ENGINES)('docks at 45 percent of a main column 51rem or wider in %s', (engine) => {
    const reading = host(engine, 'default', 1100);
    expect(reading.over).toBe(false);
    expect(Math.abs(reading.panelPx - reading.hostPx * DOCKED_SHARE)).toBeLessThanOrEqual(
      LAYOUT_PX
    );
  });

  it.each(ENGINES)('opens over the thread at full width in a narrower column in %s', (engine) => {
    const reading = host(engine, 'default', 800);
    expect(reading.over).toBe(true);
    expect(Math.abs(reading.panelPx - reading.hostPx)).toBeLessThanOrEqual(LAYOUT_PX);
  });

  it.each(ENGINES)('moves the dock line with the reader text size in %s', (engine) => {
    expect(host(engine, 'large', 1100).over).toBe(true);
    expect(host(engine, 'large', 1300).over).toBe(false);
  });

  it.each(ENGINES)('leaves a readable thread wherever it docks in %s', (engine) => {
    for (const setup of ['default', 'large'] as const) {
      const docked = HOST_WIDTHS.map((width) => host(engine, setup, width)).filter(
        (reading) => !reading.over
      );
      expect(docked.length).toBeGreaterThan(0);
      for (const reading of docked) {
        expect(reading.threadPx).toBeGreaterThanOrEqual(THREAD_FLOOR_REM * rootPx(engine, setup));
      }
    }
  });

  it.each(ENGINES)('offers Fullscreen only where the panel docks in %s', (engine) => {
    expect(host(engine, 'default', 1100).fullscreenShown).toBe(true);
    expect(host(engine, 'default', 800).fullscreenShown).toBe(false);
  });

  it.each(ENGINES)('keeps Run on the bar line in a panel wider than 24.75rem in %s', (engine) => {
    expect(host(engine, 'default', 1100).runOwnRow).toBe(false);
  });

  it.each(ENGINES)('gives Run a full-width row of its own in a narrower panel in %s', (engine) => {
    const reading = host(engine, 'default', 900);
    expect(reading.runOwnRow).toBe(true);
    expect(Math.abs(reading.runPx - reading.barInnerPx)).toBeLessThanOrEqual(LAYOUT_PX);
  });

  it.each(ENGINES)('fills the whole screen on a phone in %s', (engine) => {
    for (const width of HOST_WIDTHS) {
      const { panelBox } = host(engine, 'phone', width);
      expect(panelBox).toEqual({ top: 0, left: 0, width: 390, height: 844 });
    }
  });

  it.each(ENGINES)('keeps Copy, Download and Close on a phone in %s', (engine) => {
    expect(readings[`${engine} phone`]?.visibleTools).toEqual([
      'Copy code',
      'Download file',
      'Close panel',
    ]);
  });
});
