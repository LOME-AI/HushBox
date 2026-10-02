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
 * Measures the button groups in real engines: a group's widths come from percentages the
 * browser resolves against the group, which no test DOM lays out. The page mounts the kit
 * section under the app stylesheet, beside a static group built from the published class
 * string and measure alone, as a static page builds one.
 *
 * Chromium and Firefox, the engines CI installs. `@vitest/browser` is not installed, so
 * this drives `@playwright/test` over a private dev server, as `dev.emails.browser.test.tsx`
 * does; the page and its entry are virtual modules, so no fixture file joins the tree.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, '../../../..');
const SRC_DIR = path.join(WEB_DIR, 'src');
const SECTION_FILE = path.join(HERE, 'button-groups.section.tsx');

const ENTRY_ID = 'virtual:button-groups-entry';

/** The auth column's width at a 390 and a 320 viewport. */
const NARROW_SPACES_PX = [294, 224] as const;
const NARROW_SIZES = ['xl', 'default'] as const;
const LONG_LABEL = 'Resend verification email (60s)';
/** One word wider than the narrowest space at the largest text. */
const UNBREAKABLE_LABEL = 'Supercalifragilisticexpialidocious';

/** A phone's viewport, where the bottom sheet stacks its rows. */
const PHONE_VIEWPORT = { width: 320, height: 800 } as const;

/** The first load compiles the app's whole stylesheet, which a busy machine can make slow. */
const LOAD_MS = 90_000;
const TEST_MS = LOAD_MS + 30_000;
/** Layout rounding a measured width may carry. */
const TOLERANCE_PX = 1.5;

const PAGE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>button groups</title></head>
  <body>
    <div id="root"></div>
    <div id="static" class="w-[50rem]"></div>
    <div id="narrow"></div>
    <div id="phone"></div>
    <div id="phone-static" style="padding-inline:1.5rem"><div data-phone-row="static"></div></div>
    <div id="wide-phone" style="width:390px"></div>
    <div id="crowd-phone" style="width:320px"></div>
    <div id="crowd-wide-phone" style="width:390px"></div>
    <div id="wide-groups"></div>
    <div id="resizable" style="width:300px"></div>
    <script type="module" src="/@id/${ENTRY_ID}"></script>
  </body>
</html>`;

const ENTRY_SOURCE = `
import { createElement } from 'react';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@/app.css';
import { Button, ButtonRow, ButtonStack, buttonVariants } from '@hushbox/ui/button';
import { ArrowUpRight, Copy, Download, Icon } from '@hushbox/ui/icons';
import { buttonRowClass, measureButtonGroups } from '@hushbox/ui/button-groups';
import { ToggleGroup, ToggleGroupItem } from '@hushbox/ui/field';
import section from ${JSON.stringify(SECTION_FILE)};

const staticSpace = document.getElementById('static');
staticSpace.innerHTML =
  '<div class="' + buttonRowClass + '">' +
  '<button class="' + buttonVariants({ variant: 'outline' }) + '">Not now</button>' +
  '<button class="' + buttonVariants({}) + '">Continue with a passkey on this device</button>' +
  '</div>';
measureButtonGroups(document.getElementById('static'));

// Lone block buttons in the auth column's widths at 390 and 320, drawn as a static page draws them.
document.getElementById('narrow').innerHTML = ${JSON.stringify(NARROW_SPACES_PX)}
  .map((width) =>
    ${JSON.stringify(NARROW_SIZES)}
      .map((size) =>
        '<div data-narrow-space="' + width + '-' + size + '" style="width:' + width + 'px">' +
        '<button data-block class="' + buttonVariants({ size }) + '">' + ${JSON.stringify(LONG_LABEL)} + '</button>' +
        '</div>'
      )
      .join('')
  )
  .join('') +
  '<div data-narrow-space="224-word" style="width:224px">' +
  '<button data-block class="' + buttonVariants({}) + '">' + ${JSON.stringify(UNBREAKABLE_LABEL)} + '</button>' +
  '</div>';

createRoot(document.getElementById('root')).render(createElement('div', null, section.render()));

// A child component that renders its own button and takes no props from the row.
function Proceed() {
  return createElement(Button, null, "I've written it down");
}

// The recovery phrase steps' rows and a stack, inset by the bottom sheet's side padding.
createRoot(document.getElementById('phone')).render(
  createElement('div', { style: { paddingInline: '1.5rem' } },
    createElement('div', { 'data-phone-row': 'save' },
      createElement(ButtonRow, null,
        createElement(Button, { variant: 'outline' }, createElement(Icon, { icon: Copy }), 'Copy'),
        createElement(Button, { variant: 'outline' }, createElement(Icon, { icon: Download }), 'Download .txt'))),
    createElement('div', { 'data-phone-row': 'footer' },
      createElement(ButtonRow, null,
        createElement(Button, { variant: 'outline' }, 'Cancel'),
        createElement(Button, null, "I've written it down"))),
    createElement('div', { 'data-phone-row': 'wrapper' },
      createElement(ButtonRow, null,
        createElement(Button, { variant: 'outline' }, 'Cancel'),
        createElement(Proceed))),
    createElement('div', { 'data-phone-row': 'lone' },
      createElement(ButtonRow, null,
        createElement(Button, { loading: false, loadingLabel: 'Saving...' }, 'Replace recovery phrase'))),
    createElement('div', { 'data-phone-row': 'stack' },
      createElement(ButtonStack, null,
        createElement(Button, { variant: 'outline' }, 'Cancel'),
        createElement(Button, null, "I've written it down")))));

// The recovery step's footer in a 390px phone's bottom sheet, where it sits side by side.
createRoot(document.getElementById('wide-phone')).render(
  createElement('div', { style: { paddingInline: '1.5rem' } },
    createElement('div', { 'data-wide-row': 'footer' },
      createElement(ButtonRow, null,
        createElement(Button, { variant: 'outline' }, 'Cancel'),
        createElement(Button, null, "I've written it down")))));

