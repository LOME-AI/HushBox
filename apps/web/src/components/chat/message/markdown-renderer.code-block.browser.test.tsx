import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, firefox, type Browser } from '@playwright/test';
import { startFixtureServer, type FixtureServer } from '@/test-utils/fixture-server';

/**
 * Renders a reply's fenced code block through the real markdown renderer, under the app
 * stylesheet in a real engine, and records the block's height from the commit that first
 * draws it until its syntax highlighting has landed. A thread row measures its reply on
 * that first commit, so any later change to the block's height moves the thread. The page
 * and its entry are virtual modules, so no fixture file joins the tree.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, '../../../..');
const SRC_DIR = path.join(WEB_DIR, 'src');
const RENDERER_FILE = path.join(HERE, 'markdown-renderer.tsx');

const ENTRY_ID = 'virtual:markdown-code-block-entry';
const PAGE_PATH = '/markdown-code-block.html';

/** The first load compiles the app's whole stylesheet, which a busy machine can make slow. */
const LOAD_MS = 120_000;
const TEST_MS = LOAD_MS + 30_000;

const PAGE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>markdown code block</title></head>
  <body>
    <div id="root"></div>
    <script type="module" src="/@id/${ENTRY_ID}"></script>
  </body>
</html>`;

// `shape` picks the fence's code; `below` puts the reply under three screens of spacing, as a
// row Virtuoso draws before it scrolls the thread into place. The first height is read in the
// commit that draws the block, before the highlighter can have answered; a ResizeObserver
// records every height after it.
const ENTRY_SOURCE = `
import { createElement as h } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import '@/app.css';
import { MarkdownRenderer } from ${JSON.stringify(RENDERER_FILE)};

const params = new URLSearchParams(location.search);
const below = params.get('below') === 'true';
const SHAPES = {
  'one-line': 'const total = 1;',
  'multi-line': 'export function total(items: number[]): number {\\n  let sum = 0;\\n  for (const item of items) sum += item;\\n  return sum;\\n}',
  'long-line': 'const message = "' + 'a line that runs well past the edge of the frame '.repeat(8) + '";',
};
const content = 'Call it like this:\\n\\n\`\`\`ts\\n' + SHAPES[params.get('shape')] + '\\n\`\`\`\\n\\nThat is all.';

const frame = () => document.querySelector('[data-testid="markdown-renderer"] .not-prose');
const highlighted = () =>
  document.querySelector('[data-streamdown="code-block-body"] code span[style*="--code-token"]') !== null;
const heights = [];
const root = createRoot(document.getElementById('root'));
flushSync(() => {
  root.render(h('div', null,
    below ? h('div', { style: { height: window.innerHeight * 3 + 'px' } }) : null,
    h(MarkdownRenderer, { content })));
});
const drawn = frame();
const highlightedAtFirstDraw = highlighted();
heights.push(drawn.getBoundingClientRect().height);
new ResizeObserver(() => {
  heights.push(drawn.getBoundingClientRect().height);
}).observe(drawn);
if (below) drawn.scrollIntoView({ block: 'end' });

globalThis.__codeBlock = {
  highlighted,
  // Two frames, so a resize the highlight causes has been observed.
  settle: () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  read: () => ({ highlightedAtFirstDraw, heights: [...heights], settled: drawn.getBoundingClientRect().height }),
};
`;

function pageModules(): Plugin {
  return {
    name: 'markdown-code-block-page',
    enforce: 'pre',
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

/** Every height the block took, from its first draw, and its height once highlighted. */
interface BlockHeights {
  readonly highlightedAtFirstDraw: boolean;
  readonly heights: readonly number[];
  readonly settled: number;
}

declare global {
  var __codeBlock:
    | { highlighted: () => boolean; settle: () => Promise<void>; read: () => BlockHeights }
    | undefined;
}

type EngineName = 'chromium' | 'firefox';
const ENGINES: readonly EngineName[] = ['chromium', 'firefox'];
const SHAPES = ['one-line', 'multi-line', 'long-line'] as const;
const WIDTHS = [375, 1440] as const;

describe('a reply code block before its highlighting (real browser)', () => {
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

  async function heightsOn(
    engine: EngineName,
    query: Readonly<{ shape: (typeof SHAPES)[number]; width: number; below: boolean }>
  ): Promise<BlockHeights> {
    const browser = browsers[engine];
    if (browser === undefined) throw new Error(`${engine} did not launch`);
    const page = await browser.newPage({ viewport: { width: query.width, height: 800 } });
    try {
      const search = new URLSearchParams({ shape: query.shape, below: String(query.below) });
      await page.goto(`${server.url}${PAGE_PATH}?${search.toString()}`, { timeout: LOAD_MS });
      await page.waitForFunction(() => globalThis.__codeBlock?.highlighted() === true, undefined, {
        timeout: LOAD_MS,
      });
      return await page.evaluate(async () => {
        if (globalThis.__codeBlock === undefined) throw new TypeError('the page is not ready');
        await globalThis.__codeBlock.settle();
        return globalThis.__codeBlock.read();
      });
    } finally {
      await page.close();
    }
  }

  function expectOneHeight(block: BlockHeights): void {
    expect(block.highlightedAtFirstDraw).toBe(false);
    expect(block.heights).toEqual(block.heights.map(() => block.settled));
  }

  describe.each(ENGINES)('on %s', (engine) => {
    describe.each(WIDTHS)('at %dpx', (width) => {
      it.each(SHAPES)(
        'draws a %s block at its highlighted height before the highlight arrives',
        async (shape) => {
          expectOneHeight(await heightsOn(engine, { shape, width, below: false }));
        },
        TEST_MS
      );

      it(
        'draws a block below the fold at its highlighted height before it scrolls into view',
        async () => {
          expectOneHeight(await heightsOn(engine, { shape: 'multi-line', width, below: true }));
        },
        TEST_MS
      );
    });
  });
});
