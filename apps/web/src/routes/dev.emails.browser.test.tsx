import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Plugin, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium, type Browser, type Frame, type Page } from '@playwright/test';
import { TEST_ID_BUILDERS } from '@hushbox/shared';
import { EMAIL_LIGHT_SCHEME_CONDITION, EMAIL_PALETTE } from '@hushbox/shared/design-tokens';

/**
 * Proves in a real engine that the email gallery shows each scheme in its own frame. An
 * email document laid out as the email renderer lays out its schemes (the dark palette
 * inline, the light palette under the shared light-scheme condition) is served to the real
 * gallery route; each frame's canvas and heading colours are then read from inside it.
 *
 * Chromium only: it is the engine that ignores an iframe's `color-scheme` for
 * `prefers-color-scheme` inside the frame, which is why the page pins the scheme at all.
 * `@vitest/browser` is not installed, so this drives `@playwright/test` from Vitest over a
 * private dev server, as `auth-frame.browser.test.ts` does. The page, its entry and the
 * seams it replaces are virtual modules below, so no fixture file joins the tree.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, '../..');
const SRC_DIR = path.join(WEB_DIR, 'src');
const ROUTE_FILE = path.join(HERE, 'dev.emails.tsx');

const EMAIL_NAME = 'password-changed';
const EMAIL_LABEL = 'Password Changed';

const DARK = EMAIL_PALETTE.dark;
const LIGHT = EMAIL_PALETTE.light;

/** The dark palette inline and the light palette under the light-scheme condition, as mail carries them. */
const EMAIL_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta name="color-scheme" content="dark light">
<style>
${EMAIL_LIGHT_SCHEME_CONDITION} {
  .canvas { background-color: ${LIGHT.canvas} !important; }
  .heading { color: ${LIGHT.text} !important; }
}
</style>
</head>
<body class="canvas" style="margin:0;background-color:${DARK.canvas};">
<h1 class="heading" style="color:${DARK.text};">Your password was changed</h1>
</body>
</html>`;

const ENTRY_ID = 'virtual:dev-emails-gallery-entry';
const CLIENT_ID = 'virtual:dev-emails-gallery-client';
const ENV_ID = 'virtual:dev-emails-gallery-env';

/** The first load transforms the route's whole import graph, which a busy machine can make slow. */
const LOAD_MS = 90_000;
const TEST_MS = LOAD_MS + 30_000;

const PAGE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>email gallery</title></head>
  <body>
    <div id="root"></div>
    <script type="module" src="/@id/${ENTRY_ID}"></script>
  </body>
</html>`;

/** Mounts the route under a memory router whose location is this page's query string. */
const ENTRY_SOURCE = `
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from '@tanstack/react-router';
import { Route } from ${JSON.stringify(ROUTE_FILE)};

globalThis.__devEmailTemplates = [
  { name: ${JSON.stringify(EMAIL_NAME)}, label: ${JSON.stringify(EMAIL_LABEL)}, html: ${JSON.stringify(EMAIL_HTML)} },
];

const rootRoute = createRootRoute();
const galleryRoute = Route.update({
  id: '/dev/emails',
  path: '/dev/emails',
  getParentRoute: () => rootRoute,
});
const router = createRouter({
  routeTree: rootRoute.addChildren([galleryRoute]),
  history: createMemoryHistory({ initialEntries: ['/dev/emails' + location.search] }),
});
createRoot(document.getElementById('root')).render(
  createElement(QueryClientProvider, { client: new QueryClient() }, createElement(RouterProvider, { router })),
);
`;

/** The typed client's seam: the gallery's one read answers with the rendered email. */
const CLIENT_SOURCE = `
export const client = { dev: { emails: { $get: () => undefined } } };
export async function fetchJson() {
  return { templates: globalThis.__devEmailTemplates };
}
`;

const ENV_SOURCE = `export const env = { isDev: true };`;

