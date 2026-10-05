import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, firefox, type Browser, type Page } from '@playwright/test';
import { startFixtureServer, type FixtureServer } from '@/test-utils/fixture-server';

/**
 * Measures the open branch switcher in real engines, which lay out the row that no test DOM
 * does: the popover held to 304px by its boundary, as the docked sidebar holds it at 768 with
 * 141% text, and the current row's name beside its icon, check, Rename and Delete. A touch
 * pointer is read in each engine's touch emulation, which reaches the `pointer: coarse` media
 * query. At 1440 it reads where focus lands when the switcher, opened from the thread's fork mark,
 * closes; at a phone width, where the header trigger is not drawn, where it lands when a rename or
 * delete dialog opened from the switcher is cancelled. The page and its entry are virtual modules,
 * so no fixture file joins the tree.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, '../../../..');
const SRC_DIR = path.join(WEB_DIR, 'src');
const SWITCHER_FILE = path.join(HERE, 'branch-switcher.tsx');
const FORK_MARK_FILE = path.join(HERE, 'fork-mark.tsx');

const ENTRY_ID = 'virtual:branch-switcher-narrow-entry';

/** The first load compiles the app's whole stylesheet, which a busy machine can make slow. */
const LOAD_MS = 90_000;
const TEST_MS = LOAD_MS + 30_000;
/** The popover width the finding was measured at. */
const POPOVER_PX = 304;
/** The room the popover keeps from each edge of its boundary, so the boundary is 2 of these wider. */
const COLLISION_PADDING_PX = 16;
/** Subpixel layout allowance for widths read back from the engine. */
const LAYOUT_PX = 1;
/** The smallest touch target the coarse-pointer layout may draw: 2.75rem at the default root. */
const TOUCH_TARGET_PX = 44;

const PAGE_HTML = `<!doctype html>
<html lang="en" class="a11y-font-scale-141">
  <head><meta charset="UTF-8" /><title>branch switcher</title></head>
  <body>
    <div id="root"></div>
    <script type="module" src="/@id/${ENTRY_ID}"></script>
  </body>
</html>`;

const ENTRY_SOURCE = `
import { createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@/app.css';
import { BranchSwitcher } from ${JSON.stringify(SWITCHER_FILE)};
import { ForkMark } from ${JSON.stringify(FORK_MARK_FILE)};
import { RenameConversationDialog } from '@/components/sidebar/rename-conversation-dialog';
import { DeleteConversationDialog } from '@/components/sidebar/delete-conversation-dialog';

const BRANCHES = [
  { forkId: 'main', name: 'Main', firstMessage: 'Show me the Python for that, keeping the most recently updated row.', forkPointOrdinal: 2, forkPointId: 'a1' },
  { forkId: 'f1', name: 'Standard library only', firstMessage: 'Same thing without pandas, just the csv module.', forkPointOrdinal: 2, forkPointId: 'a1' },
];
const noop = () => {};

function Page() {
  const [boundary, setBoundary] = useState(null);
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [value, setValue] = useState('');
  return h('div', null,
    h('div', {
        ref: setBoundary,
        style: { width: '${String(POPOVER_PX + 2 * COLLISION_PADDING_PX)}px', height: '760px' },
      },
      h(BranchSwitcher, { branches: BRANCHES, currentForkId: 'f1', boundary, open, onOpenChange: setOpen, onSelect: noop,
        onRename: (_id, name) => { setValue(name); setRenaming(true); },
        onDelete: () => setDeleting(true) })),
    h(ForkMark, { more: 1, onOpen: () => setOpen(true) }),
    h(RenameConversationDialog, { open: renaming, onOpenChange: setRenaming, value, onValueChange: setValue, onConfirm: () => Promise.resolve() }),
    h(DeleteConversationDialog, { open: deleting, onOpenChange: setDeleting, title: 'Main', onConfirm: () => Promise.resolve() }));
}

createRoot(document.getElementById('root')).render(h(Page));
globalThis.__branchSwitcherReady = true;
`;

