import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, firefox, type Browser, type Page } from '@playwright/test';
import { startFixtureServer, type FixtureServer } from '@/test-utils/fixture-server';
import type { Plugin } from 'vite';

/**
 * Proves in real engines that /settings#<group> keeps its group where the arrival scroll put
 * it after the groups above it finish loading. The arrival scroll runs once, when the page
 * mounts; the notification preferences and this device's reading land after it and grow the
 * Notifications group above Legal, which no test DOM lays out.
 *
 * The real route mounts under a memory router over the app stylesheet. Its reads are held
 * until the test releases them, so the growth comes strictly after the arrival. The page,
 * its entry and the seams it replaces are virtual modules below, so no fixture file joins
 * the tree. Chromium and Firefox, the engines CI installs.
 *
 * The same page also proves that a click which grows a group ends that hold, so nothing moves
 * under the pointer, and that the Account group's longest username never runs over its title
 * under the accessibility widget's largest text.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, '../../..');
const SRC_DIR = path.join(WEB_DIR, 'src');
const ROUTE_FILE = path.join(HERE, 'settings.tsx');

const ENTRY_ID = 'virtual:settings-page-entry';
const CLIENT_ID = 'virtual:settings-page-client';
const SESSION_ID = 'virtual:settings-page-session';
const CHANNEL_ID = 'virtual:settings-page-channel';

/** The first load transforms the route's whole import graph, which a busy machine can make slow. */
const LOAD_MS = 90_000;
const TEST_MS = LOAD_MS + 30_000;
/** The furthest a section may sit from its target: the page reads the band in whole pixels. */
const HOLD_PX = 1.5;
/** How long the page has to put Legal back after the rows land. */
const SETTLE_MS = 5000;
/** The longest username the schema admits. */
const LONGEST_USERNAME = 'abcdefghij_klmnopqrs';
/** A phone at the widget's largest text, the narrowest the row must hold. */
const PHONE = { width: 320, height: 900 } as const;
/** A tablet with the sidebar open: the page column is narrower than the window. */
const TABLET = { width: 834, height: 900 } as const;
/** Short enough that the page scrolls Legal all the way up to the pinned band. */
const SHORT = { width: 1440, height: 420 } as const;
/**
 * Tall enough that Security arrives without the page's end clamping it, and that Notifications
 * does clamp while its rows are still loading, since too little of the page lies below it.
 */
const TALL = { width: 1440, height: 900 } as const;
/**
 * How far a box laid flush with its row's edge may read past it: Firefox keeps layout in
 * sixtieths of a pixel, so the two edges convert to floats that differ in the fifth place.
 */
const FLUSH_EDGE_PX = 0.001;
/** Warm-up walks allowed before the fixture server must have settled its dependencies. */
const SETTLE_ATTEMPTS = 3;
/** How far past its target a clamped arrival must sit, well beyond any layout rounding. */
const CLAMPED_PX = 50;
/** The space the page leaves between the pinned band and a section it scrolls to. */
const SECTION_GAP_PX = 16;
/** Long past the task the dialog's own focus return is queued in once it closes. */
const FOCUS_RETURN_SETTLE_MS = 500;
/** Less than the settings content, so the page scrolls. */
const DESKTOP = { width: 1440, height: 700 } as const;

const PAGE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>settings page</title></head>
  <body>
    <div id="root"></div>
    <script type="module" src="/@id/${ENTRY_ID}"></script>
  </body>
</html>`;

const ENTRY_SOURCE = `
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter,
} from '@tanstack/react-router';
import '@/app.css';
import { useAuthStore } from '@/lib/auth/auth';
import { Route } from ${JSON.stringify(ROUTE_FILE)};

const params = new URLSearchParams(location.search);
const scale = params.get('scale');
if (scale !== null) document.documentElement.classList.add('a11y-font-scale-' + scale);
const face = params.get('font');
if (face !== null) {
  document.documentElement.style.setProperty('--a11y-font-family', '"' + face + '"');
  document.documentElement.classList.add('a11y-font-override');
}
// The app shell's open sidebar, as wide as the real one, beside the page.
const sidebar = params.get('sidebar') === 'open';
useAuthStore.setState({
  user: {
    id: 'user-1',
    email: 'alice@hushbox.ai',
    username: params.get('username') ?? 'alice',
    emailVerified: true,
    totpEnabled: false,
    hasAcknowledgedPhrase: false,
  },
  customInstructions: null,
  customInstructionsStatus: 'absent',
});

