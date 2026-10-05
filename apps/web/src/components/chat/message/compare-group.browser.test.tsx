import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, firefox, type Browser, type Page } from '@playwright/test';
import { TEST_IDS } from '@hushbox/shared';
import { TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { startFixtureServer, type FixtureServer } from '@/test-utils/fixture-server';

/**
 * Lays a compare group out in real engines under the app stylesheet, at widths given to the
 * group itself rather than to the viewport, and reads which replies show, how the columns
 * fall into rows, which columns draw a divider, and the size the prose is set at. The page
 * and its entry are virtual modules, so no fixture file joins the tree.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, '../../../..');
const SRC_DIR = path.join(WEB_DIR, 'src');
const GROUP_FILE = path.join(HERE, 'compare-group.tsx');
const ITEM_FILE = path.join(HERE, 'message-item.tsx');

const ENTRY_ID = 'virtual:compare-group-entry';
const PAGE_PATH = '/compare-group.html';

/** The first load compiles the app's whole stylesheet, which a busy machine can make slow. */
const LOAD_MS = 120_000;
const TEST_MS = LOAD_MS + 30_000;

const PAGE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>compare group</title></head>
  <body>
    <div id="root"></div>
    <script type="module" src="/@id/${ENTRY_ID}"></script>
  </body>
</html>`;

// By default each reply stands in for the thread's row: a root at the side padding the group
// asks for, and prose set at the base size plus the text scale the group asks for. With
// \`rows=thread\` each reply is the thread's own row, drawn as the group asks it to.
const ENTRY_SOURCE = `
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@/app.css';
import { CompareGroup } from ${JSON.stringify(GROUP_FILE)};

const params = new URLSearchParams(location.search);
const count = Number(params.get('count'));
// The group's own gutters sit outside the width under test.
const width = params.get('width') + 'rem + 3rem';
const messages = Array.from({ length: count }, (_, index) => ({
  id: 'reply-' + index,
  conversationId: 'conv-1',
  role: 'assistant',
  // With the thread's own rows the first answer runs longer than the rest, so the columns of
  // a row hold answers of different lengths.
  content: 'Answer ' + index + (params.get('rows') === 'thread' && index === 0
    ? ' that runs on, and on, across several lines of the column it sits in.'.repeat(6)
    : ''),
  createdAt: ${JSON.stringify(isoAt(TEST_DAY_START))},
  parentMessageId: 'question',
  modelName: 'vendor/model-' + index,
  cost: '6100000',
}));

const threadRows = params.get('rows') === 'thread';
// With \`actions=send\` the viewer can send: the group offers Continue, each reply offers every
// control, and the catalog offers each reply's model.
const sendable = params.get('actions') === 'send';
const { MessageItem } = threadRows ? await import(${JSON.stringify(ITEM_FILE)}) : {};
const ignore = () => {};
const replies = messages.map((message) => ({
  message,
  render: (compare) => threadRows
    ? h(MessageItem, sendable
        ? { message, allowedActions: new Set(['copy', 'regenerate', 'fork', 'share']), compare,
            onRegenerate: ignore, onFork: ignore, onShare: ignore }
        : { message, allowedActions: new Set(['copy']), compare })
    : h('div', { className: compare.sidePadding },
        h('p', { className: 'text-base ' + compare.textScale }, message.content)),
}));
const models = sendable
  ? messages.map((message, index) => ({
      id: message.modelName, name: 'Model ' + index, provider: 'Vendor', modality: 'text',
    }))
  : [];

createRoot(document.getElementById('root')).render(
  h(QueryClientProvider, { client: new QueryClient() },
    h('div', { style: { width: 'calc(' + width + ')' } },
      h(CompareGroup, { replies, models, canSend: sendable }))));

globalThis.__compareGroup = {
  // The strip's fade follows a measurement taken after the first paint.
  ready: () => document.querySelector('[role="tablist"]') !== null && document.fonts.status === 'loaded',
  measure: () => {
    const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    const shown = (element) => getComputedStyle(element).display !== 'none';
    const columns = [...document.querySelectorAll('[role="tabpanel"]')];
    const visible = columns.filter(shown);
    const rows = [];
    let top;
    for (const column of visible) {
      const at = Math.round(column.getBoundingClientRect().top);
      if (at === top) rows[rows.length - 1] += 1;
      else rows.push(1);
      top = at;
    }
    const tablist = document.querySelector('[role="tablist"]');
    const first = visible[0];
    return {
      tabs: shown(tablist),
      faded: getComputedStyle(tablist).maskImage !== 'none',
      shown: columns.map(shown),
      rows,
      dividers: visible.map((column) => getComputedStyle(column, '::before').display !== 'none'),
      proseRem: Number.parseFloat(getComputedStyle(first.querySelector('p')).fontSize) / rem,
      tabCostColors: [...tablist.querySelectorAll('[role="tab"]')].map(
        (tab) => getComputedStyle(tab.querySelector('.font-mono')).color
      ),
      ...(sendable && (() => {
        const box = (element) => {
          const rect = element.getBoundingClientRect();
          return { left: Math.round(rect.left), right: Math.round(rect.right),
            top: Math.round(rect.top), bottom: Math.round(rect.bottom) };
        };
        const cont = first.querySelector(${JSON.stringify(`[data-testid="${TEST_IDS.continueWithModel}"]`)});
        const icons = [...first.querySelectorAll(${JSON.stringify(`[data-testid="${TEST_IDS.messageActions}"] button`)})];
        return {
          controlRow: {
            column: box(first),
            cost: box(first.querySelector(${JSON.stringify(`[data-testid="${TEST_IDS.messageCost}"]`)})),
            continue: box(cont),
            firstIcon: box(icons[0]),
            lastIcon: box(icons.at(-1)),
          },
        };
      })()),
      ...(threadRows && (() => {
        const row = getComputedStyle(first.querySelector('[data-testid="message-item"]').parentElement);
        const answer = first.querySelector('[data-testid="ai-message-live-region"]');
        const footerOf = (column) =>
          column.querySelector('[data-testid="message-cost"]').closest('[data-chrome]');
        const firstRowTop = Math.round(visible[0].getBoundingClientRect().top);
        const firstRow = visible.filter((column) => Math.round(column.getBoundingClientRect().top) === firstRowTop);
        const secondRow = visible.filter((column) => Math.round(column.getBoundingClientRect().top) !== firstRowTop);
        // A row ends where its lowest footer does: the column below it should start 2.5rem on.
        const firstRowBottom = Math.max(...firstRow.map((column) => footerOf(column).getBoundingClientRect().bottom));
        return {
          rowPaddingPx: Number.parseFloat(row.paddingLeft) + Number.parseFloat(row.paddingRight),
          answerRem: Number.parseFloat(getComputedStyle(answer).fontSize) / rem,
          footerTops: firstRow.map((column) => Math.round(footerOf(column).getBoundingClientRect().top)),
          // Adding 0 turns a rounded -0 into 0, which strict equality tells apart.
          footerToColumnEndPx: visible.map((column) =>
            Math.round(column.getBoundingClientRect().bottom - footerOf(column).getBoundingClientRect().bottom) + 0),
          rowGapRem: secondRow.length === 0 ? null
            : Math.round(((secondRow[0].getBoundingClientRect().top - firstRowBottom) / rem) * 1000) / 1000,
        };
      })()),
    };
  },
};
`;

function pageModules(): Plugin {
  return {
    name: 'compare-group-page',
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

interface Layout {
  readonly tabs: boolean;
  readonly faded: boolean;
  /** Whether each reply's column is drawn, in reply order. */
  readonly shown: readonly boolean[];
  /** How many drawn columns share each row, top to bottom. */
  readonly rows: readonly number[];
  /** Whether each drawn column draws its divider, in reply order. */
  readonly dividers: readonly boolean[];
  readonly proseRem: number;
  /** With the thread's own rows: the row's left and right padding together. */
  readonly rowPaddingPx?: number;
  /** With the thread's own rows: the answer's font size. */
  readonly answerRem?: number;
  /** The computed colour of each tab's cost, in tab order. */
  readonly tabCostColors: readonly string[];
  /** With the thread's own rows: the top of each footer in the first row of columns. */
  readonly footerTops?: readonly number[];
  /** With the thread's own rows: the space between each column's footer and its end. */
  readonly footerToColumnEndPx?: readonly number[];
  /** With the thread's own rows: the space from the first row's footers to the second row. */
  readonly rowGapRem?: number | null;
  /** With a viewer who can send: where the first shown reply's footer sets each part. */
  readonly controlRow?: ControlRow;
}

interface Box {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

interface ControlRow {
  readonly column: Box;
  readonly cost: Box;
  readonly continue: Box;
  readonly firstIcon: Box;
  readonly lastIcon: Box;
}

declare global {
  var __compareGroup: { ready: () => boolean; measure: () => Layout } | undefined;
}

function controlRowOf(layout: Layout): ControlRow {
  if (layout.controlRow === undefined) throw new Error('the page measured no control row');
  return layout.controlRow;
}

function middle(box: Box): number {
  return (box.top + box.bottom) / 2;
}

type EngineName = 'chromium' | 'firefox';
const ENGINES: readonly EngineName[] = ['chromium', 'firefox'];

describe('the compare group layout (real browser)', () => {
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

  async function openOn(
    engine: EngineName,
    query: Readonly<{ width: string; count: string; rows?: 'thread'; actions?: 'send' }>
  ): Promise<Page> {
    const browser = browsers[engine];
    if (browser === undefined) throw new Error(`${engine} did not launch`);
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`${server.url}${PAGE_PATH}?${new URLSearchParams(query).toString()}`, {
      waitUntil: 'commit',
      timeout: LOAD_MS,
    });
    await page.waitForFunction(() => globalThis.__compareGroup?.ready() === true, undefined, {
      timeout: LOAD_MS,
    });
    return page;
  }

  async function measure(page: Page): Promise<Layout> {
    return page.evaluate(() => {
      if (globalThis.__compareGroup === undefined) throw new TypeError('the page is not ready');
      return globalThis.__compareGroup.measure();
    });
  }

  async function layoutOn(
    engine: EngineName,
    query: Readonly<{ width: string; count: string; rows?: 'thread'; actions?: 'send' }>
  ): Promise<Layout> {
    const page = await openOn(engine, query);
    try {
      return await measure(page);
    } finally {
      await page.close();
    }
  }

  describe.each(ENGINES)('on %s', (engine) => {
    it(
      'shows tabs and one reply below 38rem',
      async () => {
        const layout = await layoutOn(engine, { width: '37.5', count: '3' });
        expect(layout.tabs).toBe(true);
        expect(layout.shown).toEqual([true, false, false]);
        expect(layout.dividers).toEqual([false]);
      },
      TEST_MS
    );

    it(
      "sets the thread's own reply flush in its column, its answer a step below the thread",
      async () => {
        const layout = await layoutOn(engine, { width: '40', count: '2', rows: 'thread' });
        expect(layout.rowPaddingPx).toBe(0);
        expect(layout.answerRem).toBe(0.9375);
      },
      TEST_MS
    );

    it(
      'sets the footers of a row of uneven answers on one line',
      async () => {
        const layout = await layoutOn(engine, { width: '60', count: '5', rows: 'thread' });
        expect(new Set(layout.footerTops).size).toBe(1);
      },
      TEST_MS
    );

    it(
      'ends each column at its footer',
      async () => {
        const layout = await layoutOn(engine, { width: '60', count: '5', rows: 'thread' });
        expect(layout.footerToColumnEndPx).toEqual([0, 0, 0, 0, 0]);
      },
      TEST_MS
    );

    it(
      "spaces a row's footers 2.5rem above the next row",
      async () => {
        const layout = await layoutOn(engine, { width: '60', count: '5', rows: 'thread' });
        expect(layout.rowGapRem).toBe(2.5);
      },
      TEST_MS
    );

    it(
      "keeps a selected tab's cost as muted as the others'",
      async () => {
        const layout = await layoutOn(engine, { width: '30', count: '3' });
        expect(new Set(layout.tabCostColors).size).toBe(1);
      },
      TEST_MS
    );

    it(
      'shows the reply whose tab is pressed',
      async () => {
        const page = await openOn(engine, { width: '30', count: '3' });
        try {
          await page.getByRole('tab').nth(2).click();
          const layout = await measure(page);
          expect(layout.shown).toEqual([false, false, true]);
        } finally {
          await page.close();
        }
      },
      TEST_MS
    );

    it(
      'keeps the thread scale while showing tabs',
      async () => {
        const layout = await layoutOn(engine, { width: '30', count: '3' });
        expect(layout.proseRem).toBe(1);
      },
      TEST_MS
    );

    it(
      'shows columns two across from 38rem, with a divider before the second',
      async () => {
        const layout = await layoutOn(engine, { width: '38', count: '3' });
        expect(layout.tabs).toBe(false);
        expect(layout.rows).toEqual([2, 1]);
        expect(layout.dividers).toEqual([false, true, false]);
      },
      TEST_MS
    );

    it(
      'sets column prose a step below the thread',
      async () => {
        const layout = await layoutOn(engine, { width: '40', count: '3' });
        expect(layout.proseRem).toBe(0.9375);
      },
      TEST_MS
    );

    it(
      'shows three across from 58rem, with a divider before each but the first',
      async () => {
        const layout = await layoutOn(engine, { width: '58', count: '3' });
        expect(layout.rows).toEqual([3]);
        expect(layout.dividers).toEqual([false, true, true]);
      },
      TEST_MS
    );

    it(
      'sets four replies two by two at three-across widths',
      async () => {
        const layout = await layoutOn(engine, { width: '60', count: '4' });
        expect(layout.rows).toEqual([2, 2]);
        expect(layout.dividers).toEqual([false, true, false, true]);
      },
      TEST_MS
    );

    it(
      'sets five replies three and two',
      async () => {
        const layout = await layoutOn(engine, { width: '60', count: '5' });
        expect(layout.rows).toEqual([3, 2]);
        expect(layout.dividers).toEqual([false, true, true, false, true]);
      },
      TEST_MS
    );

    it(
      "sets Continue on the cost's line where the control row has room",
      async () => {
        const layout = await layoutOn(engine, {
          width: '37',
          count: '3',
          rows: 'thread',
          actions: 'send',
        });
        const row = controlRowOf(layout);
        expect(row.continue.left).toBeGreaterThan(row.cost.right);
        expect(Math.abs(middle(row.continue) - middle(row.cost))).toBeLessThanOrEqual(1);
      },
      TEST_MS
    );

    it(
      'spans the column under the cost once the control row wraps, Continue at the cost edge',
      async () => {
        const layout = await layoutOn(engine, {
          width: '68',
          count: '3',
          rows: 'thread',
          actions: 'send',
        });
        const row = controlRowOf(layout);
        expect(row.continue.top).toBeGreaterThanOrEqual(row.cost.bottom);
        expect(row.continue.left).toBe(row.cost.left);
        expect(row.lastIcon.right).toBe(row.column.right);
        expect(Math.abs(middle(row.firstIcon) - middle(row.continue))).toBeLessThanOrEqual(1);
      },
      TEST_MS
    );

    it(
      'gives Continue a line of its own in a phone-wide group, above the controls',
      async () => {
        const layout = await layoutOn(engine, {
          width: '18',
          count: '3',
          rows: 'thread',
          actions: 'send',
        });
        const row = controlRowOf(layout);
        expect(row.continue.left).toBe(row.column.left);
        expect(row.continue.right).toBe(row.column.right);
        expect(row.firstIcon.top).toBeGreaterThanOrEqual(row.continue.bottom);
      },
      TEST_MS
    );

    it(
      'fades a strip of five tabs',
      async () => {
        const layout = await layoutOn(engine, { width: '30', count: '5' });
        expect(layout.faded).toBe(true);
      },
      TEST_MS
    );

    it(
      'draws no fade on a strip whose tabs all fit',
      async () => {
        const layout = await layoutOn(engine, { width: '30', count: '3' });
        expect(layout.faded).toBe(false);
      },
      TEST_MS
    );

    it(
      'fades a strip of three tabs too wide for it',
      async () => {
        const layout = await layoutOn(engine, { width: '18', count: '3' });
        expect(layout.faded).toBe(true);
      },
      TEST_MS
    );
  });
});
