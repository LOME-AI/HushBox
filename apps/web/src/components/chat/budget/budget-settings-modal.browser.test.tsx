import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, firefox, type Browser, type Page } from '@playwright/test';
import { startFixtureServer, type FixtureServer } from '@/test-utils/fixture-server';
import type { Plugin } from 'vite';

/**
 * Lays the Budgets dialog out in real engines, under the app stylesheet and the accessibility
 * widget's text sizes. Two things only a layout engine settles: which words a screen reader is
 * given with each figure once the table's container query has run, and whether the names still
 * break between words when scaled text leaves the figures no room beside them.
 *
 * Chromium and Firefox, the engines CI installs, driven through `@playwright/test` over a fixture
 * server; the page, its entry and the modal's data hooks are virtual modules, so no fixture file
 * joins the tree.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, '../../../..');
const SRC_DIR = path.join(WEB_DIR, 'src');
const MODAL_FILE = path.join(HERE, 'budget-settings-modal.tsx');

const ENTRY_ID = 'virtual:budget-dialog-entry';
const BUDGETS_ID = 'virtual:budget-dialog-budgets';
const LINKS_ID = 'virtual:budget-dialog-links';
const MEMBERS_ID = 'virtual:budget-dialog-members';
const PAGE_PATH = '/budget-dialog.html';

/** The first load compiles the app's whole stylesheet, which a busy machine can make slow. */
const LOAD_MS = 90_000;
const READ_ALL_MS = 10 * LOAD_MS;
const CLOSE_MS = 45_000;

const PAGE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>budget dialog</title></head>
  <body>
    <div id="root"></div>
    <script type="module" src="/@id/${ENTRY_ID}"></script>
  </body>
</html>`;

const NANO_PER_CENT = 10_000_000n;
const nano = (cents: bigint): string => (cents * NANO_PER_CENT).toString();

/** Two account members and a named link can send; the owner is served every row. */
const OWNER_ROWS = [
  {
    memberId: 'mem-priya',
    userId: 'user-priya',
    username: 'priya_patel',
    privilege: 'admin',
    capNanoUsd: nano(500n),
    spentNanoUsd: nano(180n),
    effectiveRemainingNanoUsd: nano(320n),
  },
  {
    memberId: 'mem-marcus',
    userId: 'user-marcus',
    username: 'marcus_johnson',
    privilege: 'write',
    capNanoUsd: nano(2500n),
    spentNanoUsd: nano(800n),
    effectiveRemainingNanoUsd: nano(1700n),
  },
  {
    memberId: 'mem-link',
    userId: null,
    username: null,
    privilege: 'write',
    capNanoUsd: nano(500n),
    spentNanoUsd: nano(66n),
    effectiveRemainingNanoUsd: nano(434n),
  },
];

const ENTRY_SOURCE = `
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import '@/app.css';
import { BudgetSettingsModal } from ${JSON.stringify(MODAL_FILE)};

const viewer = new URLSearchParams(location.search).get('viewer');
const scale = new URLSearchParams(location.search).get('scale');
if (scale !== '100') document.documentElement.classList.add('a11y-font-scale-' + scale);
globalThis.__viewer = viewer;

createRoot(document.getElementById('root')).render(
  h(BudgetSettingsModal, {
    open: true,
    onOpenChange: () => {},
    conversationId: 'conv-1',
    currentUserPrivilege: viewer === 'owner' ? 'owner' : 'write',
  })
);