const rootRoute = createRootRoute({
  component: () =>
    h('div', { style: { height: '100vh', display: 'flex' } },
      sidebar ? h('aside', { style: { width: '18rem', flex: 'none' } }) : null,
      h('div', { style: { flex: '1 1 0', minWidth: 0 } }, h(Outlet))),
});
const settingsRoute = Route.update({
  id: '/settings',
  path: '/settings',
  getParentRoute: () => rootRoute,
  beforeLoad: () => undefined,
});
const pages = ['/accessibility', '/billing', '/usage'].map((path) =>
  createRoute({ getParentRoute: () => rootRoute, path, component: () => null }),
);
const router = createRouter({
  routeTree: rootRoute.addChildren([settingsRoute, ...pages]),
  history: createMemoryHistory({ initialEntries: ['/settings'] }),
});
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById('root')).render(
  h(QueryClientProvider, { client: queryClient }, h(RouterProvider, { router })),
);
`;

/** Every read, in every seam, waits for the test's one release, then answers with its data. */
const HELD_READS = `
const held_ = (globalThis.__heldReads ??= { released: false, waiters: [] });
globalThis.__releaseReads = () => {
  held_.released = true;
  for (const settle of held_.waiters.splice(0)) settle();
};
function held(answer) {
  return new Promise((resolve) => {
    const settle = () => resolve(answer());
    if (held_.released) settle();
    else held_.waiters.push(settle);
  });
}
`;

/** The typed client's seam: a request names its path; a read answers from `DATA`, or null. */
const CLIENT_SOURCE = `${HELD_READS}
const DATA = {
  'newsletter.me': { subscribed: false },
  'notifications.preferences': {
    globalEnabled: true, messages: true, runCompletion: true, membership: true, quietHours: null,
  },
  'auth.2fa.setup': { secret: 'JBSWY3DPEHPK3PXP', totpUri: 'otpauth://totp/HushBox:alice?secret=JBSWY3DPEHPK3PXP' },
  'auth.2fa.verify': { success: true },
};
function node(path) {
  return new Proxy({}, {
    get(_target, key) {
      if (key === '$get' || key === '$put' || key === '$post') {
        return (arg) => ({ path, method: key, arg });
      }
      return node(path === '' ? String(key) : path + '.' + String(key));
    },
  });
}
export const client = node('');
export const appVersion = 'test';
export function fetchJson(request) {
  return held(() => (request.method === '$put' ? request.arg.json : (DATA[request.path] ?? null)));
}
`;

const SESSION_SOURCE = `
export function useStableSession() {
  return { session: null, isAuthenticated: true, isStable: true, isPending: false };
}
`;

/** This device answers "blocked" once released: the reading that draws the tallest row. */
const CHANNEL_SOURCE = `${HELD_READS}
export const notificationChannel = {
  getPermissionState: () => held(() => 'denied'),
  getLastRegistrationOutcome: () => null,
  requestPermissionAndRegister: () => held(() => 'denied'),
  ensureRegistered: () => held(() => undefined),
  unregister: () => held(() => undefined),
};
export function isPromptDismissed() { return false; }
export function markPromptDismissed() {}
`;

function pageModules(): Plugin {
  const sources = new Map([
    [ENTRY_ID, ENTRY_SOURCE],
    [CLIENT_ID, CLIENT_SOURCE],
    [SESSION_ID, SESSION_SOURCE],
    [CHANNEL_ID, CHANNEL_SOURCE],
  ]);
  return {
    name: 'settings-page',
    resolveId(id) {
      return sources.has(id) ? `\0${id}` : undefined;
    },
    load(id) {
      return id.startsWith('\0') ? sources.get(id.slice(1)) : undefined;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = request.url;
        if (!url?.startsWith('/settings-page.html')) {
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
  var __releaseReads: (() => void) | undefined;
}

interface SectionReading {
  /** The section's top below the scroller's top. */
  offset: number;
  /** Where the page scrolls a section to: the pinned band's height and the gap below it. */
  target: number;
  /** The link row's current section. */
  current: string | undefined;
}

async function readSection(page: Page, id: string): Promise<SectionReading> {
  return page.evaluate(
    ({ id, gap }) => {
      const section = document.querySelector(`#${id}`);
      const scroller = section?.closest('[data-page-scroller]');
      const band = scroller?.querySelector<HTMLElement>('[data-page-pinned]');
      if (!section || !scroller || !band) throw new Error(`#${id} is not under a pinned band`);
      return {
        offset: section.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
        target: band.offsetHeight + gap,
        current:
          document.querySelector('nav[aria-label="Settings"] [aria-current]')?.textContent ??
          undefined,
      };
    },
    { id, gap: SECTION_GAP_PX }
  );
}