function galleryModules(): Plugin {
  const sources = new Map([
    [ENTRY_ID, ENTRY_SOURCE],
    [CLIENT_ID, CLIENT_SOURCE],
    [ENV_ID, ENV_SOURCE],
  ]);
  return {
    name: 'dev-emails-gallery',
    resolveId(id) {
      return sources.has(id) ? `\0${id}` : undefined;
    },
    load(id) {
      return id.startsWith('\0') ? sources.get(id.slice(1)) : undefined;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = request.url;
        if (!url?.startsWith('/gallery.html')) {
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
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'dev-emails-vite-'));
  const server: ViteDevServer = await createServer({
    root: WEB_DIR,
    configFile: false,
    cacheDir,
    logLevel: 'error',
    plugins: [react(), galleryModules()],
    resolve: {
      alias: [
        { find: /^@\/lib\/api-client\.js$/, replacement: CLIENT_ID },
        { find: /^@\/lib\/platform\/env$/, replacement: ENV_ID },
        { find: /^@\/(.*)$/, replacement: path.join(SRC_DIR, '$1') },
      ],
    },
    server: { port: 0, host: '127.0.0.1', hmr: false },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (address === null || address === undefined || typeof address === 'string') {
    throw new Error('email gallery server has no port');
  }
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    close: async () => {
      await server.close();
      await rm(cacheDir, { recursive: true, force: true });
    },
  };
}

type Scheme = 'dark' | 'light';

interface FrameColours {
  canvas: string;
  heading: string;
}

function rgb(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgb(${String((value >> 16) & 255)}, ${String((value >> 8) & 255)}, ${String(value & 255)})`;
}

function expected(scheme: Scheme): FrameColours {
  return { canvas: rgb(EMAIL_PALETTE[scheme].canvas), heading: rgb(EMAIL_PALETTE[scheme].text) };
}

async function readColours(frame: Frame): Promise<FrameColours> {
  await frame.waitForLoadState('load');
  return frame.evaluate(() => {
    const heading = document.querySelector('h1');
    if (heading === null) throw new Error('the email has no heading');
    return {
      canvas: getComputedStyle(document.body).backgroundColor,
      heading: getComputedStyle(heading).color,
    };
  });
}

async function frameOf(page: Page, scheme: Scheme): Promise<Frame> {
  const handle = await page
    .getByTestId(TEST_ID_BUILDERS.emailSchemeIframe(EMAIL_NAME, scheme))
    .elementHandle({ timeout: LOAD_MS });
  const frame = await handle?.contentFrame();
  if (frame === null || frame === undefined) throw new Error(`no ${scheme} frame`);
  return frame;
}

describe('email gallery schemes (real browser)', () => {
  let server: { origin: string; close: () => Promise<void> };
  let browser: Browser | undefined;

  beforeAll(async () => {
    server = await startServer();
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await server.close();
  });

  async function open(preference: Scheme, query: string): Promise<Page> {
    if (browser === undefined) throw new Error('chromium did not launch');
    const context = await browser.newContext({ colorScheme: preference });
    const page = await context.newPage();
    await page.goto(`${server.origin}/gallery.html${query}`, {
      waitUntil: 'commit',
      timeout: LOAD_MS,
    });
    return page;
  }

  /**
   * The control: the same email, unpinned, follows the browser's preference, so reading a
   * frame's colours does reach the light rules.
   */
  it.each(['dark', 'light'] as const)(
    'shows the unpinned email in the colours of a %s preference',
    async (preference) => {
      const page = await open(preference, '');
      try {
        await frameOf(page, 'dark');
        await page.evaluate((html) => {
          const frame = document.createElement('iframe');
          frame.id = 'control';
          frame.setAttribute('sandbox', '');
          frame.srcdoc = html;
          document.body.replaceChildren(frame);
        }, EMAIL_HTML);
        const controlHandle = await page.locator('#control').elementHandle();
        const control = await controlHandle?.contentFrame();
        if (control === null || control === undefined) throw new Error('no control frame');
        expect(await readColours(control)).toEqual(expected(preference));
      } finally {
        await page.context().close();
      }
    },
    TEST_MS
  );

  describe.each(['dark', 'light'] as const)('under a %s browser preference', (preference) => {
    it.each(['dark', 'light'] as const)(
      "paints the gallery's %s frame in that scheme's colours",
      async (scheme) => {
        const page = await open(preference, '');
        try {
          expect(await readColours(await frameOf(page, scheme))).toEqual(expected(scheme));
        } finally {
          await page.context().close();
        }
      },
      TEST_MS
    );

    it.each(['dark', 'light'] as const)(
      'shows the %s full view alone, in that scheme',
      async (scheme) => {
        const page = await open(preference, `?view=${EMAIL_NAME}&scheme=${scheme}`);
        try {
          const frame = await frameOf(page, scheme);
          expect(await readColours(frame)).toEqual(expected(scheme));
          const frames = page.locator('iframe');
          expect(await frames.count()).toBe(1);
        } finally {
          await page.context().close();
        }
      },
      TEST_MS
    );
  });
});
