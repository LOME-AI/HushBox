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
 * Lays the recovery phrase's word list out in real engines under the accessibility widget's
 * text settings, which change the words' face, size and letter spacing after the dialog opens.
 * The phrase is twelve real eight-letter words from the BIP39 list, the longest a phrase holds.
 *
 * Chromium and Firefox, driven by `@playwright/test` over a private dev server; the page, its
 * entry and the modal's key and crypto sources are virtual modules, so no fixture file joins
 * the tree.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, '../../..');
const SRC_DIR = path.join(WEB_DIR, 'src');
const MODAL_FILE = path.join(HERE, 'recovery-phrase-modal.tsx');
const FONT_LOADER_FILE = path.resolve(
  WEB_DIR,
  '../../packages/ui/src/components/accessibility/lib/font-loader.ts'
);

const ENTRY_ID = 'virtual:recovery-phrase-list-entry';
const AUTH_ID = 'virtual:recovery-phrase-list-auth';
const CRYPTO_ID = 'virtual:recovery-phrase-list-crypto';
const PLATFORM_ID = 'virtual:recovery-phrase-list-platform';

/** The first load compiles the app's whole stylesheet, which a busy machine can make slow. */
const LOAD_MS = 90_000;
const READ_ALL_MS = 10 * LOAD_MS;

const WORDS = [
  'mushroom',
  'remember',
  'tomorrow',
  'champion',
  'cinnamon',
  'december',
  'document',
  'marriage',
  'material',
  'mechanic',
  'midnight',
  'mosquito',
] as const;

const PAGE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>recovery phrase list</title></head>
  <body>
    <div id="root"></div>
    <script type="module" src="/@id/${ENTRY_ID}"></script>
  </body>
</html>`;

const ENTRY_SOURCE = `
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import '@/app.css';
import { activateFont } from ${JSON.stringify(FONT_LOADER_FILE)};
import { RecoveryPhraseModal } from ${JSON.stringify(MODAL_FILE)};

const SETTING_CLASSES = ['a11y-font-scale-141', 'a11y-letter-spacing-loosest'];

globalThis.__applySetting = async (setting) => {
  const html = document.documentElement;
  for (const name of SETTING_CLASSES) html.classList.remove(name);
  if (setting.text141) html.classList.add('a11y-font-scale-141');
  if (setting.loosest) html.classList.add('a11y-letter-spacing-loosest');
  await activateFont(setting.dyslexic ? 'open-dyslexic' : 'system');
  await document.fonts.ready;
};

globalThis.__readList = () => {
  const list = document.querySelector('ol[aria-label="Recovery phrase"]');
  const items = [...list.querySelectorAll('li')];
  const columns = new Set(items.map((item) => Math.round(item.getBoundingClientRect().left))).size;
  const split = [];
  const overflowing = [];
  for (const [index, item] of items.entries()) {
    const position = index + 1;
    const text = [...item.childNodes].find((node) => node.nodeType === Node.TEXT_NODE);
    const range = document.createRange();
    range.selectNodeContents(text);
    const lines = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top)));
    if (lines.size > 1) split.push(position);
    if (range.getBoundingClientRect().right > item.getBoundingClientRect().right + 0.5) {
      overflowing.push(position);
    }
  }
  return { columns, split, overflowing };
};

globalThis.__entranceEnded = async () => {
  await Promise.allSettled(document.getAnimations().map((animation) => animation.finished));
};

const opening = new URLSearchParams(location.search).get('setting');
if (opening !== null) await globalThis.__applySetting(JSON.parse(opening));