/** Polls until `id` sits at the page's scroll target for it, just under the pinned band. */
async function expectAtTarget(page: Page, id: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const { offset, target } = await readSection(page, id);
        return Math.abs(offset - target);
      },
      { timeout: SETTLE_MS }
    )
    .toBeLessThanOrEqual(HOLD_PX);
}

async function openPage(page: Page, query: string): Promise<void> {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  if (origin.url === '') throw new Error('the fixture server has not started');
  await page.goto(`${origin.url}/settings-page.html${query}`, {
    waitUntil: 'commit',
    timeout: LOAD_MS,
  });
  await page
    .locator('#legal')
    .waitFor({ timeout: LOAD_MS })
    .catch((error: unknown) => {
      throw new Error(`the page never mounted; page errors: ${pageErrors.join(' | ')}`, {
        cause: error,
      });
    });
}

/** Lets every held read answer, and waits for the notification rows they draw. */
async function loadRows(page: Page): Promise<void> {
  await page.evaluate(() => {
    globalThis.__releaseReads?.();
  });
  await page.getByText('This device').waitFor({ timeout: LOAD_MS });
  await page.getByRole('switch', { name: 'All notifications' }).waitFor();
}

/**
 * Walks the page through every state the cases reach, once, before the first case: the dev
 * server discovers and pre-bundles the dependencies those states import, and reloads this page
 * rather than a case's if it has to re-optimise them. Done when a whole walk loads one document.
 */
async function settleDependencies(browser: Browser): Promise<void> {
  for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt += 1) {
    const page = await browser.newPage({ viewport: DESKTOP });
    let documents = 0;
    page.on('request', (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents += 1;
    });
    try {
      await openPage(page, '?scale=141&font=open-dyslexic#legal');
      await loadRows(page);
      await page.getByRole('switch', { name: 'Quiet hours' }).click();
      await page.getByRole('combobox', { name: 'From' }).waitFor({ timeout: LOAD_MS });
      await page.waitForLoadState('load');
    } finally {
      await page.close();
    }
    if (documents === 1) return;
  }
  throw new Error('the fixture server kept re-optimising its dependencies');
}

/** The fixture server's origin, set once it has started. */
const origin = { url: '' };

type EngineName = 'chromium' | 'firefox';
const ENGINES: readonly EngineName[] = ['chromium', 'firefox'];

