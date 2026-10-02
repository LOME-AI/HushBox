import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, firefox, type Browser, type Page } from '@playwright/test';
import { TEST_IDS } from '@hushbox/shared';
import { startFixtureServer, type FixtureServer } from '@/test-utils/fixture-server';
import type { Plugin } from 'vite';

/**
 * Measures the kit's menus in real engines, under the app stylesheet: where a two-line row's icon
 * sits against its text, the anchored menu's floor, and the rows' heights in each presentation.
 * Only a layout engine settles those. A link item is followed here too, since only a real engine
 * navigates.
 *
 * Chromium and Firefox, the engines CI installs, driven through `@playwright/test` over a fixture
 * server; the page and its entry are virtual modules, so no fixture file joins the tree.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, '../../../..');
const SRC_DIR = path.join(WEB_DIR, 'src');

const ENTRY_ID = 'virtual:menu-kit-entry';
const PAGE_PATH = '/menu-kit.html';

/**
 * The first load compiles the app's whole stylesheet. On this host at a load average near 60, a
 * Chromium navigation outlasted 90 seconds, so the budget is twice that.
 */
const LOAD_MS = 180_000;
/** How long an opened menu may take to mount and finish its entrance on a loaded machine. */
const SETTLE_MS = 30_000;
const TEST_MS = LOAD_MS + SETTLE_MS + 30_000;
const CLOSE_MS = 45_000;
/**
 * The budget for closing both browsers. On this host at a load average near 50, Firefox took about
 * 57 seconds to close with no page open, so the budget is twice that.
 */
const BROWSER_CLOSE_MS = 120_000;
/** The teardown closes the browsers and then the fixture server, one after the other. */
const TEARDOWN_MS = BROWSER_CLOSE_MS + CLOSE_MS + 15_000;

const PAGE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>menu kit</title></head>
  <body>
    <div id="root"></div>
    <script type="module" src="/@id/${ENTRY_ID}"></script>
  </body>
</html>`;

const ENTRY_SOURCE = `
import { createElement as h, Fragment } from 'react';
import { createRoot } from 'react-dom/client';
import '@/app.css';
import section from '@/components/dev/kit/menu.section';