createRoot(document.getElementById('root')).render(
  h(RecoveryPhraseModal, { open: true, onOpenChange: () => {}, onSuccess: () => {} })
);
`;

const AUTH_SOURCE = `
const privateKey = new Uint8Array(32).fill(7);
export const useAuthStore = { getState: () => ({ privateKey }) };
export async function saveRecoveryMaterial() { return { success: true }; }
`;

const CRYPTO_SOURCE = `
export async function regenerateRecoveryPhrase() {
  return {
    recoveryPhrase: ${JSON.stringify(WORDS.join(' '))},
    recoveryWrappedPrivateKey: new Uint8Array([1]),
    recoveryPublicKey: new Uint8Array([2]),
  };
}
`;

const PLATFORM_SOURCE = `
export function getPlatform() { return 'web'; }
export function isNative() { return false; }
`;

const VIRTUAL_SOURCES: Readonly<Record<string, string>> = {
  [ENTRY_ID]: ENTRY_SOURCE,
  [AUTH_ID]: AUTH_SOURCE,
  [CRYPTO_ID]: CRYPTO_SOURCE,
  [PLATFORM_ID]: PLATFORM_SOURCE,
};

/** The modal's imports that reach the session, the key derivation and the build platform. */
const STUBBED_IMPORTS: Readonly<Record<string, string>> = {
  [path.join(SRC_DIR, 'lib/auth/auth')]: AUTH_ID,
  [path.join(SRC_DIR, 'capacitor/platform')]: PLATFORM_ID,
  '@hushbox/crypto': CRYPTO_ID,
};

function pageModules(): Plugin {
  return {
    name: 'recovery-phrase-list-page',
    enforce: 'pre',
    resolveId(id) {
      if (id in VIRTUAL_SOURCES) return `\0${id}`;
      const stub = STUBBED_IMPORTS[id];
      return stub === undefined ? undefined : `\0${stub}`;
    },
    load(id) {
      return id.startsWith('\0') ? VIRTUAL_SOURCES[id.slice(1)] : undefined;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = request.url;
        if (!url?.startsWith('/recovery-phrase-list.html')) {
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
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'recovery-phrase-list-vite-'));
  const server: ViteDevServer = await createServer({
    root: WEB_DIR,
    configFile: false,
    cacheDir,
    logLevel: 'error',
    plugins: [pageModules(), react(), tailwindcss()],
    resolve: { alias: [{ find: /^@\/(.*)$/, replacement: path.join(SRC_DIR, '$1') }] },
    server: { port: 0, host: '127.0.0.1', hmr: false },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (address === null || address === undefined || typeof address === 'string') {
    throw new Error('recovery phrase list server has no port');
  }
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    close: async () => {
      await server.close();
      await rm(cacheDir, { recursive: true, force: true });
    },
  };
}

interface Setting {
  name: string;
  text141: boolean;
  dyslexic: boolean;
  loosest: boolean;
}

interface ListReading {
  /** How many columns the list draws. */
  columns: number;
  /** The positions of words drawn on more than one line, so no word reaches a failure. */
  split: number[];
  /** The positions of words drawn past their own item's edge. */
  overflowing: number[];
}

declare global {
  var __applySetting: ((setting: Setting) => Promise<void>) | undefined;
  var __readList: (() => ListReading) | undefined;
  var __entranceEnded: (() => Promise<void>) | undefined;
}

type EngineName = 'chromium' | 'firefox';
const ENGINES: readonly EngineName[] = ['chromium', 'firefox'];
const WIDTHS = [320, 390, 767, 768, 1440] as const;
type Width = (typeof WIDTHS)[number];

const DEFAULT_TEXT: Setting = {
  name: 'default text',
  text141: false,
  dyslexic: false,
  loosest: false,
};
/** The setting that draws the widest words, so the one where the column floor decides. */
const WIDEST: Setting = {
  name: 'OpenDyslexic with loosest spacing',
  text141: false,
  dyslexic: true,
  loosest: true,
};
const SETTINGS: readonly Setting[] = [
  DEFAULT_TEXT,
  { name: '141% text', text141: true, dyslexic: false, loosest: false },
  { name: 'OpenDyslexic', text141: false, dyslexic: true, loosest: false },
  { name: 'loosest spacing', text141: false, dyslexic: false, loosest: true },
  WIDEST,
];

type Readings = Map<string, ListReading>;

function key(engine: EngineName, width: Width, setting: Setting, opened = false): string {
  return `${engine} ${String(width)} ${opened ? 'opened under ' : ''}${setting.name}`;
}

/** Opens the dialog at `width`, so it opens in that width's presentation, and reads every setting. */
async function readWidth(
  page: Page,
  origin: string,
  width: Width,
  record: (setting: Setting, reading: ListReading) => void
): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${origin}/recovery-phrase-list.html`, { waitUntil: 'commit', timeout: LOAD_MS });
  await page
    .getByRole('list', { name: 'Recovery phrase' })
    .waitFor({ state: 'visible', timeout: LOAD_MS });
  for (const setting of SETTINGS) {
    await page.evaluate(async (s) => {
      await globalThis.__applySetting?.(s);
    }, setting);
    const reading = await page.evaluate(() => globalThis.__readList?.());
    if (reading === undefined) throw new Error('the list page did not load its reader');
    record(setting, reading);
  }
}