describe('/settings in a real browser', () => {
  let server: FixtureServer;
  const browsers: Partial<Record<EngineName, Browser>> = {};

  beforeAll(async () => {
    server = await startFixtureServer({
      root: WEB_DIR,
      configFile: false,
      plugins: [react(), tailwindcss(), pageModules()],
      resolve: {
        alias: [
          { find: /^@\/lib\/api-client(\.js)?$/, replacement: CLIENT_ID },
          { find: /^@\/hooks\/auth\/use-stable-session$/, replacement: SESSION_ID },
          { find: /^@\/lib\/notification-channel$/, replacement: CHANNEL_ID },
          { find: /^@\/(.*)$/, replacement: path.join(SRC_DIR, '$1') },
        ],
      },
    });
    origin.url = server.url;
    const [chromiumBrowser, firefoxBrowser] = await Promise.all([
      chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] }),
      firefox.launch(),
    ]);
    browsers.chromium = chromiumBrowser;
    browsers.firefox = firefoxBrowser;
    await settleDependencies(chromiumBrowser);
  }, 3 * LOAD_MS);

  // Closing two browsers and the server can outlast the default hook budget on a busy machine.
  afterAll(async () => {
    await Promise.all(Object.values(browsers).map((browser) => browser.close()));
    await server.close();
  }, LOAD_MS);

  async function withPage(
    engine: EngineName,
    viewport: { width: number; height: number },
    body: (page: Page) => Promise<void>
  ): Promise<void> {
    const browser = browsers[engine];
    if (browser === undefined) throw new Error(`${engine} did not launch`);
    const page = await browser.newPage({ viewport });
    // A case loads its page once. A second document load mid-case (the dev server's dependency
    // re-optimisation reloads the page, with its reads held again) would leave the case
    // measuring a fresh arrival, so it fails loudly rather than passing or failing on that.
    const loads: string[] = [];
    page.on('request', (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        loads.push(request.url());
      }
    });
    const reloaded = (): Error =>
      new Error(`the page loaded ${String(loads.length)} documents mid-case: ${loads.join(' | ')}`);
    try {
      await body(page);
    } catch (error) {
      if (loads.length > 1) throw reloaded();
      throw error;
    } finally {
      await page.close();
    }
    if (loads.length > 1) throw reloaded();
  }

  it.each(ENGINES)(
    'lands #security just under the pinned band on arrival, on %s',
    async (engine) => {
      await withPage(engine, TALL, async (page) => {
        await openPage(page, '#security');

        await expectAtTarget(page, 'security');
        const arrived = await readSection(page, 'security');
        expect(arrived.current).toBe('Security');
      });
    },
    TEST_MS
  );

  it.each(ENGINES)(
    'brings #legal to just under the pinned band once the groups above it load, on %s',
    async (engine) => {
      await withPage(engine, SHORT, async (page) => {
        await openPage(page, '#legal');

        await loadRows(page);

        await expectAtTarget(page, 'legal');
        const landed = await readSection(page, 'legal');
        expect(landed.current).toBe('Legal');
      });
    },
    TEST_MS
  );

  it.each(ENGINES)(
    'finishes a clamped #notifications arrival just under the pinned band once its rows load, on %s',
    async (engine) => {
      await withPage(engine, TALL, async (page) => {
        await openPage(page, '#notifications');
        await page.waitForFunction(
          () => (document.querySelector('[data-page-scroller]')?.scrollTop ?? 0) > 0,
          undefined,
          { timeout: LOAD_MS }
        );
        const arrived = await readSection(page, 'notifications');
        expect(arrived.offset - arrived.target).toBeGreaterThan(CLAMPED_PX);

        await loadRows(page);

        await expectAtTarget(page, 'notifications');
      });
    },
    TEST_MS
  );

  it.each(ENGINES)(
    'draws no focus ring on a fresh #legal load, on %s',
    async (engine) => {
      await withPage(engine, SHORT, async (page) => {
        await openPage(page, '#legal');
        await loadRows(page);
        await page.waitForLoadState('load');
        await expectAtTarget(page, 'legal');

        const ring = await page.evaluate(() => {
          const ringed = document.querySelector(':focus-visible');
          return ringed === null ? null : ringed.id || ringed.tagName;
        });
        expect(ring).toBeNull();
      });
    },
    TEST_MS
  );

  it.each(ENGINES)(
    'rings the section a reader reaches from the link row by keyboard, on %s',
    async (engine) => {
      await withPage(engine, TALL, async (page) => {
        await openPage(page, '');
        await page
          .getByRole('navigation', { name: 'Settings' })
          .getByRole('link', { name: 'Security' })
          .focus();

        await page.keyboard.press('Enter');

        const security = page.locator('#security');
        await expect
          .poll(async () => security.evaluate((section) => section.matches(':focus-visible')), {
            timeout: SETTLE_MS,
          })
          .toBe(true);
        const outline = await security.evaluate(
          (section) => getComputedStyle(section).outlineStyle
        );
        expect(outline).not.toBe('none');
      });
    },
    TEST_MS
  );

  it.each(ENGINES)(
    'follows a later hash, back and forward, and holds the last one through a resize, on %s',
    async (engine) => {
      await withPage(engine, SHORT, async (page) => {
        await openPage(page, '#legal');
        await loadRows(page);
        await expectAtTarget(page, 'legal');

        await page.evaluate(() => {
          globalThis.location.hash = '#security';
        });
        await expectAtTarget(page, 'security');
        await page.evaluate(() => {
          globalThis.history.back();
        });
        await page.waitForFunction(() => globalThis.location.hash === '#legal');
        await expectAtTarget(page, 'legal');
        await page.evaluate(() => {
          globalThis.history.forward();
        });
        await page.waitForFunction(() => globalThis.location.hash === '#security');
        await expectAtTarget(page, 'security');

        await page.setViewportSize({ width: SHORT.width, height: SHORT.height + 200 });

        await expectAtTarget(page, 'security');
        const held = await readSection(page, 'security');
        expect(held.current).toBe('Security');
      });
    },
    TEST_MS
  );

  it.each(ENGINES)(
    'lands focus on the Security two-factor row once setup finishes from Turn on, on %s',
    async (engine) => {
      await withPage(engine, TALL, async (page) => {
        await openPage(page, '');
        await loadRows(page);
        await page.getByRole('button', { name: 'Turn on' }).click();
        await page.getByRole('button', { name: /get started/i }).click();
        await page.getByRole('button', { name: /continue/i }).click();
        await page.getByRole('dialog').getByRole('textbox').click();
        await page.keyboard.type('123456');
        await page.getByRole('button', { name: /done/i }).click();

        const focusedRow = (): Promise<string | undefined> =>
          page.evaluate(
            () =>
              document.activeElement
                ?.closest('[data-settings-row]')
                ?.querySelector('[data-settings-title]')?.textContent ?? undefined
          );
        await expect.poll(focusedRow, { timeout: SETTLE_MS }).toBe('Two-Factor Authentication');
        // The dialog's own focus return runs a task after it closes; the landing outlasts it.
        await page.waitForTimeout(FOCUS_RETURN_SETTLE_MS);
        expect(await focusedRow()).toBe('Two-Factor Authentication');
      });
    },
    TEST_MS
  );

  it.each(ENGINES)(
    'moves nothing under the pointer when a click after #legal grows a group, on %s',
    async (engine) => {
      await withPage(engine, DESKTOP, async (page) => {
        await openPage(page, '#legal');
        await loadRows(page);
        const quietHours = page.getByRole('switch', { name: 'Quiet hours' });
        await quietHours.scrollIntoViewIfNeeded();
        const before = await quietHours.boundingBox();

        await quietHours.click();
        await page.getByRole('combobox', { name: 'From' }).waitFor({ timeout: LOAD_MS });

        await expect
          .poll(
            async () => {
              const box = await quietHours.boundingBox();
              return box?.y;
            },
            { timeout: SETTLE_MS }
          )
          .toBeCloseTo(before?.y ?? Number.NaN, 0);
      });
    },
    TEST_MS
  );

  it.each([
    { engine: 'chromium', viewport: PHONE, query: '?scale=141' },
    { engine: 'firefox', viewport: PHONE, query: '?scale=141' },
    { engine: 'chromium', viewport: TABLET, query: '?scale=141&font=open-dyslexic&sidebar=open' },
    { engine: 'firefox', viewport: TABLET, query: '?scale=141&font=open-dyslexic&sidebar=open' },
  ] as const)(
    'keeps the longest username clear of its row title at $viewport.width with $query, on $engine',
    async ({ engine, viewport, query }) => {
      await withPage(engine, viewport, async (page) => {
        await openPage(page, `${query}&username=${LONGEST_USERNAME}`);
        await page.getByText(LONGEST_USERNAME).waitFor({ timeout: LOAD_MS });
        await page.evaluate(async () => {
          await document.fonts.ready;
        });

        const fit = await page.evaluate((username) => {
          const value = [...document.querySelectorAll('span')].find(
            (span) => span.textContent === username
          );
          const row = value?.closest('[data-settings-row]');
          const title = row?.querySelector('[data-settings-title]');
          if (!value || !row || !title) throw new Error('the Username row is missing');
          const range = document.createRange();
          range.selectNodeContents(title);
          return {
            titleRight: range.getBoundingClientRect().right,
            valueLeft: value.getBoundingClientRect().left,
            valueRight: value.getBoundingClientRect().right,
            rowRight: row.getBoundingClientRect().right,
          };
        }, LONGEST_USERNAME);

        expect(fit.titleRight).toBeLessThanOrEqual(fit.valueLeft);
        expect(fit.valueRight).toBeLessThanOrEqual(fit.rowRight + FLUSH_EDGE_PX);
      });
    },
    TEST_MS
  );
});