createRoot(document.getElementById('root')).render(h('main', { className: 'p-6' }, h(Fragment, null, section.render())));
`;

function pageModules(): Plugin {
  return {
    name: 'menu-kit-page',
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

const PHONE = { width: 390, height: 844 } as const;
const DESKTOP = { width: 1440, height: 900 } as const;

async function openMenu(
  browser: Browser,
  origin: string,
  viewport: { width: number; height: number },
  trigger: string
): Promise<Page> {
  const page = await browser.newPage({ viewport });
  await page.goto(`${origin}${PAGE_PATH}`, { timeout: LOAD_MS });
  await page.getByRole('button', { name: trigger, exact: true }).click({ timeout: LOAD_MS });
  await page.getByRole('menu').waitFor({ timeout: SETTLE_MS });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(
    () => document.getAnimations().every((animation) => animation.playState !== 'running'),
    undefined,
    { timeout: SETTLE_MS }
  );
  return page;
}

/** The vertical distance, in px, between a row's first drawn glyph box and its text block's centre. */
async function iconOffset(page: Page, itemName: string): Promise<number> {
  return page.getByRole('menuitemradio', { name: itemName }).evaluate((row) => {
    const icon = row.querySelector('svg:not(.invisible)') ?? row.querySelector('svg');
    const text = [...row.children].find((child) => child.tagName === 'SPAN');
    if (!icon || !text) throw new Error('the row has no icon or no text block');
    const middle = (rect: DOMRect): number => rect.top + rect.height / 2;
    return Math.abs(middle(icon.getBoundingClientRect()) - middle(text.getBoundingClientRect()));
  });
}

/** Opens a menu from the keyboard, as Enter on its focused trigger does. */
async function openFromKeyboard(browser: Browser, origin: string, trigger: string): Promise<Page> {
  const page = await browser.newPage({ viewport: PHONE });
  await page.goto(`${origin}${PAGE_PATH}`, { timeout: LOAD_MS });
  await page.getByRole('button', { name: trigger, exact: true }).focus({ timeout: LOAD_MS });
  await page.keyboard.press('Enter');
  await page.getByRole('menu').waitFor({ timeout: SETTLE_MS });
  return page;
}

const REPO_URL = 'https://github.com/lome-ai/hushbox';
/** Where the disabled link sample would lead, were it followable. */
const STUDIO_URL = 'https://local.drizzle.studio';
const LINK_TEST_ID = TEST_IDS.menuGithub;

/** Answers the link samples' destinations, so following one leaves no request unanswered. */
async function stubLinkTargets(page: Page, origin: string): Promise<void> {
  const fulfil = { contentType: 'text/html', body: '<!doctype html><title>followed</title>' };
  await page.context().route(`${REPO_URL}**`, (route) => route.fulfill(fulfil));
  await page.context().route(`${STUDIO_URL}**`, (route) => route.fulfill(fulfil));
  await page.route(`${origin}/welcome`, (route) => route.fulfill(fulfil));
}

/** Fails as the wait it names when `work` outlasts its budget. */
async function within<T>(work: Promise<T>, budgetMs: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const overrun = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${what} did not finish within ${String(budgetMs)}ms`));
    }, budgetMs);
  });
  try {
    return await Promise.race([work, overrun]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The URLs of every tab opened while `onDisabled` acts on the disabled link sample and then
 * `onEnabled` does the same to the new-tab sample. The enabled sample's tab ends the wait, and
 * a tab the disabled item asked for first is counted unless it lands after that tab commits.
 */
async function tabsOpenedBy(
  page: Page,
  onDisabled: () => Promise<void>,
  onEnabled: () => Promise<void>
): Promise<string[]> {
  const context = page.context();
  const opened: Page[] = [];
  const record = (tab: Page): void => {
    opened.push(tab);
  };
  context.on('page', record);
  try {
    await onDisabled();
    await onEnabled();
    await expect
      .poll(() => opened.some((tab) => tab.url().startsWith(REPO_URL)), { timeout: SETTLE_MS })
      .toBe(true);
    const urls: string[] = [];
    for (const tab of opened) {
      await tab.waitForURL((url) => url.href !== 'about:blank', {
        timeout: SETTLE_MS,
        waitUntil: 'commit',
      });
      urls.push(new URL(tab.url()).origin);
      await tab.close();
    }
    return urls;
  } finally {
    context.off('page', record);
  }
}

/** The URL of the tab that following the new-tab link sample opens, once `follow` has run. */
async function newTabFrom(page: Page, follow: () => Promise<void>): Promise<string> {
  const [tab] = await Promise.all([page.waitForEvent('popup', { timeout: SETTLE_MS }), follow()]);
  await tab.waitForURL(REPO_URL, { timeout: SETTLE_MS, waitUntil: 'commit' });
  const url = tab.url();
  await tab.close();
  return url;
}

/** The test id of whatever holds focus, if it carries one. */
async function focusedTestId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const active = document.activeElement;
    return active instanceof HTMLElement ? (active.dataset['testid'] ?? null) : null;
  });
}

/** What holds focus after each key: `menu`, `menuitem`, `close`, or `outside` the sheet. */
async function focusTrail(page: Page, keys: readonly string[]): Promise<string[]> {
  const trail: string[] = [];
  for (const key of keys) {
    await page.keyboard.press(key);
    trail.push(
      await page.evaluate(() => {
        const active = document.activeElement;
        if (!(active instanceof HTMLElement) || active.closest('[role="dialog"]') === null) {
          return 'outside';
        }
        if (active.dataset['slot'] === 'overlay-close') return 'close';
        return active.getAttribute('role') ?? active.tagName.toLowerCase();
      })
    );
  }
  return trail;
}

