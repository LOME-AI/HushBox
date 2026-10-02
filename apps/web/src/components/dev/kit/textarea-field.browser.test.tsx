import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, firefox, type Browser, type Page } from '@playwright/test';
import { startFixtureServer, type FixtureServer } from '@/test-utils/fixture-server';
import type { Plugin } from 'vite';

/**
 * Measures textareas in real engines, under the app stylesheet, once text is put into them: a
 * `TextareaField` and a bare `Textarea` each in a plain block, and the kit's counted field in the
 * kit's grid. How wide a box ends up from what it holds is layout, which no test DOM computes.
 *
 * Chromium and Firefox, the engines CI installs, driven through `@playwright/test` over a fixture
 * server; the page and its entry are virtual modules, so no fixture file joins the tree.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, '../../../..');
const SRC_DIR = path.join(WEB_DIR, 'src');
const SECTION_FILE = path.join(HERE, 'choices.section.tsx');

const ENTRY_ID = 'virtual:textarea-field-entry';
const PAGE_PATH = '/textarea-field.html';

/** The first load compiles the app's whole stylesheet, which a busy machine can make slow. */
const LOAD_MS = 90_000;
const TEST_MS = LOAD_MS + 60_000;
const CLOSE_MS = 45_000;

/** How far two measured widths may differ and still be the same width. */
const SAME_PX = 0.5;

const VIEWPORTS = [
  { width: 320, height: 700 },
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
] as const;

/** One unbroken run of 2,000 characters, the kind a pasted link or token is. */
const UNBROKEN = 'hushbox'.repeat(286).slice(0, 2000);

/** Ordinary prose, long enough to wrap onto several lines at every viewport. */
const PROSE =
  "I'm a backend engineer who works mostly in TypeScript and Postgres. Be concise, lead with the answer, and show code before explaining it. Use metric units. When you're unsure, say so instead of guessing.";

const FIELD_LABEL = 'Notes';
const BARE_LABEL = 'Bare textarea';
const KIT_LABEL = 'What should every model know?';

const PAGE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>textarea field</title></head>
  <body>
    <div id="root"></div>
    <script type="module" src="/@id/${ENTRY_ID}"></script>
  </body>