/**
 * Opens the dialog at `width` with `setting` already applied, as a saved setting opens it, and
 * reads the list once its entrance has ended: nothing but the opening measures it.
 */
async function readOpenedUnder(
  page: Page,
  origin: string,
  width: Width,
  setting: Setting
): Promise<ListReading> {
  await page.setViewportSize({ width, height: 900 });
  const query = new URLSearchParams({ setting: JSON.stringify(setting) });
  await page.goto(`${origin}/recovery-phrase-list.html?${query.toString()}`, {
    waitUntil: 'commit',
    timeout: LOAD_MS,
  });
  await page
    .getByRole('list', { name: 'Recovery phrase' })
    .waitFor({ state: 'visible', timeout: LOAD_MS });
  const reading = await page.evaluate(async () => {
    await globalThis.__entranceEnded?.();
    return globalThis.__readList?.();
  });
  if (reading === undefined) throw new Error('the list page did not load its reader');
  return reading;
}

describe('recovery phrase word list (real browser)', () => {
  let server: { origin: string; close: () => Promise<void> };
  const browsers: Browser[] = [];
  const readings: Readings = new Map();

  beforeAll(async () => {
    server = await startServer();
    const launched = {
      chromium: await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] }),
      firefox: await firefox.launch(),
    };
    browsers.push(launched.chromium, launched.firefox);
    for (const engine of ENGINES) {
      const page = await launched[engine].newPage();
      for (const width of WIDTHS) {
        await readWidth(page, server.origin, width, (setting, reading) => {
          readings.set(key(engine, width, setting), reading);
        });
        readings.set(
          key(engine, width, WIDEST, true),
          await readOpenedUnder(page, server.origin, width, WIDEST)
        );
      }
      await page.close();
    }
  }, READ_ALL_MS);

  // Closing two browsers and the server can outlast the default hook budget on a busy machine.
  afterAll(async () => {
    await Promise.all(browsers.map((browser) => browser.close()));
    await server.close();
  }, LOAD_MS);

  function readingFor(
    engine: EngineName,
    width: Width,
    setting: Setting,
    opened = false
  ): ListReading {
    const reading = readings.get(key(engine, width, setting, opened));
    if (reading === undefined) {
      throw new Error(`no reading for ${key(engine, width, setting, opened)}`);
    }
    return reading;
  }

  describe.each(ENGINES)('on %s', (engine) => {
    describe.each(WIDTHS)('%i wide', (width) => {
      it.each(SETTINGS)('keeps every word on one line under $name', (setting) => {
        expect(readingFor(engine, width, setting).split).toEqual([]);
      });

      it.each(SETTINGS)('keeps every word inside its item under $name', (setting) => {
        expect(readingFor(engine, width, setting).overflowing).toEqual([]);
      });

      it(`draws ${width < 768 ? 'two' : 'three'} columns at default text`, () => {
        expect(readingFor(engine, width, DEFAULT_TEXT).columns).toBe(width < 768 ? 2 : 3);
      });

      it(`keeps every word on one line when the dialog opens under ${WIDEST.name}`, () => {
        expect(readingFor(engine, width, WIDEST, true).split).toEqual([]);
      });
    });
  });
});