describe('the kit menus in a real engine', () => {
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
    try {
      await within(
        Promise.all(Object.values(browsers).map((browser) => browser.close())),
        BROWSER_CLOSE_MS,
        'closing the browsers'
      );
    } finally {
      await server.close();
    }
  }, TEARDOWN_MS);

  function browserFor(engine: EngineName): Browser {
    const browser = browsers[engine];
    if (browser === undefined) throw new Error(`${engine} did not launch`);
    return browser;
  }

  /** Opens the link sample's menu, with every place its items lead answered by a stub. */
  async function openLinksAt(
    engine: EngineName,
    viewport: { width: number; height: number }
  ): Promise<Page> {
    const page = await openMenu(browserFor(engine), server.url, viewport, 'Links');
    await stubLinkTargets(page, server.url);
    return page;
  }

  describe.each(ENGINES)('%s', (engine) => {
    describe.each([
      ['a sheet', PHONE],
      ['an anchored menu', DESKTOP],
    ])('as %s', (_presentation, viewport) => {
      it(
        "centres a two-line row's icon on its title and reason together",
        async () => {
          const page = await openMenu(
            browserFor(engine),
            server.url,
            viewport,
            'Change mode, image locked'
          );
          try {
            expect(await iconOffset(page, 'Image')).toBeLessThan(1);
          } finally {
            await page.close();
          }
        },
        TEST_MS
      );

      it(
        "centres a two-line row's check on its title and description together",
        async () => {
          const page = await openMenu(browserFor(engine), server.url, viewport, 'Effort · Mid');
          try {
            expect(await iconOffset(page, 'Mid')).toBeLessThan(1);
          } finally {
            await page.close();
          }
        },
        TEST_MS
      );
    });

    describe.each([
      ['a sheet', PHONE],
      ['an anchored menu', DESKTOP],
    ])('with a link item, as %s', (_presentation, viewport) => {
      const openLinks = (): Promise<Page> => openLinksAt(engine, viewport);

      it(
        "puts the caller's test id on the anchor that carries the menuitem role",
        async () => {
          const page = await openLinks();
          try {
            const carrier = await page
              .getByTestId(LINK_TEST_ID)
              .evaluate((item) => [item.tagName, item.getAttribute('role')]);
            expect(carrier).toEqual(['A', 'menuitem']);
          } finally {
            await page.close();
          }
        },
        TEST_MS
      );

      it(
        'moves onto a link item with the arrow keys',
        async () => {
          const page = await openLinks();
          try {
            await page.keyboard.press('ArrowDown');
            await page.keyboard.press('ArrowDown');
            await expect.poll(() => focusedTestId(page)).toBe(LINK_TEST_ID);
          } finally {
            await page.close();
          }
        },
        TEST_MS
      );

      it(
        'follows a new-tab link item on Enter',
        async () => {
          const page = await openLinks();
          try {
            await page.getByTestId(LINK_TEST_ID).focus();
            const url = await newTabFrom(page, () => page.keyboard.press('Enter'));
            expect(url).toBe(REPO_URL);
          } finally {
            await page.close();
          }
        },
        TEST_MS
      );

      it(
        'follows a new-tab link item on Space',
        async () => {
          const page = await openLinks();
          try {
            await page.getByTestId(LINK_TEST_ID).focus();
            const url = await newTabFrom(page, () => page.keyboard.press(' '));
            expect(url).toBe(REPO_URL);
          } finally {
            await page.close();
          }
        },
        TEST_MS
      );

      it(
        'follows a new-tab link item on a click',
        async () => {
          const page = await openLinks();
          try {
            const url = await newTabFrom(page, () => page.getByTestId(LINK_TEST_ID).click());
            expect(url).toBe(REPO_URL);
          } finally {
            await page.close();
          }
        },
        TEST_MS
      );

      it(
        'follows a link item in this tab on Enter',
        async () => {
          const page = await openLinks();
          try {
            await page.getByRole('menuitem', { name: 'About HushBox' }).focus();
            await page.keyboard.press('Enter');
            await page.waitForURL(`${server.url}/welcome`, {
              timeout: SETTLE_MS,
              waitUntil: 'commit',
            });
            expect(new URL(page.url()).pathname).toBe('/welcome');
          } finally {
            await page.close();
          }
        },
        TEST_MS
      );
    });

    describe.each([
      ['a sheet', PHONE],
      ['an anchored menu', DESKTOP],
    ])('with a disabled link item, as %s', (_presentation, viewport) => {
      const DISABLED = 'Database Studio';

      const openLinks = (): Promise<Page> => openLinksAt(engine, viewport);

      it(
        'gives a disabled link item no href to follow',
        async () => {
          const page = await openLinks();
          try {
            const item = page.getByRole('menuitem', { name: DISABLED });
            expect(await item.evaluate((row) => row.hasAttribute('href'))).toBe(false);
          } finally {
            await page.close();
          }
        },
        TEST_MS
      );

      it(
        'opens nothing on a middle-click of a disabled link item',
        async () => {
          const page = await openLinks();
          try {
            const tabs = await tabsOpenedBy(
              page,
              // Forced: Playwright refuses to press an aria-disabled element, and a person does not.
              () =>
                page
                  .getByRole('menuitem', { name: DISABLED })
                  .click({ button: 'middle', force: true }),
              () => page.getByTestId(LINK_TEST_ID).click({ button: 'middle' })
            );
            expect(tabs).toEqual([new URL(REPO_URL).origin]);
          } finally {
            await page.close();
          }
        },
        TEST_MS
      );

      it(
        'opens nothing on a Ctrl+click of a disabled link item',
        async () => {
          const page = await openLinks();
          try {
            const tabs = await tabsOpenedBy(
              page,
              () =>
                page
                  .getByRole('menuitem', { name: DISABLED })
                  .click({ modifiers: ['ControlOrMeta'], force: true }),
              () => page.getByTestId(LINK_TEST_ID).click({ modifiers: ['ControlOrMeta'] })
            );
            expect(tabs).toEqual([new URL(REPO_URL).origin]);
          } finally {
            await page.close();
          }
        },
        TEST_MS
      );

      it.each(['Enter', ' '])(
        'opens nothing on %j from a disabled link item',
        async (key) => {
          const page = await openLinks();
          try {
            const pressOn = async (item: ReturnType<Page['getByTestId']>): Promise<void> => {
              await item.focus();
              await page.keyboard.press(key);
            };
            const tabs = await tabsOpenedBy(
              page,
              () => pressOn(page.getByRole('menuitem', { name: DISABLED })),
              () => pressOn(page.getByTestId(LINK_TEST_ID))
            );
            expect(tabs).toEqual([new URL(REPO_URL).origin]);
          } finally {
            await page.close();
          }
        },
        TEST_MS
      );
    });

    it(
      'keeps Tab and Shift+Tab inside a sheet that holds link items',
      async () => {
        const page = await openFromKeyboard(browserFor(engine), server.url, 'Links');
        try {
          const trail = await focusTrail(page, ['Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab']);
          expect(trail).toEqual(['close', 'menu', 'close', 'menu', 'close']);
        } finally {
          await page.close();
        }
      },
      TEST_MS
    );

    it(
      'keeps Tab and Shift+Tab inside the sheet, between the menu and its close',
      async () => {
        const page = await openFromKeyboard(browserFor(engine), server.url, 'Conversation actions');
        try {
          const trail = await focusTrail(page, ['Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab']);
          expect(trail).toEqual(['close', 'menu', 'close', 'menu', 'close']);
        } finally {
          await page.close();
        }
      },
      TEST_MS
    );

    it(
      'keeps Tab inside a sheet that has no head',
      async () => {
        const page = await openFromKeyboard(browserFor(engine), server.url, 'Effort · Mid');
        try {
          const trail = await focusTrail(page, ['Tab', 'Shift+Tab', 'Tab']);
          expect(trail.every((stop) => stop !== 'outside')).toBe(true);
        } finally {
          await page.close();
        }
      },
      TEST_MS
    );

    it(
      'opens the mode menu at least 12rem wide',
      async () => {
        const page = await openMenu(browserFor(engine), server.url, DESKTOP, 'Change mode');
        try {
          const widthInRem = await page.getByRole('menu').evaluate((menu) => {
            const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
            return menu.getBoundingClientRect().width / rem;
          });
          expect(widthInRem).toBeGreaterThanOrEqual(12);
        } finally {
          await page.close();
        }
      },
      TEST_MS
    );

    it(
      'draws every sheet row at least 2.75rem tall',
      async () => {
        const page = await openMenu(
          browserFor(engine),
          server.url,
          PHONE,
          'Change mode, image locked'
        );
        try {
          const shortest = await page.getByRole('menu').evaluate((menu) => {
            const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
            const heights = [...menu.querySelectorAll('[role^="menuitem"]')].map(
              (row) => row.getBoundingClientRect().height / rem
            );
            return Math.min(...heights);
          });
          expect(shortest).toBeGreaterThanOrEqual(2.75);
        } finally {
          await page.close();
        }
      },
      TEST_MS
    );
  });
});
