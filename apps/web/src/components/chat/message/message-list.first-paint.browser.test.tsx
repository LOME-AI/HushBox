import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, webkit, type Browser, type Page } from '@playwright/test';
import { TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { startFixtureServer, type FixtureServer } from '@/test-utils/fixture-server';

/**
 * Opens a thread in the real list (real Virtuoso, the app stylesheet, a real engine) and
 * records every animation frame from before the list mounts: where the scroller stood and
 * whether any of the thread was drawn. Rows are fixed-height stand-ins, so nothing but the
 * list's own placement can move them; a page can make the first row short, make every row
 * slow to render, and hold the markdown renderer's module back. The page and its modules are
 * virtual, so no fixture file joins the tree.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, '../../../..');
const SRC_DIR = path.join(WEB_DIR, 'src');
const LIST_FILE = path.join(HERE, 'message-list.tsx');
const ITEM_FILE = path.join(HERE, 'message-item');

const ENTRY_ID = 'virtual:message-list-first-paint-entry';
const ITEM_ID = 'virtual:message-list-first-paint-item';
const RENDERER_ID = 'virtual:message-list-first-paint-renderer';
const RENDERER_FILE = path.join(HERE, 'markdown-renderer');
const PAGE_PATH = '/message-list-first-paint.html';

// A real web font the rows can be set in, served only after a page-chosen delay, so it lands
// after the list's rows first show. The page draws it half as large again, so text set in it wraps
// onto more lines once it arrives, whichever fallback the engine drew first.
const LATE_FACE_PATH = '/late-face.woff2';
const LATE_FACE_FILE = path.resolve(
  WEB_DIR,
  '../../packages/ui/src/styles/fonts/merriweather-latin.woff2'
);

/** The first load compiles the app's whole stylesheet, which a busy machine can make slow. */
const LOAD_MS = 120_000;
const TEST_MS = LOAD_MS + 30_000;

const PAGE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>message list first paint</title></head>
  <body>
    <div id="root"></div>
    <script type="module" src="/@id/${ENTRY_ID}"></script>
  </body>
</html>`;

// `first` is the first row's height, `rest` every other row's, `reply` every odd row's in place of
// `rest`, `slow` how long each row's render keeps the main thread busy, and `block` how long its
// first render alone does. With `relayout`, a row being removed forces a layout, which lands while
// the list's rows are half swapped. With `font`, every row is instead a paragraph set in the late
// face, as tall as its lines wrap.
const ITEM_SOURCE = `
import { createElement as h, useLayoutEffect, useState } from 'react';
const params = new URLSearchParams(location.search);
const first = Number(params.get('first') ?? 160);
const rest = Number(params.get('rest') ?? 160);
const reply = Number(params.get('reply') ?? rest);
const slow = Number(params.get('slow') ?? 0);
const relayout = params.get('relayout') === 'true';
const block = Number(params.get('block') ?? 0);
const lateFace = params.has('font');
const PROSE = ' Every word here is set in the late face, which is drawn larger than the fallback the engine shows first, so this paragraph wraps onto more lines once that face arrives.';
export function MessageItem({ message }) {
  const until = performance.now() + slow;
  while (performance.now() < until) {}
  useState(() => {
    const blockedUntil = performance.now() + block;
    while (performance.now() < blockedUntil) {}
    return block;
  });
  useLayoutEffect(() => () => {
    if (relayout) void document.body.offsetHeight;
  }, []);
  const index = Number(message.id.slice('message-'.length));
  if (lateFace) {
    const style = { fontFamily: '"Late Face", serif', fontSize: '16px', lineHeight: '24px', padding: '8px 16px' };
    return h('p', { 'data-fixture-row': message.id, style }, message.content + PROSE + PROSE);
  }
  const height = index === 0 ? first : index % 2 === 1 ? reply : rest;
  return h('div', { 'data-fixture-row': message.id, style: { height: height + 'px' } }, message.content);
}
`;

// The markdown renderer's module, which the list waits for: it settles `renderer` ms after the
// page asks for it, and records when.
const RENDERER_SOURCE = `
const delay = Number(new URLSearchParams(location.search).get('renderer') ?? 0);
await new Promise((resolve) => setTimeout(resolve, delay));
globalThis.__rendererReadyAt = performance.now();
export function MarkdownRenderer({ content }) {
  return content;
}
`;

const ENTRY_SOURCE = `
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@/app.css';
import { MessageList } from ${JSON.stringify(LIST_FILE)};

const params = new URLSearchParams(location.search);
const count = Number(params.get('count'));
const messages = Array.from({ length: count }, (_, index) => ({
  id: 'message-' + index,
  conversationId: 'conversation',
  role: index % 2 === 0 ? 'user' : 'assistant',
  content: 'Message ' + index,
  createdAt: ${JSON.stringify(isoAt(TEST_DAY_START))},
}));

// With \`font\`, the rows' face, which the server sends that many ms after the page asks for it. It
// swaps in when it lands, as the app's own faces do.
if (params.has('font')) {
  const source = 'url(${LATE_FACE_PATH}?delay=' + params.get('font') + ')';
  document.fonts.add(new FontFace('Late Face', source, { display: 'swap', sizeAdjust: '150%' }));
}

let shift = 0;
if (PerformanceObserver.supportedEntryTypes.includes('layout-shift')) {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) shift += entry.value;
  }).observe({ type: 'layout-shift', buffered: true });
}

