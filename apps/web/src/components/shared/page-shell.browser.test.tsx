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
 * Measures the shell's header in real engines, which lay out the wrap that no test DOM
 * does: a phone-width header whose centre holds the branch switcher (hidden there) against
 * the same header with an empty centre, at the 141% text size the accessibility widget sets. The page and its entry are virtual
 * modules, so no fixture file joins the tree.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, '../../..');
const SRC_DIR = path.join(WEB_DIR, 'src');
const SHELL_FILE = path.join(HERE, 'page-shell.tsx');
const HEADER_FILE = path.join(HERE, 'page-header.tsx');
const SWITCHER_FILE = path.join(SRC_DIR, 'components/chat/layout/branch-switcher.tsx');
const BADGE_FILE = path.join(HERE, 'encryption-badge.tsx');
const FACEPILE_FILE = path.join(SRC_DIR, 'components/chat/member/member-facepile.tsx');

const ENTRY_ID = 'virtual:page-shell-header-entry';

/** The first load compiles the app's whole stylesheet, which a busy machine can make slow. */
const LOAD_MS = 90_000;
const TEST_MS = LOAD_MS + 30_000;
/** The furthest two header heights may differ and still be one layout, for subpixel rounding. */
const HEIGHT_PX = 1;
/** A phone width, at which the switcher's trigger is hidden but its slot is still filled. */
const PHONE_WIDTH_PX = 320;

const PAGE_HTML = `<!doctype html>
<html lang="en" class="a11y-font-scale-141">
  <head><meta charset="UTF-8" /><title>page shell header</title></head>
  <body>
    <div id="root"></div>
    <script type="module" src="/@id/${ENTRY_ID}"></script>
  </body>
</html>`;

// Each sample is one shell; `data-sample` names whether its centre holds the switcher.
const ENTRY_SOURCE = `
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import '@/app.css';
import { ThemeProvider } from '@/providers/theme-provider';
import { PageShell } from ${JSON.stringify(SHELL_FILE)};
import { PageHeader } from ${JSON.stringify(HEADER_FILE)};
import { BranchSwitcher } from ${JSON.stringify(SWITCHER_FILE)};
import { EncryptionBadge } from ${JSON.stringify(BADGE_FILE)};
import { MemberFacepile } from ${JSON.stringify(FACEPILE_FILE)};

const BRANCHES = [
  { forkId: 'main', name: 'Main', firstMessage: '', forkPointOrdinal: 2, forkPointId: 'a1' },
  { forkId: 'f1', name: 'SQL version', firstMessage: '', forkPointOrdinal: 2, forkPointId: 'a1' },
];
const noop = () => {};

function sample(name, branched) {
  return h('div', { key: name, 'data-sample': name },
    h(PageShell, null,
      h(PageHeader, {
        title: 'Two CRMs exported our contacts',
        shield: h(EncryptionBadge, { isAuthenticated: true }),
        facepile: h(MemberFacepile, {
          members: [{ id: 'm1', userId: 'u1', username: 'sarah' }],
          onlineMemberIds: new Set(),
          onFacepileClick: noop,
        }),
        center: branched
          ? h(BranchSwitcher, { branches: BRANCHES, currentForkId: 'f1', onSelect: noop, onRename: noop, onDelete: noop })
          : undefined,
      })));
}

createRoot(document.getElementById('root')).render(
  h(ThemeProvider, null, h('div', null, sample('branched', true), sample('unbranched', false))));
globalThis.__pageShellReady = true;
`;

function pageModules(): Plugin {
  return {
    name: 'page-shell-header-page',
    resolveId(id) {
      return id === ENTRY_ID ? `\0${id}` : undefined;
    },
    load(id) {
      return id === `\0${ENTRY_ID}` ? ENTRY_SOURCE : undefined;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = request.url;
        if (!url?.startsWith('/page-shell-header.html')) {
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
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'page-shell-header-vite-'));
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
    throw new Error('page shell header server has no port');
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
  var __pageShellReady: boolean | undefined;
}

async function headerHeight(page: Page, sample: string): Promise<number> {
  return page.evaluate((name) => {
    const header = document.querySelector(`[data-sample="${name}"] header`);
    if (!(header instanceof HTMLElement)) throw new TypeError(`sample ${name} has no header`);
    return header.getBoundingClientRect().height;
  }, sample);
}

type EngineName = 'chromium' | 'firefox';
const ENGINES: readonly EngineName[] = ['chromium', 'firefox'];

describe('page shell header at large text (real browser)', () => {
  let server: { origin: string; close: () => Promise<void> };
  const browsers: Partial<Record<EngineName, Browser>> = {};
  const pages: Partial<Record<EngineName, Page>> = {};

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
      const page = await browser.newPage({ viewport: { width: PHONE_WIDTH_PX, height: 800 } });
      await page.goto(`${server.origin}/page-shell-header.html`, {
        waitUntil: 'commit',
        timeout: LOAD_MS,
      });
      await page.waitForFunction(() => globalThis.__pageShellReady === true, undefined, {
        timeout: LOAD_MS,
      });
      await page.waitForFunction(
        () =>
          document.querySelector('[data-sample="branched"] [data-page-slot="center"] button') !==
          null,
        undefined,
        { timeout: LOAD_MS }
      );
      await page.evaluate(() => document.fonts.ready);
      pages[engine] = page;
    }
  }, TEST_MS * 2);

  afterAll(async () => {
    await Promise.all(Object.values(browsers).map((browser) => browser.close()));
    await server.close();
  }, TEST_MS);

  it.each(ENGINES)(
    'keeps a branched phone header at large text as tall as an unbranched one in %s',
    async (engine) => {
      const page = pages[engine];
      if (page === undefined) throw new Error(`${engine} has no page`);
      const branched = await headerHeight(page, 'branched');
      const unbranched = await headerHeight(page, 'unbranched');
      expect(Math.abs(branched - unbranched)).toBeLessThanOrEqual(HEIGHT_PX);
    },
    TEST_MS
  );
});