</html>`;

// Each subject sits in a block marked `data-subject`, whose width is the width the textarea
// should keep. The app's document never scrolls (html and body clip their overflow), so the
// content sits in an overflow-y-auto region, as every scrolling surface in the app does, and a
// box wider than that region shows as its sideways scroll. The textareas are controlled, as
// every shipping caller's is: the sizing replica follows `value`, so an uncontrolled textarea
// never sizes from typed text at all.
const ENTRY_SOURCE = `
import { createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@/app.css';
import { Textarea } from '@hushbox/ui';
import { TextareaField } from '@hushbox/ui/field';
import section from ${JSON.stringify(SECTION_FILE)};

function Field() {
  const [value, setValue] = useState('');
  return h(TextareaField, {
    label: ${JSON.stringify(FIELD_LABEL)},
    rows: 3,
    value,
    onChange: (event) => setValue(event.target.value),
  });
}

function Bare() {
  const [value, setValue] = useState('');
  return h(Textarea, {
    'aria-label': ${JSON.stringify(BARE_LABEL)},
    value,
    onChange: (event) => setValue(event.target.value),
  });
}

createRoot(document.getElementById('root')).render(
  h(
    'div',
    {
      'data-scroll-region': '',
      style: {
        position: 'fixed',
        inset: 0,
        overflowY: 'auto',
        padding: '1rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '1.5rem',
      },
    },
    h('div', { 'data-subject': 'field' }, h(Field)),
    h('div', { 'data-subject': 'bare' }, h(Bare)),
    h('div', { 'data-subject': 'kit' }, section.render())
  )
);
`;

function pageModules(): Plugin {
  return {
    name: 'textarea-field-page',
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

type EngineName = 'chromium' | 'firefox';
const ENGINES: readonly EngineName[] = ['chromium', 'firefox'];

type Viewport = (typeof VIEWPORTS)[number];

/**
 * The subjects the page draws, each found by its textarea's accessible name. A subject's container
 * is its `data-subject` block, or, for a field the kit draws, the kit cell captioned `cell`.
 */
const SUBJECTS = [
  { name: 'a TextareaField', subject: 'field', label: FIELD_LABEL, cell: null },
  { name: 'a bare Textarea', subject: 'bare', label: BARE_LABEL, cell: null },
  {
    name: "the kit's counted TextareaField",
    subject: 'kit',
    label: KIT_LABEL,
    cell: 'counted textarea',
  },
] as const;

type Subject = (typeof SUBJECTS)[number];

interface TextareaReading {
  /** The subject's container, whose width is the width the textarea should keep. */
  containerWidth: number;
  width: number;
  height: number;
  /** The textarea's content height against its client box: taller means it scrolls inside. */
  scrollHeight: number;
  clientHeight: number;
  /** The page's scroll region's scroll width against its client width: wider scrolls sideways. */
  pageScrollWidth: number;
  pageClientWidth: number;
}

interface SubjectReadings {
  empty: TextareaReading;
  filled: TextareaReading;
}

async function readTextarea(page: Page, subject: Subject): Promise<TextareaReading> {
  const textarea = page.getByRole('textbox', { name: subject.label, exact: true });
  return textarea.evaluate((element, { subject: which, cell }) => {
    let container = document.querySelector(`[data-subject="${which}"]`);
    if (cell !== null) {
      // A kit cell is a caption paragraph followed by the sample it captions.
      container = element.parentElement;
      while (container !== null && container.firstElementChild?.textContent !== cell) {
        container = container.parentElement;
      }
    }
    const region = document.querySelector('[data-scroll-region]');
    if (!(element instanceof HTMLTextAreaElement) || container === null || region === null) {
      throw new TypeError(`no textarea in subject ${which}`);
    }
    const box = element.getBoundingClientRect();
    return {
      containerWidth: container.getBoundingClientRect().width,
      width: box.width,
      height: box.height,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      pageScrollWidth: region.scrollWidth,
      pageClientWidth: region.clientWidth,
    };
  }, subject);
}

/**
 * Loads a fresh page at a viewport, reads a subject empty, inserts `text` into it in one input
 * event, as a paste does, and reads it again; each read forces the engine to lay the text out.
 */
async function fillAndRead(
  where: { browser: Browser; origin: string; viewport: Viewport },
  subject: Subject,
  text: string
): Promise<SubjectReadings> {
  const { browser, origin, viewport } = where;
  const page = await browser.newPage({ viewport });
  try {
    await page.goto(`${origin}${PAGE_PATH}`, { timeout: LOAD_MS });
    const textarea = page.getByRole('textbox', { name: subject.label, exact: true });
    await textarea.waitFor({ timeout: LOAD_MS });
    await page.evaluate(() => document.fonts.ready);
    const empty = await readTextarea(page, subject);
    await textarea.focus();
    await page.keyboard.insertText(text);
    await page.waitForFunction(
      ({ element, length }) =>
        element instanceof HTMLTextAreaElement && element.value.length >= length,
      { element: await textarea.elementHandle(), length: text.length }
    );
    const filled = await readTextarea(page, subject);
    return { empty, filled };
  } finally {
    await page.close();
  }
}

describe('a textarea holding text, in a real engine', () => {
  let server: FixtureServer;
  const browsers: Partial<Record<EngineName, Browser>> = {};

  beforeAll(async () => {
    server = await startFixtureServer({
      root: WEB_DIR,
      configFile: false,
      plugins: [react(), tailwindcss(), pageModules()],
      resolve: { alias: [{ find: /^@\/(.*)$/, replacement: path.join(SRC_DIR, '$1') }] },
      watch: null,
      closeBudgetMs: CLOSE_MS,
    });
    const [chromiumBrowser, firefoxBrowser] = await Promise.all([
      chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] }),
      firefox.launch(),
    ]);
    browsers.chromium = chromiumBrowser;
    browsers.firefox = firefoxBrowser;
  }, TEST_MS);

  afterAll(async () => {
    await Promise.all(Object.values(browsers).map((browser) => browser.close()));
    await server.close();
  }, CLOSE_MS + 15_000);

  function pageAt(
    engine: EngineName,
    viewport: Viewport
  ): { browser: Browser; origin: string; viewport: Viewport } {
    const browser = browsers[engine];
    if (browser === undefined) throw new Error(`${engine} did not launch`);
    return { browser, origin: server.url, viewport };
  }

  describe.each(ENGINES)('on %s', (engine) => {
    describe.each(VIEWPORTS)('at $width px', (viewport) => {
      describe.each(SUBJECTS)('$name, given a 2,000-character unbroken string', (subject) => {
        let readings: Promise<SubjectReadings> | undefined;
        const readingsOf = async (): Promise<SubjectReadings> => {
          readings ??= fillAndRead(pageAt(engine, viewport), subject, UNBROKEN);
          return readings;
        };

        it(
          "keeps its container's width",
          async () => {
            const { filled } = await readingsOf();

            expect(Math.abs(filled.width - filled.containerWidth)).toBeLessThanOrEqual(SAME_PX);
          },
          TEST_MS
        );

        it(
          'wraps the string onto more lines than it had',
          async () => {
            const { empty, filled } = await readingsOf();

            expect(filled.height).toBeGreaterThan(empty.height);
          },
          TEST_MS
        );

        it(
          'leaves the page without a horizontal scroll',
          async () => {
            const { filled } = await readingsOf();

            expect(filled.pageScrollWidth).toBeLessThanOrEqual(filled.pageClientWidth);
          },
          TEST_MS
        );
      });

      describe.each(SUBJECTS)('$name, given ordinary prose', (subject) => {
        let readings: Promise<SubjectReadings> | undefined;
        const readingsOf = async (): Promise<SubjectReadings> => {
          readings ??= fillAndRead(pageAt(engine, viewport), subject, PROSE);
          return readings;
        };

        it(
          'keeps the width it had empty',
          async () => {
            const { empty, filled } = await readingsOf();

            expect(Math.abs(filled.width - empty.width)).toBeLessThanOrEqual(SAME_PX);
          },
          TEST_MS
        );

        it(
          'grows to show every line without scrolling',
          async () => {
            const { filled } = await readingsOf();

            expect(filled.scrollHeight).toBeLessThanOrEqual(filled.clientHeight);
          },
          TEST_MS
        );
      });
    });
  });
});