// Rows that crowd at large text: three buttons and a label-driven pair in a 320px phone's
// sheet, and the billing portal's pair in a 390px one.
createRoot(document.getElementById('crowd-phone')).render(
  createElement('div', { style: { paddingInline: '1.5rem' } },
    createElement('div', { 'data-crowd-row': 'three' },
      createElement(ButtonRow, null,
        createElement(Button, { variant: 'outline' }, 'Simulate failure'),
        createElement(Button, { variant: 'outline' }, 'Simulate success'),
        createElement(Button, null, 'Pay $25.00'))),
    createElement('div', { 'data-crowd-row': 'labels' },
      createElement(ButtonRow, { stack: 'labels' },
        createElement(Button, { variant: 'outline' }, 'Cancel'),
        createElement(Button, null, 'Save')))));
createRoot(document.getElementById('crowd-wide-phone')).render(
  createElement('div', { style: { paddingInline: '1.5rem' } },
    createElement('div', { 'data-crowd-row': 'billing' },
      createElement(ButtonRow, { stack: 'labels', stackedOrder: 'reverse' },
        createElement(Button, { variant: 'outline', size: 'lg' }, 'Add Credits'),
        createElement(Button, { asChild: true, size: 'lg' },
          createElement('a', { href: '#' }, 'Return to the app', createElement(Icon, { icon: ArrowUpRight })))))));

// Rows in groups wider than 40rem whose labels crowd them in the dyslexic face.
createRoot(document.getElementById('wide-groups')).render(
  createElement('div', null,
    createElement('div', { 'data-wide-group': 'three', style: { width: '800px' } },
      createElement(ButtonRow, null,
        createElement(Button, { variant: 'outline' }, 'Simulate a declined payment'),
        createElement(Button, { variant: 'outline' }, 'Simulate an approved payment'),
        createElement(Button, null, 'Pay $25.00'))),
    createElement('div', { 'data-wide-group': 'labels', style: { width: '700px' } },
      createElement(ButtonRow, { stack: 'labels' },
        createElement(Button, { variant: 'outline' }, 'Not now'),
        createElement(Button, null, 'Continue with a passkey on this device')))));

// A pair whose space the resize case moves across the widths it stacks at.
createRoot(document.getElementById('resizable')).render(
  createElement(ButtonRow, null,
    createElement(Button, { variant: 'outline' }, 'Cancel'),
    createElement(Button, null, 'Change password')));

// The same pair as a static page builds it: the published row class and the measure alone.
document.querySelector('[data-phone-row="static"]').innerHTML =
  '<div class="' + buttonRowClass + '">' +
  '<button class="' + buttonVariants({ variant: 'outline' }) + '">Cancel</button>' +
  '<button class="' + buttonVariants({}) + '">' + "I've written it down" + '</button>' +
  '</div>';
measureButtonGroups(document.getElementById('phone-static'));

