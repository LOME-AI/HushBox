import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, firefox, type Browser } from '@playwright/test';
import { TEST_IDS } from '@hushbox/shared';
import { TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { startFixtureServer, type FixtureServer } from '@/test-utils/fixture-server';

/**
 * Opens the share dialog in real engines under the app stylesheet and reads the sizes its
 * preview sets the reply at: the answer, the code, the gaps from the head to the reasoning and
 * from the reasoning to the answer, the head's rule, and how far the head sits inside the box. The preview's block gaps override the
 * segment list's block spacing, so a control also re-declares that spacing after the app
 * stylesheet, the order a reordered build would emit it in, and the preview must still win.
 * The dialog's two server hooks are stubbed with the catalog and an idle share, and the page
 * and its entry are virtual modules, so no fixture file joins the tree.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, '../../../..');
const SRC_DIR = path.join(WEB_DIR, 'src');
const MODAL_FILE = path.join(HERE, 'share-message-modal.tsx');
const THEME_FILE = path.join(SRC_DIR, 'providers', 'theme-provider.tsx');

const ENTRY_ID = 'virtual:share-message-modal-entry';
const MODELS_STUB_ID = 'virtual:share-message-modal-models';
const SHARE_STUB_ID = 'virtual:share-message-modal-share';
const PAGE_PATH = '/share-message-modal.html';

/** The first load compiles the app's whole stylesheet, which a busy machine can make slow. */
const LOAD_MS = 120_000;
const TEST_MS = LOAD_MS + 30_000;

const PAGE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>share message dialog</title></head>
  <body>
    <div id="root"></div>
    <script type="module" src="/@id/${ENTRY_ID}"></script>
  </body>
</html>`;

const MODELS_STUB = `
const DATA = {
  models: [{ id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', provider: 'Anthropic' }],
  premiumIds: new Set(),
};
export function useModels() {
  return { data: DATA };
}
`;

const SHARE_STUB = `
export function useMessageShare() {
  return { mutateAsync: () => new Promise(() => {}), isPending: false };
}
`;

// `late` re-declares the segment list's block spacing (its `BLOCK_SPACING.root` classes) in the
// utilities layer after the app stylesheet, as a build that emitted those utilities last would.
const ENTRY_SOURCE = `
import { StrictMode, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { serializeSegments } from '@hushbox/shared';
import '@/app.css';
import { ShareMessageModal } from ${JSON.stringify(MODAL_FILE)};
import { ThemeProvider } from ${JSON.stringify(THEME_FILE)};

const params = new URLSearchParams(location.search);
if (params.get('order') === 'late') {
  const style = document.createElement('style');
  style.textContent = [
    '@layer utilities {',
    '.mt-3 { margin-top: calc(var(--spacing) * 3); }',
    '.mb-1\\\\.5 { margin-bottom: calc(var(--spacing) * 1.5); }',
    '.first\\\\:mt-0:first-child { margin-top: calc(var(--spacing) * 0); }',
    '.first\\\\:mb-2\\\\.5:first-child { margin-bottom: calc(var(--spacing) * 2.5); }',
    '.last\\\\:mb-0:last-child { margin-bottom: calc(var(--spacing) * 0); }',
    '}',
  ].join('\\n');
  document.head.append(style);
}

const content = serializeSegments([
  { kind: 'reasoning', children: [{ kind: 'text', text: 'Each window borrows from the slice.' }] },
  { kind: 'text', text: 'The struct holds a borrowed slice.\\n\\n\`\`\`rust\\nlet window = &slice[..size];\\n\`\`\`' },
]);

createRoot(document.getElementById('root')).render(h(StrictMode, null,
  h(ThemeProvider, null,
    h(QueryClientProvider, { client: new QueryClient() },
      h(ShareMessageModal, {
        open: true,
        onOpenChange: () => {},
        conversationId: 'conv-1',
        message: {
          id: 'reply-1',
          content,
          modelName: 'anthropic/claude-sonnet-4.5',
          reasoningTokens: 860,
          reasoningEffort: 'medium',
          createdAt: ${JSON.stringify(isoAt(TEST_DAY_START))},
        },
      })))));

globalThis.__shareDialog = {
  ready: () =>
    document.fonts.status === 'loaded' &&
    document.querySelector('[data-streamdown="code-block-body"] pre') !== null &&
    document.querySelector('[data-reading] p') !== null,
  measure: () => {
    const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    const preview = document.querySelector(${JSON.stringify(`[data-testid="${TEST_IDS.shareMessagePreview}"]`)});
    if (preview === null) throw new TypeError('the dialog has no preview');
    const box = (selector) => {
      const found = preview.querySelector(selector);
      if (found === null) throw new TypeError('the preview has no ' + selector);
      return found;
    };
    const headRow = box(${JSON.stringify(`[data-testid="${TEST_IDS.modelNametagContainer}"]`)});
    const head = box('[data-slot="model-nameplate"]').getBoundingClientRect();
    const reasoning = box('[data-testid="thinking-disclosure"]').getBoundingClientRect();
    const prose = box('[data-reading] p');
    const inRem = (px) => Math.round((px / rem) * 1000) / 1000;
    return {
      prose: inRem(Number.parseFloat(getComputedStyle(prose).fontSize)),
      code: inRem(Number.parseFloat(getComputedStyle(box('[data-streamdown="code-block-body"] pre')).fontSize)),
      headToReasoning: inRem(reasoning.top - head.bottom),
      reasoningToProse: inRem(prose.getBoundingClientRect().top - reasoning.bottom),
      headRule: Number.parseFloat(getComputedStyle(headRow).borderBottomWidth),
      headInset: inRem(head.top - preview.getBoundingClientRect().top),
    };
  },
};
`;

const VIRTUAL_SOURCES: Readonly<Record<string, string>> = {
  [`\0${ENTRY_ID}`]: ENTRY_SOURCE,
  [`\0${MODELS_STUB_ID}`]: MODELS_STUB,
  [`\0${SHARE_STUB_ID}`]: SHARE_STUB,
};

/** The two hooks that reach the server, by the path they resolve to. */
const STUBBED_HOOKS: readonly (readonly [RegExp, string])[] = [
  [/hooks\/models\/models(\.js)?$/, MODELS_STUB_ID],
  [/hooks\/chat\/use-message-share(\.js)?$/, SHARE_STUB_ID],
];

function pageModules(): Plugin {
  return {
    name: 'share-message-modal-page',
    enforce: 'pre',
    resolveId(id) {
      if (id === ENTRY_ID) return `\0${id}`;
      const stub = STUBBED_HOOKS.find(([pattern]) => pattern.test(id));
      return stub === undefined ? undefined : `\0${stub[1]}`;
    },
    load(id) {
      return VIRTUAL_SOURCES[id];
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

/** The sizes in rem of the page's root size, and the head rule's width in pixels. */
interface Scale {
  readonly prose: number;
  readonly code: number;
  readonly headToReasoning: number;
  readonly reasoningToProse: number;
  readonly headRule: number;
  readonly headInset: number;
}

declare global {
  var __shareDialog: { ready: () => boolean; measure: () => Scale } | undefined;
}

type EngineName = 'chromium' | 'firefox';
const ENGINES: readonly EngineName[] = ['chromium', 'firefox'];

/**
 * The preview's scale, a step below the thread: 0.9375rem answer text, 0.75rem code, 0.5rem
 * between the head, the reasoning and the answer, no head rule, and the head 1.25rem inside
 * the box, where the dialog has always set it.
 */
const PREVIEW_SCALE: Scale = {
  prose: 0.9375,
  code: 0.75,
  headToReasoning: 0.5,
  reasoningToProse: 0.5,
  headRule: 0,
  headInset: 1.25,
};

/** Each reading to a hundredth, under a fifth of a pixel for the rem sizes, so rounding never fails a case. */
function hundredths(scale: Scale): Scale {
  const round = (value: number): number => Math.round(value * 100) / 100;
  return {
    prose: round(scale.prose),
    code: round(scale.code),
    headToReasoning: round(scale.headToReasoning),
    reasoningToProse: round(scale.reasoningToProse),
    headRule: round(scale.headRule),
    headInset: round(scale.headInset),
  };
}

describe('the share dialog preview scale (real browser)', () => {
  let server: FixtureServer;
  const browsers: Partial<Record<EngineName, Browser>> = {};

  beforeAll(async () => {
    server = await startFixtureServer({
      root: WEB_DIR,
      configFile: false,
      plugins: [pageModules(), react(), tailwindcss()],
      resolve: { alias: [{ find: /^@\/(.*)$/, replacement: path.join(SRC_DIR, '$1') }] },
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

  async function readOn(engine: EngineName, query: Readonly<{ order?: 'late' }>): Promise<Scale> {
    const browser = browsers[engine];
    if (browser === undefined) throw new Error(`${engine} did not launch`);
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(`${server.url}${PAGE_PATH}?${new URLSearchParams(query).toString()}`, {
        waitUntil: 'commit',
        timeout: LOAD_MS,
      });
      await page.waitForFunction(() => globalThis.__shareDialog?.ready() === true, undefined, {
        timeout: LOAD_MS,
      });
      return await page.evaluate(() => {
        if (globalThis.__shareDialog === undefined) throw new TypeError('the page is not ready');
        return globalThis.__shareDialog.measure();
      });
    } finally {
      await page.close();
    }
  }

  describe.each(ENGINES)('on %s', (engine) => {
    it(
      'sets the preview at its compact scale',
      async () => {
        expect(hundredths(await readOn(engine, {}))).toEqual(hundredths(PREVIEW_SCALE));
      },
      TEST_MS
    );

    it(
      'keeps the preview scale when the block spacing is emitted after it',
      async () => {
        expect(hundredths(await readOn(engine, { order: 'late' }))).toEqual(
          hundredths(PREVIEW_SCALE)
        );
      },
      TEST_MS
    );
  });
});