globalThis.__readNames = () => {
  const dialog = document.querySelector('[role="dialog"]');
  const table = dialog.querySelector('[role="group"][aria-label="Budgets"]');
  const dialogRect = dialog.getBoundingClientRect();
  const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const names = [...table.querySelectorAll('span')].filter(
    (span) => span.children.length === 0 && globalThis.__names.includes(span.textContent)
  );
  const split = [];
  const hidden = [];
  for (const name of names) {
    const rect = name.getBoundingClientRect();
    if (rect.width === 0 || name.scrollWidth > name.clientWidth + 1) hidden.push(name.textContent);
    const text = name.firstChild;
    let at = 0;
    for (const word of name.textContent.split(' ')) {
      const range = document.createRange();
      range.setStart(text, at);
      range.setEnd(text, at + word.length);
      const lines = new Set([...range.getClientRects()].map((r) => Math.round(r.top)));
      const wordWiderThanLine = range.getBoundingClientRect().width > rect.width + 0.5;
      if (lines.size > 1 && !wordWiderThanLine) split.push(word);
      at += word.length + 1;
    }
  }
  const overflowing = [...dialog.querySelectorAll('*')]
    .filter((element) => {
      const r = element.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      return r.right > dialogRect.right + 0.5 || r.left < dialogRect.left - 0.5;
    })
    .map((element) => element.tagName.toLowerCase() + ' ' + (element.textContent ?? '').slice(0, 30));
  return {
    found: names.map((name) => name.textContent),
    split,
    hidden,
    overflowing,
    pageScrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    tableRem: table.getBoundingClientRect().width / rootPx,
  };
};
`;

const BUDGETS_SOURCE = `
const OWNER_ROWS = ${JSON.stringify(OWNER_ROWS)};
function served() {
  const owner = globalThis.__viewer === 'owner';
  return {
    conversationCapNanoUsd: ${JSON.stringify(nano(10_000n))},
    conversationSpentNanoUsd: ${JSON.stringify(nano(1046n))},
    ownerBalanceNanoUsd: owner ? ${JSON.stringify(nano(50_000n))} : null,
    members: owner ? OWNER_ROWS : OWNER_ROWS.filter((row) => row.memberId === 'mem-marcus'),
  };
}
const mutation = { mutateAsync: async () => ({ updated: true }), isPending: false };
export function useConversationBudgets() { return { data: served(), isLoading: false }; }
export function useUpdateMemberBudget() { return mutation; }
export function useUpdateConversationBudget() { return mutation; }
`;

const LINKS_SOURCE = `
export function useConversationLinks() {
  return { data: { links: [{ id: 'link-1', displayName: 'Charlie Brightwater', privilege: 'write' }] } };
}
`;

const MEMBERS_SOURCE = `
export function useConversationMembers() {
  return { data: { members: [{ id: 'mem-link', linkId: 'link-1' }] } };
}
`;

/** Every name the owner's table draws, the conversation row included. */
const OWNER_NAMES = [
  'This conversation',
  'Priya Patel',
  'Marcus Johnson',
  'Charlie Brightwater',
] as const;

const VIRTUAL_SOURCES: Readonly<Record<string, string>> = {
  [ENTRY_ID]: `globalThis.__names = ${JSON.stringify(OWNER_NAMES)};\n${ENTRY_SOURCE}`,
  [BUDGETS_ID]: BUDGETS_SOURCE,
  [LINKS_ID]: LINKS_SOURCE,
  [MEMBERS_ID]: MEMBERS_SOURCE,
};

/**
 * The modal's data hooks, which would otherwise reach the API through the query client. Keyed
 * by the path the `@` alias has already resolved them to, since the alias runs first.
 */
const STUBBED_IMPORTS: Readonly<Record<string, string>> = {
  [path.join(SRC_DIR, 'hooks/billing/use-conversation-budgets.js')]: BUDGETS_ID,
  [path.join(SRC_DIR, 'hooks/realtime/use-conversation-links.js')]: LINKS_ID,
  [path.join(SRC_DIR, 'hooks/realtime/use-conversation-members.js')]: MEMBERS_ID,
};

function pageModules(): Plugin {
  return {
    name: 'budget-dialog-page',
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

interface NameReading {
  /** The names found in the table, so a reading that found none cannot pass. */
  found: string[];
  /** Words drawn across two lines although each fits on one. */
  split: string[];
  /** Names drawn with no width or clipped by their own box. */
  hidden: string[];
  /** Elements drawn past the dialog's edges. */
  overflowing: string[];
  pageScrolls: boolean;
  tableRem: number;
}

declare global {
  var __readNames: (() => NameReading) | undefined;
}

type EngineName = 'chromium' | 'firefox';
type Viewer = 'owner' | 'member';
const ENGINES: readonly EngineName[] = ['chromium', 'firefox'];
const LAUNCH: Readonly<Record<EngineName, () => Promise<Browser>>> = {
  chromium: () => chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] }),
  firefox: () => firefox.launch(),
};
const SCALES = ['100', '124', '141'] as const;
type Scale = (typeof SCALES)[number];
const NARROW_WIDTHS = [320, 390] as const;
/** 390 draws the table narrower than 24rem and 1440 wider, at the default text size. */
const NAMING_WIDTHS = { narrower: 390, wider: 1440 } as const;

/** Errors the page raised, so a table that never renders says why. */
const pageErrors: string[] = [];

interface View {
  viewer: Viewer;
  width: number;
  scale: Scale;
}

async function open(page: Page, origin: string, { viewer, width, scale }: View): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  const query = new URLSearchParams({ viewer, scale });
  await page.goto(`${origin}${PAGE_PATH}?${query.toString()}`, {
    waitUntil: 'commit',
    timeout: LOAD_MS,
  });
  try {
    await page
      .getByRole('group', { name: 'Budgets' })
      .waitFor({ state: 'visible', timeout: LOAD_MS });
  } catch (error) {
    const body = await page.evaluate(() => document.body.innerHTML.slice(0, 400));
    throw new Error(`the Budgets table did not render: ${pageErrors.join(' | ')} | ${body}`, {
      cause: error,
    });
  }
}

async function readNames(page: Page): Promise<NameReading> {
  const reading = await page.evaluate(() => globalThis.__readNames?.());
  if (reading === undefined) throw new Error('the budget dialog page did not load its reader');
  return reading;
}

async function readTableText(page: Page): Promise<{ text: string; tableRem: number }> {
  const text = await page.getByRole('group', { name: 'Budgets' }).ariaSnapshot();
  const { tableRem } = await readNames(page);
  return { text, tableRem };
}

describe.each(ENGINES)('the Budgets dialog on %s (real browser)', (engine) => {
  let server: FixtureServer;
  let browser: Browser;
  const wraps = new Map<string, NameReading>();
  const tables = new Map<string, { text: string; tableRem: number }>();

  beforeAll(async () => {
    server = await startFixtureServer({
      root: WEB_DIR,
      configFile: false,
      plugins: [pageModules(), react(), tailwindcss()],
      resolve: { alias: [{ find: /^@\/(.*)$/, replacement: path.join(SRC_DIR, '$1') }] },
      watch: null,
      closeBudgetMs: CLOSE_MS,
    });
    browser = await LAUNCH[engine]();
    const page = await browser.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') pageErrors.push(message.text());
    });
    for (const width of NARROW_WIDTHS) {
      for (const scale of SCALES) {
        await open(page, server.url, { viewer: 'owner', width, scale });
        wraps.set(`${String(width)} ${scale}`, await readNames(page));
      }
    }
    for (const viewer of ['owner', 'member'] as const) {
      for (const [side, width] of Object.entries(NAMING_WIDTHS)) {
        await open(page, server.url, { viewer, width, scale: '100' });
        tables.set(`${viewer} ${side}`, await readTableText(page));
      }
    }
    await page.close();
  }, READ_ALL_MS);

  // Closing the browser and the server can outlast the default hook budget on a busy machine.
  afterAll(async () => {
    await browser.close();
    await server.close();
  }, LOAD_MS);

  function wrapAt(width: number, scale: Scale): NameReading {
    const reading = wraps.get(`${String(width)} ${scale}`);
    if (reading === undefined) throw new Error(`no reading at ${String(width)} ${scale}`);
    return reading;
  }

  function tableFor(
    viewer: Viewer,
    side: keyof typeof NAMING_WIDTHS
  ): { text: string; tableRem: number } {
    const table = tables.get(`${viewer} ${side}`);
    if (table === undefined) throw new Error(`no table for ${viewer} ${side}`);
    return table;
  }

  describe.each(NARROW_WIDTHS)('%i wide', (width) => {
    describe.each(SCALES)('at %s percent text', (scale) => {
      it('draws every name', () => {
        const byName = (a: string, b: string): number => a.localeCompare(b);
        expect(wrapAt(width, scale).found.toSorted(byName)).toEqual(
          [...OWNER_NAMES].toSorted(byName)
        );
      });

      it('breaks names only between words', () => {
        expect(wrapAt(width, scale).split).toEqual([]);
      });

      it('hides no name', () => {
        expect(wrapAt(width, scale).hidden).toEqual([]);
      });

      it('draws nothing past the dialog or the page', () => {
        const reading = wrapAt(width, scale);
        expect(reading.overflowing).toEqual([]);
        expect(reading.pageScrolls).toBe(false);
      });
    });
  });

  describe.each(['narrower', 'wider'] as const)('with the table %s than 24rem', (side) => {
    it('lays the table out on that side of 24rem', () => {
      const { tableRem } = tableFor('owner', side);
      expect(side === 'wider' ? tableRem > 24 : tableRem < 24).toBe(true);
    });

    it('reads every spent figure with the word Spent, for the owner', () => {
      const { text } = tableFor('owner', side);
      expect(text).toContain('Spent $10.46');
      expect(text).toContain('Spent $1.80');
      expect(text).toContain('Spent $8.00');
      expect(text).toContain('Spent $0.66');
    });

    it('reads each budget and spent figure with its word, for a member', () => {
      const { text } = tableFor('member', side);
      expect(text).toContain('Budget $100.00');
      expect(text).toContain('Spent $10.46');
      expect(text).toContain('Budget $25.00');
      expect(text).toContain('Spent $8.00');
    });
  });
});