function pageModules(): Plugin {
  return {
    name: 'branch-switcher-narrow-page',
    resolveId(id) {
      return id === ENTRY_ID ? `\0${id}` : undefined;
    },
    load(id) {
      return id === `\0${ENTRY_ID}` ? ENTRY_SOURCE : undefined;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = request.url;
        if (!url?.startsWith('/branch-switcher.html')) {
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
  var __branchSwitcherReady: boolean | undefined;
}

interface ControlReading {
  /** The control's accessible name, as its label or its labelling element gives it. */
  name: string;
  /** Whether its box lies inside the popover's and has room to be pressed. */
  inside: boolean;
  topPx: number;
  widthPx: number;
  heightPx: number;
}

interface NarrowReading {
  /** Whether the page matched `pointer: coarse`, so a touch reading measured the touch layout. */
  coarse: boolean;
  popoverPx: number;
  /** The bottom edge of the current row's name. */
  nameBottomPx: number;
  /** The current row's name, as wide as it is drawn. */
  nameShownPx: number;
  /**
   * The current row's name cut after its first word: the word and the ellipsis truncation draws
   * after it, in the name's own font.
   */
  firstWordCutPx: number;
  controls: ControlReading[];
}

async function readNarrow(page: Page): Promise<NarrowReading> {
  return page.evaluate(() => {
    const menu = document.querySelector('[data-testid="branch-switcher-menu"]');
    if (!(menu instanceof HTMLElement)) throw new TypeError('the switcher is not open');
    const menuBox = menu.getBoundingClientRect();
    const current = menu.querySelector('[aria-current="true"]');
    const nameId = current?.getAttribute('aria-labelledby') ?? '';
    const name = menu.querySelector(`#${CSS.escape(nameId)}`);
    const text = name?.firstChild;
    if (!(name instanceof HTMLElement) || !(text instanceof Text)) {
      throw new TypeError('the current row has no name');
    }
    const content = text.data;
    const space = content.indexOf(' ');
    const cut = document.createElement('span');
    cut.textContent = `${content.slice(0, space > 0 ? space : content.length)}\u2026`;
    const font = getComputedStyle(name);
    cut.style.font = font.font;
    cut.style.letterSpacing = font.letterSpacing;
    cut.style.position = 'absolute';
    cut.style.whiteSpace = 'pre';
    cut.style.visibility = 'hidden';
    document.body.append(cut);
    const firstWordCutPx = cut.getBoundingClientRect().width;
    cut.remove();
    const controls = [...menu.querySelectorAll('button')].map((button) => {
      const box = button.getBoundingClientRect();
      const labelledBy = button.getAttribute('aria-labelledby');
      const label = labelledBy === null ? null : menu.querySelector(`#${CSS.escape(labelledBy)}`);
      return {
        name: (button.getAttribute('aria-label') ?? label?.textContent ?? '').trim(),
        topPx: box.top,
        widthPx: box.width,
        heightPx: box.height,
        inside:
          box.width > 0 &&
          box.left >= menuBox.left - 1 &&
          box.right <= menuBox.right + 1 &&
          box.top >= menuBox.top - 1 &&
          box.bottom <= menuBox.bottom + 1,
      };
    });
    const nameBox = name.getBoundingClientRect();
    return {
      coarse: matchMedia('(pointer: coarse)').matches,
      popoverPx: menuBox.width,
      nameBottomPx: nameBox.bottom,
      nameShownPx: nameBox.width,
      firstWordCutPx,
      controls,
    };
  });
}

type EngineName = 'chromium' | 'firefox';
type DialogAction = 'Rename' | 'Delete';
const DIALOG_ACTIONS: readonly { action: DialogAction; title: string }[] = [
  { action: 'Rename', title: 'Rename conversation' },
  { action: 'Delete', title: 'Delete conversation?' },
];

/**
 * Resolves once every finite animation on the page has ended, finished or cancelled, so focus has
 * settled where it lands; an endlessly repeating one never ends and is not waited on.
 */
async function settled(): Promise<void> {
  await Promise.allSettled(
    document
      .getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
      .map((animation) => animation.finished)
  );
}

/**
 * At 1440: opens the switcher from the fork mark, closes it with Escape, and reads the accessible
 * text of what then holds focus.
 */
async function readFocusAfterClose(browser: Browser, url: string): Promise<string | null> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(url, { waitUntil: 'commit', timeout: LOAD_MS });
  await page.waitForFunction(() => globalThis.__branchSwitcherReady === true, undefined, {
    timeout: LOAD_MS,
  });
  await page.getByRole('button', { name: /^Branched here/ }).focus({ timeout: LOAD_MS });
  await page.keyboard.press('Enter');
  const menu = page.getByTestId('branch-switcher-menu');
  await menu.waitFor({ timeout: LOAD_MS });
  await page.evaluate(settled);
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached', timeout: LOAD_MS });
  const focused = await page.evaluate(() => document.activeElement?.textContent.trim() ?? null);
  await page.close();
  return focused;
}

/**
 * At a phone width: opens the switcher from the fork mark, opens the named row action's dialog
 * for Main, cancels it, and reads the accessible text of what then holds focus.
 */
async function readDialogHandBack(
  browser: Browser,
  url: string,
  action: DialogAction,
  title: string
): Promise<string | null> {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(url, { waitUntil: 'commit', timeout: LOAD_MS });
  await page.waitForFunction(() => globalThis.__branchSwitcherReady === true, undefined, {
    timeout: LOAD_MS,
  });
  await page.getByRole('button', { name: /^Branched here/ }).focus({ timeout: LOAD_MS });
  await page.keyboard.press('Enter');
  const menu = page.getByTestId('branch-switcher-menu');
  await menu.waitFor({ timeout: LOAD_MS });
  await page.evaluate(settled);
  await menu.getByRole('button', { name: `${action} Main`, exact: true }).focus();
  await page.keyboard.press('Enter');
  const dialogTitle = page.getByText(title, { exact: true });
  await dialogTitle.waitFor({ timeout: LOAD_MS });
  await page.evaluate(settled);
  await page.keyboard.press('Escape');
  await dialogTitle.waitFor({ state: 'detached', timeout: LOAD_MS });
  await page.evaluate(settled);
  const focused = await page.evaluate(() => document.activeElement?.textContent.trim() ?? null);
  await page.close();
  return focused;
}
const ENGINES: readonly EngineName[] = ['chromium', 'firefox'];
/** An engine under touch emulation. */
type TouchKey = 'chromium touch' | 'firefox touch';
const TOUCH_KEYS: readonly TouchKey[] = ['chromium touch', 'firefox touch'];
/** A reading's key: an engine with a mouse, or under touch emulation. */
type ReadingKey = EngineName | TouchKey;
const SETUPS: readonly { key: ReadingKey; engine: EngineName; hasTouch: boolean }[] = [
  { key: 'chromium', engine: 'chromium', hasTouch: false },
  { key: 'firefox', engine: 'firefox', hasTouch: false },
  { key: 'chromium touch', engine: 'chromium', hasTouch: true },
  { key: 'firefox touch', engine: 'firefox', hasTouch: true },
];
const CURRENT_ROW_ACTIONS = new Set([
  'Rename Standard library only',
  'Delete Standard library only',
]);

describe('branch switcher in a narrow popover at large text (real browser)', () => {
  let server: FixtureServer;
  const browsers: Partial<Record<EngineName, Browser>> = {};
  const readings: Partial<Record<ReadingKey, NarrowReading>> = {};
  /** The accessible name of what holds focus once the switcher opened from the mark closes. */
  const focusAfterClose: Partial<Record<EngineName, string | null>> = {};
  /** Below 768: what holds focus once a dialog opened from the mark-opened switcher is cancelled. */
  const focusAfterDialog: Partial<Record<`${EngineName} ${DialogAction}`, string | null>> = {};

  function launched(engine: EngineName): Browser {
    const browser = browsers[engine];
    if (browser === undefined) throw new Error(`${engine} did not launch`);
    return browser;
  }

  beforeAll(
    async () => {
      server = await startFixtureServer({
        root: WEB_DIR,
        configFile: false,
        plugins: [react(), tailwindcss(), pageModules()],
        resolve: { alias: [{ find: /^@\/(.*)$/, replacement: path.join(SRC_DIR, '$1') }] },
      });
      const [chromiumBrowser, firefoxBrowser] = await Promise.all([
        chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] }),
        firefox.launch(),
      ]);
      browsers.chromium = chromiumBrowser;
      browsers.firefox = firefoxBrowser;
      for (const { key, engine, hasTouch } of SETUPS) {
        const page = await launched(engine).newPage({
          viewport: { width: 1024, height: 900 },
          hasTouch,
        });
        await page.goto(`${server.url}/branch-switcher.html`, {
          waitUntil: 'commit',
          timeout: LOAD_MS,
        });
        await page.waitForFunction(() => globalThis.__branchSwitcherReady === true, undefined, {
          timeout: LOAD_MS,
        });
        await page.evaluate(() => document.fonts.ready);
        await page.getByTestId('branch-switcher').click({ timeout: LOAD_MS });
        await page.getByTestId('branch-switcher-menu').waitFor({ timeout: LOAD_MS });
        // The popover opens with a zoom from 95%, so a read before it ends measures a shrunken box.
        await page
          .getByTestId('branch-switcher-menu')
          .evaluate((menu) =>
            Promise.all(
              menu.getAnimations({ subtree: true }).map((animation) => animation.finished)
            )
          );
        readings[key] = await readNarrow(page);
        await page.close();
      }
      for (const engine of ENGINES) {
        const browser = launched(engine);
        focusAfterClose[engine] = await readFocusAfterClose(
          browser,
          `${server.url}/branch-switcher.html`
        );
        for (const { action, title } of DIALOG_ACTIONS) {
          focusAfterDialog[`${engine} ${action}`] = await readDialogHandBack(
            browser,
            `${server.url}/branch-switcher.html`,
            action,
            title
          );
        }
      }
    },
    TEST_MS * (SETUPS.length + ENGINES.length * (1 + DIALOG_ACTIONS.length))
  );

  afterAll(async () => {
    await Promise.all(Object.values(browsers).map((browser) => browser.close()));
    await server.close();
  }, TEST_MS);

  function reading(key: ReadingKey): NarrowReading {
    const value = readings[key];
    if (value === undefined) throw new Error(`${key} has no reading`);
    return value;
  }

  function currentRowActions(key: ReadingKey): ControlReading[] {
    return reading(key).controls.filter((control) => CURRENT_ROW_ACTIONS.has(control.name));
  }

  it.each(ENGINES)('hands a cancelled rename back to the fork mark below 768 in %s', (engine) => {
    expect(focusAfterDialog[`${engine} Rename`]).toBe('Branched here · 1 more');
  });

  it.each(ENGINES)('hands a cancelled delete back to the fork mark below 768 in %s', (engine) => {
    expect(focusAfterDialog[`${engine} Delete`]).toBe('Branched here · 1 more');
  });

  it.each(ENGINES)('returns focus to the fork mark that opened it in %s', (engine) => {
    expect(focusAfterClose[engine]).toBe('Branched here · 1 more');
  });

  it.each(ENGINES)('holds the popover to the narrow width under test in %s', (engine) => {
    const { popoverPx } = reading(engine);
    expect(popoverPx).toBeGreaterThanOrEqual(POPOVER_PX - LAYOUT_PX);
    expect(popoverPx).toBeLessThanOrEqual(POPOVER_PX + LAYOUT_PX);
  });

  it.each(ENGINES)('keeps the current branch name to at least its first word in %s', (engine) => {
    const { nameShownPx, firstWordCutPx } = reading(engine);
    expect(nameShownPx).toBeGreaterThanOrEqual(firstWordCutPx - LAYOUT_PX);
  });

  it.each(ENGINES)('keeps every row control inside the popover in %s', (engine) => {
    expect(reading(engine).controls.filter((control) => !control.inside)).toEqual([]);
  });

  it.each(ENGINES)('keeps every row control named in %s', (engine) => {
    expect(reading(engine).controls.map((control) => control.name)).toEqual([
      'Main',
      'Rename Main',
      'Delete Main',
      'Standard library only',
      'Rename Standard library only',
      'Delete Standard library only',
    ]);
  });

  describe('under a touch pointer', () => {
    it.each(TOUCH_KEYS)('matches the coarse pointer the touch layout is for in %s', (key) => {
      expect(reading(key).coarse).toBe(true);
    });

    it.each(TOUCH_KEYS)('holds the popover to the narrow width under test in %s', (key) => {
      const { popoverPx } = reading(key);
      expect(popoverPx).toBeGreaterThanOrEqual(POPOVER_PX - LAYOUT_PX);
      expect(popoverPx).toBeLessThanOrEqual(POPOVER_PX + LAYOUT_PX);
    });

    it.each(TOUCH_KEYS)('keeps the current branch name to at least its first word in %s', (key) => {
      const { nameShownPx, firstWordCutPx } = reading(key);
      expect(nameShownPx).toBeGreaterThanOrEqual(firstWordCutPx - LAYOUT_PX);
    });

    it.each(TOUCH_KEYS)('sets Rename and Delete below the current branch name in %s', (key) => {
      const { nameBottomPx } = reading(key);
      expect(
        currentRowActions(key).map((control) => [
          control.name,
          control.topPx >= nameBottomPx - LAYOUT_PX,
        ])
      ).toEqual([...CURRENT_ROW_ACTIONS].map((name) => [name, true]));
    });

    it.each(TOUCH_KEYS)('keeps Rename and Delete at touch size in %s', (key) => {
      expect(
        currentRowActions(key).map((control) => [
          control.name,
          Math.min(control.widthPx, control.heightPx) >= TOUCH_TARGET_PX,
        ])
      ).toEqual([...CURRENT_ROW_ACTIONS].map((name) => [name, true]));
    });

    it.each(TOUCH_KEYS)('keeps every row control inside the popover in %s', (key) => {
      expect(reading(key).controls.filter((control) => !control.inside)).toEqual([]);
    });

    it.each(TOUCH_KEYS)('keeps every row control named in %s', (key) => {
      expect(reading(key).controls.map((control) => control.name)).toEqual([
        'Main',
        'Rename Main',
        'Delete Main',
        'Standard library only',
        'Rename Standard library only',
        'Delete Standard library only',
      ]);
    });
  });
});