// A single-choice group wired as the member dialogs wire their privilege, mounted only on
// request so no other reading on the page shifts.
function PrivilegeChoice() {
  const [privilege, setPrivilege] = useState('write');
  return createElement(ToggleGroup, {
      type: 'single',
      variant: 'outline',
      'aria-label': 'Privilege',
      value: privilege,
      onValueChange: (value) => {
        globalThis.__privilegeChanges.push(value);
        if (value) setPrivilege(value);
      },
    },
    ...['read', 'write', 'admin'].map((value) => createElement(ToggleGroupItem, { key: value, value }, value)));
}
globalThis.__mountPrivilegeChoice = () => {
  globalThis.__privilegeChanges = [];
  const host = document.createElement('div');
  host.id = 'privilege-choice';
  document.body.append(host);
  createRoot(host).render(createElement(PrivilegeChoice));
};
globalThis.__buttonGroupsReady = true;
`;

function pageModules(): Plugin {
  return {
    name: 'button-groups-page',
    resolveId(id) {
      return id === ENTRY_ID ? `\0${id}` : undefined;
    },
    load(id) {
      return id === `\0${ENTRY_ID}` ? ENTRY_SOURCE : undefined;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = request.url;
        if (!url?.startsWith('/groups.html')) {
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
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'button-groups-vite-'));
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
    throw new Error('button groups server has no port');
  }
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    close: async () => {
      await server.close();
      await rm(cacheDir, { recursive: true, force: true });
    },
  };
}

interface ButtonBox {
  label: string;
  left: number;
  top: number;
  width: number;
  marginLeft: number;
  marginRight: number;
}

interface GroupReading {
  rootPx: number;
  spaceWidth: number;
  spaceLeft: number;
  equalWidth: number;
  buttons: ButtonBox[];
}

declare global {
  var __buttonGroupsReady: boolean | undefined;
}

/** Reads the group drawn under a caption, or the static group when the caption is null. */
async function readGroup(page: Page, caption: string | null): Promise<GroupReading> {
  return page.evaluate((caption) => {
    const space =
      caption === null
        ? document.querySelector<HTMLElement>('#static')
        : [...document.querySelectorAll('figure')]
            .find((figure) => figure.querySelector('figcaption')?.textContent === caption)
            ?.querySelector<HTMLElement>('[data-space]');
    const group = space?.firstElementChild;
    if (space === null || space === undefined || !(group instanceof HTMLElement)) {
      throw new Error(`no group under ${String(caption)}`);
    }
    const spaceBox = space.getBoundingClientRect();
    return {
      rootPx: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
      spaceWidth: spaceBox.width,
      spaceLeft: spaceBox.left,
      equalWidth: Number.parseFloat(group.style.getPropertyValue('--btn-eq')),
      buttons: [...group.children].map((child) => {
        const box = child.getBoundingClientRect();
        const style = getComputedStyle(child);
        return {
          label: child.textContent,
          left: box.left,
          top: box.top,
          width: box.width,
          marginLeft: Number.parseFloat(style.marginLeft),
          marginRight: Number.parseFloat(style.marginRight),
        };
      }),
    };
  }, caption);
}

/** The width a button takes at its label's own width, the reading the measure makes. */
async function labelWidths(page: Page, caption: string): Promise<number[]> {
  return page.evaluate((caption) => {
    const figure = [...document.querySelectorAll('figure')].find(
      (candidate) => candidate.querySelector('figcaption')?.textContent === caption
    );
    const group = figure?.querySelector('[data-space]')?.firstElementChild;
    if (group === null || group === undefined) throw new Error(`no group under ${caption}`);
    return [...group.children].map((child) => {
      const clone = child.cloneNode(true);
      if (!(clone instanceof HTMLElement)) throw new Error('a group child is not an element');
      clone.style.cssText = 'position:absolute;width:max-content;min-width:0;max-width:none';
      document.body.append(clone);
      const width = clone.offsetWidth;
      clone.remove();
      return width;
    });
  }, caption);
}

interface LoneReading {
  rootPx: number;
  spaceWidth: number;
  spaceLeft: number;
  button: ButtonBox;
  /** The button's width at its label's own width. */
  labelWidth: number;
}

/** Reads the lone block button drawn under a caption. */
async function readLone(page: Page, caption: string): Promise<LoneReading> {
  return page.evaluate((caption) => {
    const space = [...document.querySelectorAll('figure')]
      .find((figure) => figure.querySelector('figcaption')?.textContent === caption)
      ?.querySelector<HTMLElement>('[data-space]');
    const button = space?.firstElementChild;
    if (space === null || space === undefined || !(button instanceof HTMLElement)) {
      throw new Error(`no button under ${caption}`);
    }
    const clone = button.cloneNode(true);
    if (!(clone instanceof HTMLElement)) throw new Error('the button is not an element');
    clone.style.cssText = 'position:absolute;width:max-content;min-width:0;max-width:none';
    document.body.append(clone);
    const labelWidth = clone.offsetWidth;
    clone.remove();
    const spaceBox = space.getBoundingClientRect();
    const box = button.getBoundingClientRect();
    const style = getComputedStyle(button);
    return {
      rootPx: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
      spaceWidth: spaceBox.width,
      spaceLeft: spaceBox.left,
      labelWidth,
      button: {
        label: button.textContent,
        left: box.left,
        top: box.top,
        width: box.width,
        marginLeft: Number.parseFloat(style.marginLeft),
        marginRight: Number.parseFloat(style.marginRight),
      },
    };
  }, caption);
}

function centredIn(reading: LoneReading): boolean {
  const before = reading.button.left - reading.spaceLeft;
  const after =
    reading.spaceLeft + reading.spaceWidth - (reading.button.left + reading.button.width);
  return Math.abs(before - after) < TOLERANCE_PX;
}

function widths(reading: GroupReading): number[] {
  return reading.buttons.map((button) => button.width);
}

function tops(reading: GroupReading): Set<number> {
  return new Set(reading.buttons.map((button) => Math.round(button.top)));
}

type EngineName = 'chromium' | 'firefox';
const ENGINES: readonly EngineName[] = ['chromium', 'firefox'];

type Face = 'default' | 'open-dyslexic';
type NarrowSize = (typeof NARROW_SIZES)[number];

interface Edges {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface NarrowReading {
  rootPx: number;
  space: Edges;
  button: Edges;
  label: Edges;
  /** Each drawn line of the label, left to right. */
  lines: { left: number; right: number }[];
}

/** Sets the accessibility widget's largest text, in a face, as its classes on `<html>` do. */
async function applyLargestText(page: Page, face: Face): Promise<void> {
  await page.evaluate(async (face) => {
    const html = document.documentElement;
    html.classList.add('a11y-font-scale-141');
    if (face === 'open-dyslexic') {
      html.style.setProperty('--a11y-font-family', '"open-dyslexic"');
      html.classList.add('a11y-font-override');
      await document.fonts.load('1rem "open-dyslexic"');
    }
    await document.fonts.ready;
  }, face);
}

/** Sets the accessibility widget's largest text in the dyslexic face with the loosest letter spacing. */
async function applyLargestDyslexicLoosest(page: Page): Promise<void> {
  await applyLargestText(page, 'open-dyslexic');
  await page.evaluate(() => {
    document.documentElement.classList.add('a11y-letter-spacing-loosest');
  });
}

async function clearLargestDyslexicLoosest(page: Page): Promise<void> {
  await clearLargestText(page);
  await page.evaluate(() => {
    document.documentElement.classList.remove('a11y-letter-spacing-loosest');
  });
}

/** Sets the accessibility widget's dyslexic face and loosest letter spacing at default size. */
async function applyDyslexicLoosest(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const html = document.documentElement;
    html.style.setProperty('--a11y-font-family', '"open-dyslexic"');
    html.classList.add('a11y-font-override', 'a11y-letter-spacing-loosest');
    await document.fonts.load('1rem "open-dyslexic"');
    await document.fonts.ready;
  });
}

async function clearDyslexicLoosest(page: Page): Promise<void> {
  await page.evaluate(() => {
    const html = document.documentElement;
    html.classList.remove('a11y-font-override', 'a11y-letter-spacing-loosest');
    html.style.removeProperty('--a11y-font-family');
  });
}

async function clearLargestText(page: Page): Promise<void> {
  await page.evaluate(() => {
    const html = document.documentElement;
    html.classList.remove('a11y-font-scale-141', 'a11y-font-override');
    html.style.removeProperty('--a11y-font-family');
  });
}

/** Reads a lone block button in a narrow space: its box, its space, and its label's lines. */
async function readNarrow(page: Page, space: string): Promise<NarrowReading & { font: string }> {
  return page.evaluate((space) => {
    const button = document.querySelector(`[data-narrow-space="${space}"] > button`);
    const spaceElement = button?.parentElement;
    if (button === null || spaceElement === null || spaceElement === undefined) {
      throw new Error(`no button in the ${space} space`);
    }
    const edges = (box: DOMRect): Edges => ({
      left: box.left,
      right: box.right,
      top: box.top,
      bottom: box.bottom,
    });
    const range = document.createRange();
    range.selectNodeContents(button);
    const byLine = new Map<number, { left: number; right: number }>();
    for (const rect of [...range.getClientRects()].filter((line) => line.width > 0)) {
      const drawn = byLine.get(Math.round(rect.top)) ?? rect;
      byLine.set(Math.round(rect.top), {
        left: Math.min(drawn.left, rect.left),
        right: Math.max(drawn.right, rect.right),
      });
    }
    return {
      font: getComputedStyle(button).fontFamily,
      rootPx: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
      space: edges(spaceElement.getBoundingClientRect()),
      button: edges(button.getBoundingClientRect()),
      label: edges(range.getBoundingClientRect()),
      lines: [...byLine.values()],
    };
  }, space);
}

/**
 * Reads a lone block button in a narrow space under the accessibility widget's largest
 * text, in a face, then puts the page back to its default text.
 */
async function readNarrowAtLargestText(
  page: Page,
  space: string,
  face: Face
): Promise<NarrowReading> {
  await applyLargestText(page, face);
  try {
    const { font, ...reading } = await readNarrow(page, space);
    if (face === 'open-dyslexic' && !font.includes('open-dyslexic')) {
      throw new Error('the dyslexic face did not apply');
    }
    return reading;
  } finally {
    await clearLargestText(page);
  }
}

interface PhoneButton {
  label: string;
  button: Edges;
  /** The box of everything the button draws inside it, icon and label. */
  drawn: Edges;
}

interface PhoneRow {
  /** The `data-phone-row` name of the group's wrapper. */
  name: string;
  row: Edges;
  /** The group's `--btn-eq`: its widest label's width plus 1px. */
  equalWidth: number;
  buttons: PhoneButton[];
}

interface PhoneReading {
  rootPx: number;
  font: string;
  rows: PhoneRow[];
}

/**
 * Reads the phone page's groups whose wrappers carry `attribute`: each group's box, and
 * each button's box and what it draws.
 */
async function readPhoneRows(
  page: Page,
  attribute:
    | 'data-phone-row'
    | 'data-wide-row'
    | 'data-crowd-row'
    | 'data-wide-group' = 'data-phone-row'
): Promise<PhoneReading> {
  return page.evaluate((attribute) => {
    const edges = ({ left, right, top, bottom }: DOMRect): Edges => ({ left, right, top, bottom });
    const rows = [...document.querySelectorAll(`[${attribute}] > *`)];
    const first = rows[0]?.firstElementChild;
    if (first === null || first === undefined) throw new Error('no phone rows');
    return {
      rootPx: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
      font: getComputedStyle(first).fontFamily,
      rows: rows.map((row) => ({
        name: row.parentElement?.getAttribute(attribute) ?? '',
        row: edges(row.getBoundingClientRect()),
        equalWidth: Number.parseFloat(
          row instanceof HTMLElement ? row.style.getPropertyValue('--btn-eq') : ''
        ),
        buttons: [...row.children].map((button) => {
          const range = document.createRange();
          range.selectNodeContents(button);
          return {
            label: button.textContent,
            button: edges(button.getBoundingClientRect()),
            drawn: edges(range.getBoundingClientRect()),
          };
        }),
      })),
    };
  }, attribute);
}

/** Each label a group draws outside its button, or a button outside its group, named by its group. */
function clippedLabels(rows: PhoneRow[]): string[] {
  return rows.flatMap(({ name, row, buttons }) =>
    buttons
      .filter(
        ({ button, drawn }) =>
          button.left < row.left - 0.5 ||
          button.right > row.right + 0.5 ||
          drawn.left < button.left - 0.5 ||
          drawn.right > button.right + 0.5 ||
          drawn.top < button.top - 0.5 ||
          drawn.bottom > button.bottom + 0.5
      )
      .map(({ label }) => `${name}: ${label}`)
  );
}

/** Whether every row sets each of its buttons on a line of its own. */
function eachOnItsOwnLine(rows: PhoneRow[]): boolean {
  return rows.every(
    ({ buttons }) =>
      new Set(buttons.map(({ button }) => Math.round(button.top))).size === buttons.length
  );
}

/** The widget's largest text step sets the root to 150% of the browser's 16px. */
const LARGEST_ROOT_PX = 24;

const FACES: readonly Face[] = ['default', 'open-dyslexic'];

interface NarrowCase {
  engine: EngineName;
  face: Face;
  width: (typeof NARROW_SPACES_PX)[number];
  size: NarrowSize;
}

const NARROW_CASES: NarrowCase[] = ENGINES.flatMap((engine) =>
  FACES.flatMap((face) =>
    NARROW_SPACES_PX.flatMap((width) => NARROW_SIZES.map((size) => ({ engine, face, width, size })))
  )
);

describe('button groups (real browser)', () => {
  let server: { origin: string; close: () => Promise<void> };
  const browsers: Partial<Record<EngineName, Browser>> = {};
  const pages: Partial<Record<EngineName, Page>> = {};
  const phonePages: Partial<Record<EngineName, Page>> = {};

  async function openGroups(
    browser: Browser,
    viewport: { width: number; height: number }
  ): Promise<Page> {
    const page = await browser.newPage({ viewport });
    await page.goto(`${server.origin}/groups.html`, { waitUntil: 'commit', timeout: LOAD_MS });
    await page.waitForFunction(() => globalThis.__buttonGroupsReady === true, undefined, {
      timeout: LOAD_MS,
    });
    await page.evaluate(() => document.fonts.ready);
    return page;
  }

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
      pages[engine] = await openGroups(browser, { width: 1440, height: 1000 });
      phonePages[engine] = await openGroups(browser, PHONE_VIEWPORT);
    }
  }, 2 * LOAD_MS);

  afterAll(async () => {
    try {
      await Promise.all(
        [...Object.values(pages), ...Object.values(phonePages)].map((page) => page.close())
      );
      await Promise.all(Object.values(browsers).map((browser) => browser.close()));
    } finally {
      await server.close();
    }
  }, LOAD_MS);

  function pageFor(engine: EngineName): Page {
    const page = pages[engine];
    if (page === undefined) throw new Error(`${engine} has no page`);
    return page;
  }

  function phonePageFor(engine: EngineName): Page {
    const page = phonePages[engine];
    if (page === undefined) throw new Error(`${engine} has no phone page`);
    return page;
  }

  it.each(ENGINES)(
    'fills a 35rem space with two buttons of equal width side by side, on %s',
    async (engine) => {
      const reading = await readGroup(pageFor(engine), 'two buttons in 35rem');
      const gap = 0.5 * reading.rootPx;

      expect(tops(reading).size).toBe(1);
      for (const width of widths(reading)) {
        expect(width).toBeCloseTo((reading.spaceWidth - gap) / 2, 0);
      }
    },
    TEST_MS
  );

  it.each(ENGINES)(
    'stacks two buttons in markup order at full width in a 17rem space, on %s',
    async (engine) => {
      const reading = await readGroup(pageFor(engine), 'two buttons in 17rem');

      expect(reading.buttons.map((button) => button.label)).toEqual(['Cancel', 'Change password']);
      expect(reading.buttons[1]?.top ?? 0).toBeGreaterThan(reading.buttons[0]?.top ?? 0);
      for (const width of widths(reading)) {
        expect(Math.abs(width - reading.spaceWidth)).toBeLessThan(TOLERANCE_PX);
      }
    },
    TEST_MS
  );

  it.each(ENGINES)(
    'stacks three buttons at full width in a 27rem space, on %s',
    async (engine) => {
      const reading = await readGroup(pageFor(engine), 'three buttons in 27rem');

      expect(tops(reading).size).toBe(3);
      for (const width of widths(reading)) {
        expect(Math.abs(width - reading.spaceWidth)).toBeLessThan(TOLERANCE_PX);
      }
    },
    TEST_MS
  );

  it.each(ENGINES)(
    'keeps three buttons side by side at equal widths in a 35rem space, on %s',
    async (engine) => {
      const reading = await readGroup(pageFor(engine), 'three buttons in 35rem');
      const gap = 0.5 * reading.rootPx;

      expect(tops(reading).size).toBe(1);
      for (const width of widths(reading)) {
        expect(width).toBeCloseTo((reading.spaceWidth - 2 * gap) / 3, 0);
      }
    },
    TEST_MS
  );

  it.each(ENGINES)(
    'gives both buttons the widest label in a 50rem space, on %s',
    async (engine) => {
      const reading = await readGroup(pageFor(engine), 'two buttons in 50rem');
      const expected = Math.max(12 * reading.rootPx, reading.equalWidth);

      expect(tops(reading).size).toBe(1);
      for (const width of widths(reading)) {
        expect(Math.abs(width - expected)).toBeLessThan(TOLERANCE_PX);
      }
    },
    TEST_MS
  );

  it.each(ENGINES)(
    'centres two buttons in a 50rem space, on %s',
    async (engine) => {
      const reading = await readGroup(pageFor(engine), 'two buttons in 50rem');
      const first = reading.buttons[0];
      const last = reading.buttons.at(-1);
      if (first === undefined || last === undefined) throw new Error('no buttons');
      const before = first.left - reading.spaceLeft;
      const after = reading.spaceLeft + reading.spaceWidth - (last.left + last.width);

      expect(Math.abs(before - after)).toBeLessThan(TOLERANCE_PX);
    },
    TEST_MS
  );

  it.each(ENGINES)(
    'writes the widest label plus 1px, on %s',
    async (engine) => {
      const page = pageFor(engine);
      const reading = await readGroup(page, 'two buttons in 50rem');
      const labels = await labelWidths(page, 'two buttons in 50rem');

      expect(reading.equalWidth).toBeCloseTo(Math.max(...labels) + 1, 0);
    },
    TEST_MS
  );

  it.each(ENGINES)(
    'fills a 35rem space with each button of a stack, on %s',
    async (engine) => {
      const reading = await readGroup(pageFor(engine), 'a stack in 35rem');

      expect(tops(reading).size).toBe(3);
      for (const width of widths(reading)) {
        expect(Math.abs(width - reading.spaceWidth)).toBeLessThan(TOLERANCE_PX);
      }
    },
    TEST_MS
  );

  it.each(ENGINES)(
    'gives each button of a stack the widest label, centred, in a 50rem space, on %s',
    async (engine) => {
      const reading = await readGroup(pageFor(engine), 'a stack in 50rem');
      const expected = Math.max(12 * reading.rootPx, reading.equalWidth);

      for (const button of reading.buttons) {
        expect(Math.abs(button.width - expected)).toBeLessThan(TOLERANCE_PX);
        expect(
          Math.abs(button.left - reading.spaceLeft - (reading.spaceWidth - expected) / 2)
        ).toBeLessThan(TOLERANCE_PX);
      }
    },
    TEST_MS
  );

  it.each(ENGINES)(
    'keeps short labels side by side by the label rule in 18rem, on %s',
    async (engine) => {
      const reading = await readGroup(pageFor(engine), 'short labels in 18rem');

      expect(tops(reading).size).toBe(1);
    },
    TEST_MS
  );

  it.each(ENGINES)(
    'stacks the billing pair once a label passes half the row, on %s',
    async (engine) => {
      const reading = await readGroup(pageFor(engine), 'the billing pair in 18rem');

      expect(tops(reading).size).toBe(2);
    },
    TEST_MS
  );

  it.each(ENGINES)(
    'puts the drawn-first button first in the document while the pair is stacked, on %s',
    async (engine) => {
      const reading = await readGroup(pageFor(engine), 'the billing pair in 18rem');

      expect(reading.buttons.map((button) => button.label)).toEqual([
        'Return to the app',
        'Add Credits',
      ]);
      expect(reading.buttons[0]?.top ?? 0).toBeLessThan(reading.buttons[1]?.top ?? 0);
    },
    TEST_MS
  );

  it.each(ENGINES)(
    'tabs to the drawn-first button first while the pair is stacked, on %s',
    async (engine) => {
      const page = pageFor(engine);
      await page.evaluate(() => {
        const figure = [...document.querySelectorAll('figure')].find(
          (candidate) =>
            candidate.querySelector('figcaption')?.textContent === 'the billing pair in 18rem'
        );
        const before = document.createElement('button');
        before.id = 'before-pair';
        figure?.prepend(before);
        before.focus();
      });
      await page.keyboard.press('Tab');
      const focused = await page.evaluate(() => document.activeElement?.textContent);
      await page.evaluate(() => document.querySelector('#before-pair')?.remove());

      expect(focused).toBe('Return to the app');
    },
    TEST_MS
  );

  it.each(ENGINES)(
    'lets an icon button in a row keep its own size, on %s',
    async (engine) => {
      const reading = await readGroup(pageFor(engine), 'an icon button in a row');
      const icon = reading.buttons.find((button) => button.label === '');

      expect(icon?.width).toBeCloseTo(2.25 * reading.rootPx, 0);
    },
    TEST_MS
  );

  it.each(ENGINES)(
    'lays out a static group with the published class and measure as the React row, on %s',
    async (engine) => {
      const page = pageFor(engine);
      const [staticGroup, reactGroup] = await Promise.all([
        readGroup(page, null),
        readGroup(page, 'two buttons in 50rem'),
      ]);

      expect(staticGroup.equalWidth).toBeCloseTo(reactGroup.equalWidth, 0);
      expect(widths(staticGroup)).toEqual(widths(reactGroup));
    },
    TEST_MS
  );

  it.each(ENGINES)(
    'fills a 35rem parent with a lone block button, on %s',
    async (engine) => {
      const reading = await readLone(pageFor(engine), 'a lone block button in 35rem');

      expect(Math.abs(reading.button.width - reading.spaceWidth)).toBeLessThan(TOLERANCE_PX);
    },
    TEST_MS
  );

  it.each(ENGINES)(
    'gives a lone block button with a short label 12rem, centred, in a 50rem parent, on %s',
    async (engine) => {
      const reading = await readLone(pageFor(engine), 'a lone block button in 50rem');

      expect(reading.labelWidth).toBeLessThan(12 * reading.rootPx);
      expect(Math.abs(reading.button.width - 12 * reading.rootPx)).toBeLessThan(TOLERANCE_PX);
      expect(centredIn(reading)).toBe(true);
    },
    TEST_MS
  );

  it.each(ENGINES)(
    'gives a lone block button with a long label its own width, centred, in a 50rem parent, on %s',
    async (engine) => {
      const reading = await readLone(
        pageFor(engine),
        'a lone block button with a long label in 50rem'
      );

      expect(reading.labelWidth).toBeGreaterThan(12 * reading.rootPx);
      expect(Math.abs(reading.button.width - reading.labelWidth)).toBeLessThan(TOLERANCE_PX);
      expect(centredIn(reading)).toBe(true);
    },
    TEST_MS
  );

  it.each(ENGINES)(
    'gives a block button in a 50rem row the widest label, as its sibling, on %s',
    async (engine) => {
      const reading = await readGroup(pageFor(engine), 'a block button in a row in 50rem');

      expect(reading.equalWidth).toBeGreaterThan(12 * reading.rootPx);
      for (const width of widths(reading)) {
        expect(Math.abs(width - reading.equalWidth)).toBeLessThan(TOLERANCE_PX);
      }
    },
    TEST_MS
  );

  it.each(ENGINES)(
    'keeps no side margin on a block button in a row, on %s',
    async (engine) => {
      const reading = await readGroup(pageFor(engine), 'a block button in a row in 50rem');

      for (const button of reading.buttons) {
        expect([button.marginLeft, button.marginRight]).toEqual([0, 0]);
      }
    },
    TEST_MS
  );

  it.each(ENGINES)(
    'centres a row holding a block button in a 50rem space, on %s',
    async (engine) => {
      const reading = await readGroup(pageFor(engine), 'a block button in a row in 50rem');
      const first = reading.buttons[0];
      const last = reading.buttons.at(-1);
      if (first === undefined || last === undefined) throw new Error('no buttons');
      const before = first.left - reading.spaceLeft;
      const after = reading.spaceLeft + reading.spaceWidth - (last.left + last.width);

      expect(Math.abs(before - after)).toBeLessThan(TOLERANCE_PX);
    },
    TEST_MS
  );

  it.each(ENGINES)(
    'stacks a block button with its sibling at full width in a 17rem row, on %s',
    async (engine) => {
      const reading = await readGroup(pageFor(engine), 'a block button in a row in 17rem');

      expect(tops(reading).size).toBe(2);
      for (const width of widths(reading)) {
        expect(Math.abs(width - reading.spaceWidth)).toBeLessThan(TOLERANCE_PX);
      }
    },
    TEST_MS
  );

  it.each(ENGINES)(
    'gives a block button in a 50rem stack the widest label, as its siblings, on %s',
    async (engine) => {
      const reading = await readGroup(pageFor(engine), 'a block button in a stack in 50rem');

      expect(reading.equalWidth).toBeGreaterThan(12 * reading.rootPx);
      for (const button of reading.buttons) {
        expect(Math.abs(button.width - reading.equalWidth)).toBeLessThan(TOLERANCE_PX);
        expect([button.marginLeft, button.marginRight]).toEqual([0, 0]);
      }
    },
    TEST_MS
  );

  for (const { engine, face, width, size } of NARROW_CASES) {
    it(
      `keeps a lone ${size} block button with a long label within a ${String(width)}px space at the largest text, in the ${face} face, on ${engine}`,
      async () => {
        const reading = await readNarrowAtLargestText(
          pageFor(engine),
          `${String(width)}-${size}`,
          face
        );

        expect(reading.rootPx).toBe(LARGEST_ROOT_PX);
        expect(reading.button.left).toBeGreaterThanOrEqual(reading.space.left - 0.5);
        expect(reading.button.right).toBeLessThanOrEqual(reading.space.right + 0.5);
      },
      TEST_MS
    );
  }

  for (const { engine, face, width, size } of NARROW_CASES) {
    it(
      `shows the whole label of a lone ${size} block button in a ${String(width)}px space at the largest text, in the ${face} face, on ${engine}`,
      async () => {
        const { space, button, label } = await readNarrowAtLargestText(
          pageFor(engine),
          `${String(width)}-${size}`,
          face
        );

        expect(label.left).toBeGreaterThanOrEqual(Math.max(button.left, space.left));
        expect(label.right).toBeLessThanOrEqual(Math.min(button.right, space.right));
        expect(label.top).toBeGreaterThanOrEqual(button.top);
        expect(label.bottom).toBeLessThanOrEqual(button.bottom);
      },
      TEST_MS
    );
  }

  for (const { engine, face, width, size } of NARROW_CASES) {
    it(
      `wraps the long label of a lone ${size} block button in a ${String(width)}px space onto centred lines, in the ${face} face, on ${engine}`,
      async () => {
        const { button, lines } = await readNarrowAtLargestText(
          pageFor(engine),
          `${String(width)}-${size}`,
          face
        );
        const buttonCentre = (button.left + button.right) / 2;

        expect(lines.length).toBeGreaterThan(1);
        for (const line of lines) {
          expect(Math.abs((line.left + line.right) / 2 - buttonCentre)).toBeLessThan(TOLERANCE_PX);
        }
      },
      TEST_MS
    );
  }

  for (const { engine, face, width, size } of NARROW_CASES.filter(
    (narrow) => narrow.size === 'default'
  )) {
    it(
      `grows a lone default block button past its height to hold a wrapped label in a ${String(width)}px space, in the ${face} face, on ${engine}`,
      async () => {
        const reading = await readNarrowAtLargestText(
          pageFor(engine),
          `${String(width)}-${size}`,
          face
        );

        expect(reading.button.bottom - reading.button.top).toBeGreaterThan(2.25 * reading.rootPx);
      },
      TEST_MS
    );
  }

  it.each(ENGINES)(
    'keeps a lone block button whose one word outruns a 224px space within it at the largest text, on %s',
    async (engine) => {
      const { space, button, label } = await readNarrowAtLargestText(
        pageFor(engine),
        '224-word',
        'default'
      );

      expect(button.right).toBeLessThanOrEqual(space.right + 0.5);
      expect(label.right).toBeLessThanOrEqual(button.right);
    },
    TEST_MS
  );

  it.each(
    ENGINES.flatMap((engine) =>
      ['an icon-leading pair in 20rem', 'a large icon-leading pair by labels in 20rem'].map(
        (caption) => [caption, engine] as const
      )
    )
  )(
    'gives an icon-leading button the width of its text-only partner in %s, on %s',
    async (caption, engine) => {
      const reading = await readGroup(pageFor(engine), caption);

      expect(tops(reading).size).toBe(1);
      const [back = 0, next = 0] = widths(reading);
      expect(Math.abs(back - next)).toBeLessThan(TOLERANCE_PX);
    },
    TEST_MS
  );

  it.each(ENGINES.flatMap((engine) => FACES.map((face) => [face, engine] as const)))(
    'shows the whole label of every button in a stack or in a stacked or lone-button row at 320 at the largest text, in the %s face, on %s',
    async (face, engine) => {
      const page = phonePageFor(engine);
      await applyLargestText(page, face);
      try {
        const { rootPx, font, rows } = await readPhoneRows(page);

        expect({
          rootPx,
          dyslexic: font.includes('open-dyslexic'),
          ownLines: eachOnItsOwnLine(rows),
          clipped: clippedLabels(rows),
        }).toEqual({
          rootPx: LARGEST_ROOT_PX,
          dyslexic: face === 'open-dyslexic',
          ownLines: true,
          clipped: [],
        });
      } finally {
        await clearLargestText(page);
      }
    },
    TEST_MS
  );

  it.each(ENGINES)(
    "keeps every button of a stack or of a stacked or lone-button row at 320 at its size's height at default text, on %s",
    async (engine) => {
      const { rootPx, rows } = await readPhoneRows(phonePageFor(engine));

      expect(eachOnItsOwnLine(rows)).toBe(true);
      for (const { button } of rows.flatMap((row) => row.buttons)) {
        expect(button.bottom - button.top).toBeCloseTo(2.25 * rootPx, 1);
      }
    },
    TEST_MS
  );

  it.each(ENGINES)(
    "shows the whole label of every button in the recovery step's footer at 390 in the open-dyslexic face with the loosest letter spacing, on %s",
    async (engine) => {
      const page = phonePageFor(engine);
      await applyDyslexicLoosest(page);
      try {
        const { rootPx, font, rows } = await readPhoneRows(page, 'data-wide-row');

        expect({
          rootPx,
          dyslexic: font.includes('open-dyslexic'),
          clipped: clippedLabels(rows),
        }).toEqual({ rootPx: 16, dyslexic: true, clipped: [] });
      } finally {
        await clearDyslexicLoosest(page);
      }
    },
    TEST_MS
  );

  it.each(ENGINES)(
    "keeps the recovery step's footer side by side at 390 at default text, on %s",
    async (engine) => {
      const { rows } = await readPhoneRows(phonePageFor(engine), 'data-wide-row');

      expect(
        rows.map(({ buttons }) => new Set(buttons.map(({ button }) => Math.round(button.top))).size)
      ).toEqual([1]);
    },
    TEST_MS
  );

  it.each(ENGINES.flatMap((engine) => FACES.map((face) => [face, engine] as const)))(
    'keeps every button of a three-button row and a label-driven pair within its row, whole, at 320 at the largest text, in the %s face, on %s',
    async (face, engine) => {
      const page = phonePageFor(engine);
      await applyLargestText(page, face);
      try {
        const { rows } = await readPhoneRows(page, 'data-crowd-row');

        expect(clippedLabels(rows.filter(({ name }) => name !== 'billing'))).toEqual([]);
      } finally {
        await clearLargestText(page);
      }
    },
    TEST_MS
  );

  it.each(ENGINES)(
    "keeps the billing portal's pair within its row, whole, at 390 at the largest text in the open-dyslexic face with the loosest letter spacing, on %s",
    async (engine) => {
      const page = phonePageFor(engine);
      await applyLargestDyslexicLoosest(page);
      try {
        const { rows } = await readPhoneRows(page, 'data-crowd-row');

        expect(clippedLabels(rows.filter(({ name }) => name === 'billing'))).toEqual([]);
      } finally {
        await clearLargestDyslexicLoosest(page);
      }
    },
    TEST_MS
  );

  it.each(ENGINES)(
    'raises no window error while a row is resized across the widths it stacks at, at the largest text in the open-dyslexic face, on %s',
    async (engine) => {
      const page = phonePageFor(engine);
      await applyLargestText(page, 'open-dyslexic');
      let errors: string[];
      try {
        errors = await page.evaluate(async () => {
          const seen: string[] = [];
          const record = (event: ErrorEvent): void => {
            seen.push(event.message);
          };
          globalThis.addEventListener('error', record);
          const space = document.querySelector<HTMLElement>('#resizable');
          const button = space?.firstElementChild?.firstElementChild;
          if (space === null || button === null || button === undefined) {
            throw new Error('no resizable row');
          }
          // Waits for the frame that lays the row out at its new width, then for the task
          // after it, by which time any loop error from that frame has been dispatched. It
          // watches a button inside the row: an observer on the row or anything above it is
          // delivered first and lets the row's own notifications through, hiding the error.
          const settled = async (): Promise<void> => {
            await new Promise<void>((resolve) => {
              const observer = new ResizeObserver(() => {
                observer.disconnect();
                resolve();
              });
              observer.observe(button);
            });
            await new Promise((resolve) => setTimeout(resolve, 0));
          };
          for (const width of ['250px', '700px', '450px', '700px', '300px', '700px']) {
            space.style.width = width;
            await settled();
          }
          globalThis.removeEventListener('error', record);
          space.style.width = '300px';
          return seen;
        });
      } finally {
        await clearLargestText(page);
      }

      expect(errors).toEqual([]);
    },
    TEST_MS
  );

  it.each(ENGINES)(
    'stacks a crowded row in a group wider than 40rem at its widest label, at least 12rem, centred, in the open-dyslexic face, on %s',
    async (engine) => {
      const page = phonePageFor(engine);
      await applyDyslexicLoosest(page);
      try {
        const { rootPx, rows } = await readPhoneRows(page, 'data-wide-group');
        const gap = 0.5 * rootPx;
        const drawn = rows.map(({ name, row, equalWidth, buttons }) => {
          const width = row.right - row.left;
          const expected = Math.max(12 * rootPx, equalWidth);
          return {
            name,
            wideAndCrowded:
              width > 40 * rootPx &&
              buttons.length * equalWidth + (buttons.length - 1) * gap > width,
            ownLines:
              new Set(buttons.map(({ button }) => Math.round(button.top))).size === buttons.length,
            atWidestLabel: buttons.every(
              ({ button }) => Math.abs(button.right - button.left - expected) < TOLERANCE_PX
            ),
            centred: buttons.every(
              ({ button }) =>
                Math.abs(button.left - row.left - (row.right - button.right)) < TOLERANCE_PX
            ),
          };
        });

        expect({ drawn, clipped: clippedLabels(rows) }).toEqual({
          drawn: ['three', 'labels'].map((name) => ({
            name,
            wideAndCrowded: true,
            ownLines: true,
            atWidestLabel: true,
            centred: true,
          })),
          clipped: [],
        });
      } finally {
        await clearDyslexicLoosest(page);
      }
    },
    TEST_MS
  );

  it.each(ENGINES)(
    'checks the item an arrow key moves focus to in a single-choice toggle group, with wrap, on %s',
    async (engine) => {
      const browser = browsers[engine];
      if (browser === undefined) throw new Error(`${engine} did not launch`);
      const page = await openGroups(browser, { width: 1440, height: 1000 });
      try {
        await page.evaluate(() => {
          globalThis.__mountPrivilegeChoice?.();
        });
        await page.getByRole('radio', { name: 'write' }).focus();

        const steps: { key: string; lands: string }[] = [
          { key: 'ArrowRight', lands: 'admin' },
          { key: 'ArrowRight', lands: 'read' },
          { key: 'ArrowLeft', lands: 'admin' },
          { key: 'ArrowLeft', lands: 'write' },
        ];
        const readings: { key: string; focused: string; checked: string[]; changes: number }[] = [];
        for (const { key, lands } of steps) {
          await page.keyboard.press(key);
          await page.waitForFunction(
            (lands) => document.activeElement?.textContent === lands,
            lands,
            { timeout: 5000 }
          );
          // A check the arrow key starts runs in a task queued behind the focus move, so two
          // tasks after focus lands it has run and committed.
          await page.evaluate(async () => {
            for (let task = 0; task < 2; task += 1) {
              await new Promise((resolve) => setTimeout(resolve, 0));
            }
          });
          readings.push({
            key,
            ...(await page.evaluate(() => ({
              focused: document.activeElement?.textContent ?? '',
              checked: [...document.querySelectorAll('#privilege-choice [role="radio"]')]
                .filter((item) => item.getAttribute('aria-checked') === 'true')
                .map((item) => item.textContent),
              changes: globalThis.__privilegeChanges?.length ?? 0,
            }))),
          });
        }

        expect({
          readings,
          changes: await page.evaluate(() => globalThis.__privilegeChanges),
        }).toEqual({
          readings: steps.map(({ key, lands }, index) => ({
            key,
            focused: lands,
            checked: [lands],
            changes: index + 1,
          })),
          changes: ['admin', 'read', 'admin', 'write'],
        });
      } finally {
        await page.close();
      }
    },
    TEST_MS
  );
});

declare global {
  var __mountPrivilegeChoice: (() => void) | undefined;
  var __privilegeChanges: string[] | undefined;
}
