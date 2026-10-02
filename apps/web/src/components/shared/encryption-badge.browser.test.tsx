import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, firefox, type Browser, type Page } from '@playwright/test';
import { startFixtureServer, type FixtureServer } from '@/test-utils/fixture-server';
import type { Plugin } from 'vite';

/**
 * Opens the header shield's hint in real engines, under the app stylesheet: by a pointer's
 * hover, by keyboard focus and by a tap on a touch screen. Which of those opens it depends on
 * `:focus-visible` and on the pointer the engine reports, which no test DOM models.
 *
 * Chromium and Firefox, the engines CI installs, driven through `@playwright/test` over a fixture
 * server; the page and its entry are virtual modules, so no fixture file joins the tree.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, '../../..');
const SRC_DIR = path.join(WEB_DIR, 'src');
const BADGE_FILE = path.join(HERE, 'encryption-badge.tsx');

const ENTRY_ID = 'virtual:encryption-badge-entry';
const PAGE_PATH = '/encryption-badge.html';

/** The first load compiles the app's whole stylesheet, which a busy machine can make slow. */
const LOAD_MS = 90_000;
const TEST_MS = LOAD_MS + 30_000;
const CLOSE_MS = 45_000;
/** The hint's open is a React state change and an entry animation; a loaded machine can hold both back. */
const OPEN_MS = 15_000;

const TOUCH_REM = 2.75;
/** The room the hint keeps from the viewport's edges. */
const EDGE_PX = 12;

const DESKTOP = { width: 1440, height: 900 } as const;
const PHONE = { width: 390, height: 844 } as const;

const PAGE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>encryption badge</title></head>
  <body>
    <div id="root"></div>
    <script type="module" src="/@id/${ENTRY_ID}"></script>
  </body>
</html>`;

// `who` picks the branch: `member` (signed in), `guest` (a link key held) or `visitor`;
// `scale` sets the accessibility widget's text size.
const ENTRY_SOURCE = `
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import '@/app.css';
import { setLinkGuestAuth } from '@/lib/auth/link-guest-auth';
import { EncryptionBadge } from ${JSON.stringify(BADGE_FILE)};

const who = new URLSearchParams(location.search).get('who') ?? 'member';
if (who === 'guest') setLinkGuestAuth('link-public-key');
const scale = new URLSearchParams(location.search).get('scale');
if (scale !== null) document.documentElement.classList.add('a11y-font-scale-' + scale);

createRoot(document.getElementById('root')).render(
  h('header', { style: { display: 'flex', justifyContent: 'flex-end', alignItems: 'center', height: '3.5rem', padding: '0 1rem' } },
    h(EncryptionBadge, { isAuthenticated: who === 'member' })));