// With \`foot\`, the thread closes with a footer that tall, made once so every render hands the list
// the same element.
const foot = Number(params.get('foot') ?? 0);
const footer = h('div', { 'data-fixture-foot': '', style: { height: foot + 'px' } }, 'Thread footer');

const drawn = (element) => element !== null && getComputedStyle(element).visibility === 'visible';

// With \`strand\`, the first time the hidden scroller reaches its end it is moved that far back, where
// it rests: the place Virtuoso's opening scroll leaves a thread when its rows' first render blocks
// the main thread past the scroll's success timer.
const strand = Number(params.get('strand') ?? 0);
let stranded = false;
document.addEventListener('scroll', (event) => {
  const scroller = event.target;
  if (stranded || strand === 0 || !(scroller instanceof HTMLElement)) return;
  if (scroller.dataset.testid !== 'virtuoso-scroller' || drawn(scroller)) return;
  if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 1) return;
  stranded = true;
  scroller.scrollTop -= strand;
}, true);
// With \`slip\`, the first frame that finds the scroller at its end with Virtuoso showing its rows
// moves it that far back, as WebKit's clamp did after the list had decided its thread was placed.
const slip = Number(params.get('slip') ?? 0);
let slipped = false;
const frames = [];
const record = (at) => {
  const scroller = document.querySelector('[data-testid="virtuoso-scroller"]');
  if (scroller !== null) {
    const rows = document.querySelectorAll('[data-fixture-row]');
    const atEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 1;
    const list = document.querySelector('[data-testid="virtuoso-item-list"]');
    const rowsShown = list !== null && list.style.visibility !== 'hidden' && rows.length > 0;
    if (slip > 0 && !slipped && atEnd && rowsShown) {
      slipped = true;
      scroller.scrollTop -= slip;
    }
    const heights = Object.fromEntries([...rows].map((row) => [row.dataset.fixtureRow, row.getBoundingClientRect().height]));
    frames.push({ at, drawn: drawn(scroller), rows: rows.length, top: Math.round(scroller.scrollTop), heights });
  }
  requestAnimationFrame(record);
};
requestAnimationFrame(record);

createRoot(document.getElementById('root')).render(
  h(QueryClientProvider, { client: new QueryClient() },
    h('div', { style: { height: (params.get('height') ?? 600) + 'px', display: 'flex', flexDirection: 'column' } },
      h(MessageList, {
        messages,
        messagesReady: true,
        threadHeader: params.get('head') === 'true' ? h('h1', { 'data-fixture-head': '' }, 'A shared thread') : undefined,
        threadFooter: foot > 0 ? footer : undefined,
      }))));

// Settled once the thread has been drawn and sixty frames have passed without the scroller moving;
// with \`font\`, also not before a second has passed since it was first drawn.
const SETTLED_FRAMES = 60;
const LATER_MS = params.has('font') ? 1000 : 0;
const firstDrawn = () => frames.find((frame) => frame.drawn);
globalThis.__messageList = {
  ready: () => {
    const tail = frames.slice(-SETTLED_FRAMES);
    const settled = tail.length === SETTLED_FRAMES && tail.every((frame) => frame.drawn && frame.top === tail[0].top);
    return settled && performance.now() - firstDrawn().at >= LATER_MS;
  },
  measure: () => {
    const scroller = document.querySelector('[data-testid="virtuoso-scroller"]');
    const rows = [...document.querySelectorAll('[data-fixture-row]')];
    const last = rows.find((row) => row.dataset.fixtureRow === 'message-' + (count - 1));
    const head = document.querySelector('[data-fixture-head]');
    const foot = document.querySelector('[data-fixture-foot]');
    const bottom = scroller.getBoundingClientRect().bottom;
    const footTop = () => foot.getBoundingClientRect().top;
    // Scrolls the settled thread back a little and puts it back, reading how far the footer moved.
    const footMove = () => {
      const settledTop = scroller.scrollTop;
      const before = footTop();
      scroller.scrollTop = settledTop - 120;
      const moved = { scrolled: Math.round(settledTop - scroller.scrollTop), footer: Math.round(footTop() - before) };
      scroller.scrollTop = settledTop;
      return moved;
    };
    // Rows drawn in the first frame that showed the thread whose height has changed since.
    const firstHeights = firstDrawn().heights;
    const grownRows = rows
      .filter((row) => {
        const before = firstHeights[row.dataset.fixtureRow];
        return before !== undefined && Math.abs(row.getBoundingClientRect().height - before) > 0.5;
      })
      .map((row) => row.dataset.fixtureRow);
    return {
      shift,
      grownRows,
      restingTop: Math.round(scroller.scrollTop),
      drawnTops: frames.filter((frame) => frame.drawn).map((frame) => frame.top),
      drawnBeforeRows: frames.some((frame) => frame.drawn && frame.rows === 0),
      firstDrawnAt: frames.find((frame) => frame.drawn)?.at ?? null,
      rendererReadyAt: globalThis.__rendererReadyAt ?? null,
      lastRowInView: last !== undefined && last.getBoundingClientRect().bottom <= bottom,
      headInView: head !== null && head.getBoundingClientRect().top >= scroller.getBoundingClientRect().top,
      footInView: foot !== null && footTop() >= scroller.getBoundingClientRect().top && foot.getBoundingClientRect().bottom <= bottom,
      footAfterLastRow: foot !== null && last !== undefined && footTop() >= last.getBoundingClientRect().bottom,
      distanceToEnd: Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight),
      // The list's closing spacer is a tenth of the viewport tall.
      footerHeight: Math.ceil(innerHeight * 0.1),
      // Last, since it scrolls the thread, though it puts it back.
      footMove: foot === null ? null : footMove(),
    };
  },
};
`;

const VIRTUAL_MODULES = new Map([
  [`\0${ENTRY_ID}`, ENTRY_SOURCE],
  [`\0${ITEM_ID}`, ITEM_SOURCE],
  [`\0${RENDERER_ID}`, RENDERER_SOURCE],
]);

function pageModules(): Plugin {
  return {
    name: 'message-list-first-paint-page',
    enforce: 'pre',
    resolveId(id) {
      if (id === ENTRY_ID) return `\0${id}`;
      // The list's own row is swapped for a fixed-height stand-in.
      const isRow = id === '@/components/chat/message/message-item' || id.startsWith(ITEM_FILE);
      if (isRow) return `\0${ITEM_ID}`;
      const isRenderer =
        id === '@/components/chat/message/markdown-renderer' || id.startsWith(RENDERER_FILE);
      return isRenderer ? `\0${RENDERER_ID}` : undefined;
    },
    load(id) {
      return VIRTUAL_MODULES.get(id);
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = request.url;
        if (url?.startsWith(LATE_FACE_PATH) === true) {
          const delay = Number(new URL(url, 'http://fixture').searchParams.get('delay'));
          void (async (): Promise<void> => {
            try {
              const [face] = await Promise.all([
                readFile(LATE_FACE_FILE),
                new Promise((resolve) => setTimeout(resolve, delay)),
              ]);
              response.setHeader('content-type', 'font/woff2');
              response.end(face);
            } catch (error) {
              next(error);
            }
          })();
          return;
        }
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

interface Opening {
  /** Total layout shift the engine reported, or 0 where it reports none. */
  readonly shift: number;
  /** Rows drawn in the first frame that showed the thread whose height has changed since. */
  readonly grownRows: readonly string[];
  /** Where the scroller rests once the thread has settled. */
  readonly restingTop: number;
  /** The scroller's position in every frame that drew any part of the thread. */
  readonly drawnTops: readonly number[];
  /** Whether any frame showed the scroller, and with it the thread's head or footer, with no row mounted. */
  readonly drawnBeforeRows: boolean;
  /** When the first frame that drew any of the thread ran, or null if none did. */
  readonly firstDrawnAt: number | null;
  /** When the markdown renderer's module settled, or null if the page never asked for it. */
  readonly rendererReadyAt: number | null;
  readonly lastRowInView: boolean;
  /** Whether the thread's heading is drawn with its top inside the scroller. */
  readonly headInView: boolean;
  /** Whether the thread's footer is drawn wholly inside the scroller. */
  readonly footInView: boolean;
  /** Whether the thread's footer starts at or below the bottom of its last row. */
  readonly footAfterLastRow: boolean;
  /** How far the scroller and the footer moved when the settled thread was scrolled back, or null with no footer. */
  readonly footMove: { readonly scrolled: number; readonly footer: number } | null;
  readonly distanceToEnd: number;
  readonly footerHeight: number;
}

declare global {
  var __messageList: { ready: () => boolean; measure: () => Opening } | undefined;
}

/** The thread a page opens: its row count, and the optional knobs the stand-ins read. */
interface Thread {
  readonly count: number;
  readonly first?: number;
  readonly rest?: number;
  readonly reply?: number;
  readonly slow?: number;
  readonly relayout?: boolean;
  readonly block?: number;
  readonly strand?: number;
  readonly slip?: number;
  readonly renderer?: number;
  readonly height?: number;
  /** Whether the thread carries a heading, as a read-only shared page's does. */
  readonly head?: boolean;
  /** How tall a footer closes the thread, in pixels; none when absent. */
  readonly foot?: number;
  /** With it, every row is prose set in a face the server sends this many ms after it is asked. */
  readonly font?: number;
}

const LONG_THREAD: Thread = { count: 30 };

// The live shape that revealed early: a one-line first question and tall replies in a
// phone-sized column, with rows whose render holds the main thread past Virtuoso's 50ms
// at-bottom report throttle.
const SHORT_FIRST_THREAD: Thread = { count: 9, first: 40, rest: 400, slow: 20, height: 555 };

// The same thread under a render long enough that Virtuoso's own settle timer fires before the
// rows' heights reach it, so it shows its rows while the scroller is still at the top.
const SHORT_FIRST_HEAVY_THREAD: Thread = { ...SHORT_FIRST_THREAD, slow: 60 };

// Short questions and tall replies: Virtuoso's first estimate is far off, so it swaps its rows far
// down the thread. WebKit lays the page out while the app's real rows are half swapped; these
// stand-ins force that layout in every engine.
const RELAYOUT_THREAD: Thread = { count: 30, rest: 60, reply: 1700, relayout: true };

// Rows whose first render blocks the main thread, left resting short of the end while hidden, as
// WebKit's live openings were when that block outlasted Virtuoso's opening scroll.
const BLOCKED_THREAD: Thread = { count: 30, block: 40, strand: 900 };

// A long thread that loses its end in the frame after the list decides it is placed.
const SLIPPED_THREAD: Thread = { count: 30, slip: 900 };

// A long thread under a heading, as a read-only shared page draws one.
const HEADED_THREAD: Thread = { ...LONG_THREAD, head: true };

// The same under rows slow enough that Virtuoso's throttled at-bottom report, computed for its
// seed row, lands after the thread is revealed.
const HEADED_SLOW_THREAD: Thread = { ...SHORT_FIRST_THREAD, head: true };

// A long thread closing with a footer taller than the list's closing spacer.
const FOOTED_THREAD: Thread = { ...LONG_THREAD, foot: 320 };

// The same under a heading.
const HEADED_FOOTED_THREAD: Thread = { ...HEADED_THREAD, foot: 320 };

// One reply under a heading and over a footer, taller together than the view.
const ONE_REPLY_THREAD: Thread = { count: 1, first: 600, head: true, foot: 320 };

// One short reply under a heading and over a footer, all of it inside the view.
const ONE_SHORT_REPLY_THREAD: Thread = { count: 1, first: 100, head: true, foot: 320 };

// A thread of prose in a face that lands well after its rows first show and well inside the
// list's wait for it.
const LATE_FACE_THREAD: Thread = { count: 12, font: 700 };

// The same under a heading.
const HEADED_LATE_FACE_THREAD: Thread = { ...LATE_FACE_THREAD, head: true };

type EngineName = 'chromium' | 'webkit';
const ENGINES: readonly EngineName[] = ['chromium', 'webkit'];

describe('the message list opening a thread (real browser)', () => {
  let server: FixtureServer;
  const browsers: Partial<Record<EngineName, Browser>> = {};

  beforeAll(async () => {
    server = await startFixtureServer({
      root: WEB_DIR,
      configFile: false,
      plugins: [pageModules(), react(), tailwindcss()],
      resolve: { alias: [{ find: /^@\/(.*)$/, replacement: path.join(SRC_DIR, '$1') }] },
    });
    const [chromiumBrowser, webkitBrowser] = await Promise.all([
      chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] }),
      webkit.launch(),
    ]);
    browsers.chromium = chromiumBrowser;
    browsers.webkit = webkitBrowser;
  }, LOAD_MS);

  // Closing two browsers and the server can outlast the default hook budget on a busy machine.
  afterAll(async () => {
    await Promise.all(Object.values(browsers).map((browser) => browser.close()));
    await server.close();
  }, LOAD_MS);

  async function openOn(engine: EngineName, thread: Thread): Promise<Opening> {
    const browser = browsers[engine];
    if (browser === undefined) throw new Error(`${engine} did not launch`);
    const page: Page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const query = new URLSearchParams(
      Object.entries(thread).map(([key, value]) => [key, String(value)])
    );
    try {
      await page.goto(`${server.url}${PAGE_PATH}?${query.toString()}`, {
        waitUntil: 'commit',
        timeout: LOAD_MS,
      });
      await page.waitForFunction(() => globalThis.__messageList?.ready() === true, undefined, {
        timeout: LOAD_MS,
      });
      return await page.evaluate(() => {
        if (globalThis.__messageList === undefined) throw new TypeError('the page is not ready');
        return globalThis.__messageList.measure();
      });
    } finally {
      await page.close();
    }
  }

  describe.each(ENGINES)('on %s', (engine) => {
    it(
      'opens a long thread at its end',
      async () => {
        const opening = await openOn(engine, LONG_THREAD);
        expect(opening.lastRowInView).toBe(true);
        expect(opening.distanceToEnd).toBeLessThanOrEqual(opening.footerHeight);
      },
      TEST_MS
    );

    it(
      'opens a long thread at its end when a layout runs while its rows are swapped',
      async () => {
        const opening = await openOn(engine, RELAYOUT_THREAD);
        expect(opening.lastRowInView).toBe(true);
        expect(opening.distanceToEnd).toBeLessThanOrEqual(opening.footerHeight);
      },
      TEST_MS
    );

    it(
      'opens a long thread at its end when its rows block the main thread on their first render',
      async () => {
        const opening = await openOn(engine, BLOCKED_THREAD);
        expect(opening.lastRowInView).toBe(true);
        expect(opening.distanceToEnd).toBeLessThanOrEqual(opening.footerHeight);
      },
      TEST_MS
    );

    it(
      'opens a long thread at its end when the scroller slips back after reaching it',
      async () => {
        const opening = await openOn(engine, SLIPPED_THREAD);
        expect(opening.drawnTops.every((top) => top === opening.restingTop)).toBe(true);
        expect(opening.distanceToEnd).toBeLessThanOrEqual(opening.footerHeight);
      },
      TEST_MS
    );

    it(
      'draws a long thread only where it comes to rest',
      async () => {
        const opening = await openOn(engine, LONG_THREAD);
        expect(new Set(opening.drawnTops)).toEqual(new Set([opening.restingTop]));
      },
      TEST_MS
    );

    it(
      'draws a thread whose first row is short only where it comes to rest',
      async () => {
        const opening = await openOn(engine, SHORT_FIRST_THREAD);
        expect(new Set(opening.drawnTops)).toEqual(new Set([opening.restingTop]));
      },
      TEST_MS
    );

    it(
      'draws no frame of a thread whose first row is short before its rows mount',
      async () => {
        const opening = await openOn(engine, SHORT_FIRST_THREAD);
        expect(opening.drawnBeforeRows).toBe(false);
      },
      TEST_MS
    );

    it(
      'draws a thread whose rows are slow to render only where it comes to rest',
      async () => {
        const opening = await openOn(engine, SHORT_FIRST_HEAVY_THREAD);
        expect(new Set(opening.drawnTops)).toEqual(new Set([opening.restingTop]));
      },
      TEST_MS
    );

    it(
      'opens a long thread with a heading at its top, with the heading in view',
      async () => {
        const opening = await openOn(engine, HEADED_THREAD);
        expect([opening.restingTop, opening.headInView]).toEqual([0, true]);
      },
      TEST_MS
    );

    it(
      'keeps a thread with a heading at its top when its rows are slow to render',
      async () => {
        const opening = await openOn(engine, HEADED_SLOW_THREAD);
        expect(new Set(opening.drawnTops)).toEqual(new Set([0]));
      },
      TEST_MS
    );

    it(
      'draws a long thread with a heading only at its top',
      async () => {
        const opening = await openOn(engine, HEADED_THREAD);
        expect(new Set(opening.drawnTops)).toEqual(new Set([0]));
      },
      TEST_MS
    );

    it(
      'opens a long thread with a footer at its end, with the footer in view',
      async () => {
        const opening = await openOn(engine, FOOTED_THREAD);
        expect([opening.footInView, opening.distanceToEnd <= opening.footerHeight]).toEqual([
          true,
          true,
        ]);
      },
      TEST_MS
    );

    it(
      'draws the footer of a thread under its last row',
      async () => {
        const opening = await openOn(engine, FOOTED_THREAD);
        expect(opening.footAfterLastRow).toBe(true);
      },
      TEST_MS
    );

    it(
      'moves the footer of a thread with its scroll',
      async () => {
        const opening = await openOn(engine, FOOTED_THREAD);
        expect(opening.footMove).toEqual({ scrolled: 120, footer: 120 });
      },
      TEST_MS
    );

    it(
      'draws a long thread with a footer only where it comes to rest',
      async () => {
        const opening = await openOn(engine, FOOTED_THREAD);
        expect(new Set(opening.drawnTops)).toEqual(new Set([opening.restingTop]));
      },
      TEST_MS
    );

    it(
      'draws a long thread with a heading and a footer only at its top, with the heading in view',
      async () => {
        const opening = await openOn(engine, HEADED_FOOTED_THREAD);
        expect([[...new Set(opening.drawnTops)], opening.headInView]).toEqual([[0], true]);
      },
      TEST_MS
    );

    it(
      'draws one reply with a heading and a footer taller than the view only at its top',
      async () => {
        const opening = await openOn(engine, ONE_REPLY_THREAD);
        expect([[...new Set(opening.drawnTops)], opening.headInView]).toEqual([[0], true]);
      },
      TEST_MS
    );

    it(
      'draws one short reply with a heading and a footer at its top, the footer in view',
      async () => {
        const opening = await openOn(engine, ONE_SHORT_REPLY_THREAD);
        expect([[...new Set(opening.drawnTops)], opening.headInView, opening.footInView]).toEqual([
          [0],
          true,
          true,
        ]);
      },
      TEST_MS
    );

    it(
      "draws a thread's rows at their final height when a face they use loads late",
      async () => {
        const opening = await openOn(engine, LATE_FACE_THREAD);
        expect(opening.grownRows).toEqual([]);
      },
      TEST_MS
    );

    it(
      "draws a thread with a heading's rows at their final height when a face they use loads late",
      async () => {
        const opening = await openOn(engine, HEADED_LATE_FACE_THREAD);
        expect(opening.grownRows).toEqual([]);
      },
      TEST_MS
    );

    it(
      'draws a thread only once the markdown renderer has loaded',
      async () => {
        const opening = await openOn(engine, { ...LONG_THREAD, renderer: 1500 });
        expect(opening.rendererReadyAt).not.toBeNull();
        expect(opening.firstDrawnAt).toBeGreaterThanOrEqual(opening.rendererReadyAt ?? Infinity);
      },
      TEST_MS
    );
  });

  it(
    'opens a long thread without a layout shift',
    async () => {
      const opening = await openOn('chromium', LONG_THREAD);
      expect(opening.shift).toBe(0);
    },
    TEST_MS
  );

  it(
    'opens a long thread with a footer without a layout shift',
    async () => {
      const opening = await openOn('chromium', FOOTED_THREAD);
      expect(opening.shift).toBe(0);
    },
    TEST_MS
  );

  it(
    'opens a long thread with a heading without a layout shift',
    async () => {
      const opening = await openOn('chromium', HEADED_THREAD);
      expect(opening.shift).toBe(0);
    },
    TEST_MS
  );
});