`;

function pageModules(): Plugin {
  return {
    name: 'encryption-badge-page',
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

const SHIELD = '[data-testid="encryption-badge"]';
const HINT = '[data-slot="tooltip-content"]';

interface SceneOptions {
  who?: 'member' | 'guest' | 'visitor';
  /** The accessibility widget's text size, as a percentage. */
  scale?: '141';
  viewport?: { width: number; height: number };
  /** Opens the page with a touch screen, which the engine reports as a coarse pointer. */
  touch?: boolean;
}

async function openScene(
  browser: Browser,
  origin: string,
  { who = 'member', scale, viewport = DESKTOP, touch = false }: SceneOptions = {}
): Promise<Page> {
  const page = await browser.newPage({ viewport, hasTouch: touch });
  const query = scale === undefined ? `who=${who}` : `who=${who}&scale=${scale}`;
  // Navigation takes the load budget too; the shield's arrival is what proves the page loaded.
  await page.goto(`${origin}${PAGE_PATH}?${query}`, { waitUntil: 'commit', timeout: LOAD_MS });
  await page.locator(SHIELD).waitFor({ timeout: LOAD_MS });
  await page.evaluate(() => document.fonts.ready);
  return page;
}

/**
 * The hint's drawn lines once it has opened. Its direct children are read because Radix also
 * mirrors the text into a visually hidden node inside the same box.
 */
async function openedHint(page: Page): Promise<string> {
  const hint = page.locator(HINT);
  await hint.waitFor({ state: 'visible', timeout: OPEN_MS });
  const lines = await hint.locator(':scope > span.block').allInnerTexts();
  return lines.join(' ');
}

describe('the header shield in a real engine', () => {
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

  describe.each(ENGINES)('%s', (engine) => {
    it(
      'opens the hint when Tab reaches the shield',
      async () => {
        const page = await openScene(browserFor(engine), server.url);
        try {
          await page.keyboard.press('Tab');

          expect(await page.locator(SHIELD).evaluate((el) => el === document.activeElement)).toBe(
            true
          );
          expect(await openedHint(page)).toBe(
            'Encrypted. Not even we can read your messages. We only partner with AI providers that never store or train on your data.'
          );
        } finally {
          await page.close();
        }
      },
      TEST_MS
    );

    it(
      'opens the hint on hover',
      async () => {
        const page = await openScene(browserFor(engine), server.url, { who: 'visitor' });
        try {
          await page.locator(SHIELD).hover();

          expect(await openedHint(page)).toBe(
            'We only partner with AI providers that never store or train on your data. Sign up to save encrypted chats'
          );
        } finally {
          await page.close();
        }
      },
      TEST_MS
    );

    it(
      'opens the hint on a tap',
      async () => {
        const page = await openScene(browserFor(engine), server.url, {
          who: 'guest',
          viewport: PHONE,
          touch: true,
        });
        try {
          await page.locator(SHIELD).tap();

          expect(await openedHint(page)).toBe(
            'Encrypted. Not even we can read your messages. We only partner with AI providers that never store or train on your data.'
          );
        } finally {
          await page.close();
        }
      },
      TEST_MS
    );

    it(
      'keeps the open hint clear of the edges of a phone-width viewport at 141% text',
      async () => {
        const page = await openScene(browserFor(engine), server.url, {
          scale: '141',
          viewport: PHONE,
          touch: true,
        });
        try {
          await page.locator(SHIELD).tap();
          await page.locator(HINT).waitFor({ state: 'visible', timeout: OPEN_MS });
          await page.waitForFunction(
            () => document.getAnimations().every((a) => a.playState !== 'running'),
            undefined,
            { timeout: OPEN_MS }
          );
          const box = await page.locator(HINT).boundingBox();

          expect(box?.x).toBeGreaterThanOrEqual(EDGE_PX - 0.5);
          expect((box?.x ?? Infinity) + (box?.width ?? 0)).toBeLessThanOrEqual(
            PHONE.width - EDGE_PX + 0.5
          );
        } finally {
          await page.close();
        }
      },
      TEST_MS
    );

    it(
      'draws the open hint with no arrow',
      async () => {
        const page = await openScene(browserFor(engine), server.url);
        try {
          await page.locator(SHIELD).hover();
          await page.locator(HINT).waitFor({ state: 'visible', timeout: OPEN_MS });

          expect(await page.locator(`${HINT} svg`).isVisible()).toBe(false);
        } finally {
          await page.close();
        }
      },
      TEST_MS
    );

    it(
      'reaches the touch floor on a coarse pointer',
      async () => {
        const page = await openScene(browserFor(engine), server.url, {
          viewport: PHONE,
          touch: true,
        });
        try {
          const target = await page.locator(SHIELD).evaluate((el) => ({
            width: Number.parseFloat(getComputedStyle(el, '::before').width),
            height: Number.parseFloat(getComputedStyle(el, '::before').height),
            rem: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
          }));

          expect(target.width).toBeGreaterThanOrEqual(TOUCH_REM * target.rem - 0.5);
          expect(target.height).toBeGreaterThanOrEqual(TOUCH_REM * target.rem - 0.5);
        } finally {
          await page.close();
        }
      },
      TEST_MS
    );
  });
});
