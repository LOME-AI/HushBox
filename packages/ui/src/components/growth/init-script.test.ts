import { describe, it, expect, afterEach, vi } from 'vitest';
import { Window } from 'happy-dom';
import {
  createEnvUtilities,
  deriveEventName,
  GROWTH_BEACON_PATH,
  GROWTH_CLICK_SELECTOR,
  GROWTH_SCROLL_EVENTS,
  MARKETING_BASE_URL,
} from '@hushbox/shared';
import { envConfig, Mode, resolveRaw } from '@hushbox/shared/env.config';
import { growthInitScript, GROWTH_INIT_SCRIPT } from './init-script';
import type { Element } from 'happy-dom';
import type { EventNameElement } from '@hushbox/shared';

const MARKETING_ORIGIN = new URL(MARKETING_BASE_URL).origin;

/** The one request shape the script issues: a JSON body, always a string. */
type BeaconRequest = RequestInit & { readonly body: string };

interface SentBeacon {
  readonly path: string;
  readonly init: BeaconRequest;
  readonly body: Record<string, string>;
}

interface PageOptions {
  readonly html?: string;
  readonly referrer?: string;
  /** Together these decide how far the page can be scrolled; happy-dom lays nothing out. */
  readonly scrollHeight?: number;
  readonly clientHeight?: number;
  /** Stands in for the network when a test is about what a failed send does. */
  readonly send?: () => Promise<Response>;
  /** The script body to run, when it is not the one a production build emits. */
  readonly script?: string;
}

interface Page {
  readonly window: Window;
  readonly sent: readonly SentBeacon[];
}

const opened: Window[] = [];

/**
 * Load `url` in a window of its own and run the inline script against it, the
 * way the browser parses it out of the built page.
 *
 * A window per page rather than the suite's shared one: the script attaches
 * listeners to `document` and `window` and hands back no way to detach them,
 * so two pages sharing a window would each count the other's clicks.
 */
function openPage(url: string, options: PageOptions = {}): Page {
  const window = new Window({ url });
  opened.push(window);
  const sent: SentBeacon[] = [];
  window.document.body.innerHTML = options.html ?? '';
  window.document.addEventListener('click', (event) => {
    event.preventDefault();
  });
  defineReadOnly(window.document, 'referrer', options.referrer ?? '');
  defineReadOnly(window.document.documentElement, 'scrollHeight', options.scrollHeight ?? 1000);
  defineReadOnly(window.document.documentElement, 'clientHeight', options.clientHeight ?? 200);
  defineReadOnly(window, 'scrollY', 0);

  const send =
    options.send ?? ((): Promise<Response> => Promise.resolve(new Response(null, { status: 204 })));
  const fetchStub = (path: string, init: BeaconRequest): Promise<Response> => {
    sent.push({ path, init, body: JSON.parse(init.body) as Record<string, string> });
    return send();
  };

  // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- intentional: this test exists to execute the inline script source the same way the built page does, and the only way to give it the page's globals is to name them as parameters
  const run = new Function(
    'window',
    'document',
    'location',
    'fetch',
    'URL',
    'URLSearchParams',
    options.script ?? GROWTH_INIT_SCRIPT
  ) as (...globals: unknown[]) => void;
  run(window, window.document, window.location, fetchStub, URL, URLSearchParams);
  return { window, sent };
}

function defineReadOnly(target: object, property: string, current: unknown): void {
  Object.defineProperty(target, property, { configurable: true, get: () => current });
}

/** Scroll `page` to `offset` and let the script's listener see it. */
function scrollTo(page: Page, offset: number): void {
  defineReadOnly(page.window, 'scrollY', offset);
  page.window.dispatchEvent(new page.window.Event('scroll'));
}

/** Dispatch a click on `element` the way a pointer would. */
function clickElement(page: Page, element: Element): void {
  element.dispatchEvent(new page.window.MouseEvent('click', { bubbles: true, cancelable: true }));
}

/** Click the first element in `page` matching `selector`. */
function click(page: Page, selector: string): void {
  const element = page.window.document.querySelector(selector);
  expect(element, `no element matches ${selector}`).not.toBeNull();
  if (element !== null) clickElement(page, element);
}

/** The names of the events among a page's beacons, in the order they were sent. */
function eventNames(page: Page): (string | undefined)[] {
  return page.sent.filter((beacon) => beacon.body['t'] === 'e').map((beacon) => beacon.body['n']);
}

/** The `href` the page now carries on the element matching `selector`. */
function href(page: Page, selector: string): string | null | undefined {
  return page.window.document.querySelector(selector)?.getAttribute('href');
}

afterEach(async () => {
  for (const window of opened.splice(0)) await window.happyDOM.close();
  vi.unstubAllGlobals();
});

describe('GROWTH_INIT_SCRIPT', () => {
  describe('where it runs', () => {
    it('sends a pageview for the current path on the marketing host', () => {
      const page = openPage(`${MARKETING_ORIGIN}/welcome`);
      expect(page.sent[0]?.path).toBe(GROWTH_BEACON_PATH);
      expect(page.sent[0]?.body).toEqual({ t: 'v', p: '/welcome' });
    });

    // The same marketing build is served inside the admin origin for the click
    // overlay. That copy must never count, or an operator reading the dashboard
    // would inflate the numbers the dashboard reports.
    it('sends nothing when the hostname is not the marketing host', () => {
      const page = openPage('https://admin.hushbox.ai/preview/welcome', {
        html: '<button id="cta">Go</button>',
      });
      click(page, '#cta');
      scrollTo(page, 1000);
      expect(page.sent).toEqual([]);
    });
  });

  describe('the pageview', () => {
    it('carries the referrer hostname', () => {
      const page = openPage(`${MARKETING_ORIGIN}/welcome`, {
        referrer: 'https://news.ycombinator.com/item?id=1',
      });
      expect(page.sent[0]?.body).toEqual({ t: 'v', p: '/welcome', r: 'news.ycombinator.com' });
    });

    it('drops a referrer that is the marketing host itself', () => {
      const page = openPage(`${MARKETING_ORIGIN}/privacy`, {
        referrer: `${MARKETING_ORIGIN}/welcome`,
      });
      expect(page.sent[0]?.body).toEqual({ t: 'v', p: '/privacy' });
    });

    it('carries the campaign tag from the address bar', () => {
      const page = openPage(`${MARKETING_ORIGIN}/welcome?c=podcast-ep-4`);
      expect(page.sent[0]?.body).toEqual({ t: 'v', p: '/welcome', c: 'podcast-ep-4' });
    });

    it('drops a campaign tag no campaign could ever be named', () => {
      const page = openPage(`${MARKETING_ORIGIN}/welcome?c=NOT%20A%20TAG`);
      expect(page.sent[0]?.body).toEqual({ t: 'v', p: '/welcome' });
    });
  });

  describe('the transport', () => {
    it('posts a keepalive, credential-free, preflight-free request', () => {
      const page = openPage(`${MARKETING_ORIGIN}/welcome`);
      expect(page.sent[0]?.init).toMatchObject({
        method: 'POST',
        keepalive: true,
        credentials: 'omit',
        headers: { 'Content-Type': 'text/plain' },
      });
    });

    // A beacon is at-most-once from the client's side: a retry would double a
    // count nothing downstream could tell from real traffic, and a rejected
    // request must never surface as an unhandled rejection on a marketing page.
    it('does not retry a rejected send', async () => {
      const page = openPage(`${MARKETING_ORIGIN}/welcome`, {
        send: () => Promise.reject(new Error('offline')),
      });
      await Promise.resolve();
      expect(page.sent).toHaveLength(1);
    });
  });

  describe('the campaign tag on links', () => {
    it('rewrites every same-origin link to carry the tag', () => {
      const page = openPage(`${MARKETING_ORIGIN}/welcome?c=podcast-ep-4`, {
        html: '<a id="one" href="/privacy">Privacy</a><a id="two" href="/terms?x=1">Terms</a>',
      });
      expect(href(page, '#one')).toBe('/privacy?c=podcast-ep-4');
      expect(href(page, '#two')).toBe('/terms?x=1&c=podcast-ep-4');
    });

    it('leaves a cross-origin link alone', () => {
      const page = openPage(`${MARKETING_ORIGIN}/welcome?c=podcast-ep-4`, {
        html: '<a id="out" href="https://github.com/hushbox">Source</a>',
      });
      expect(href(page, '#out')).toBe('https://github.com/hushbox');
    });

    it('leaves a link that already names a tag alone', () => {
      const page = openPage(`${MARKETING_ORIGIN}/welcome?c=podcast-ep-4`, {
        html: '<a id="own" href="/privacy?c=other">Privacy</a>',
      });
      expect(href(page, '#own')).toBe('/privacy?c=other');
    });

    it('rewrites nothing when the address bar carries no tag', () => {
      const page = openPage(`${MARKETING_ORIGIN}/welcome`, {
        html: '<a id="one" href="/privacy">Privacy</a>',
      });
      expect(href(page, '#one')).toBe('/privacy');
    });
  });

  describe('auto-captured clicks', () => {
    const derivations: readonly (readonly [string, string, string])[] = [
      ['the override attribute', '<button data-track="Hero CTA" id="x">Start</button>', 'hero-cta'],
      ['the element id', '<button id="hero_cta">Start</button>', 'hero_cta'],
      ['a link destination', '<a href="/signup">Start</a>', 'link:/signup'],
      [
        'an external link host',
        '<a href="https://github.com/hushbox">Source</a>',
        'link:github.com',
      ],
      ['the accessible label', '<button aria-label="Open menu"></button>', 'open-menu'],
      ['the visible copy', '<button>Start for free</button>', 'start-for-free'],
    ];

    it.each(derivations)('names a click by %s', (_label, html, expected) => {
      const page = openPage(`${MARKETING_ORIGIN}/welcome`, { html });
      click(page, 'a,button');
      expect(eventNames(page)).toEqual([expected]);
    });

    it('sends the event with the page path and the campaign tag', () => {
      const page = openPage(`${MARKETING_ORIGIN}/welcome?c=podcast-ep-4`, {
        html: '<button id="cta">Start</button>',
      });
      click(page, '#cta');
      expect(page.sent.at(-1)?.body).toEqual({
        t: 'e',
        n: 'cta',
        p: '/welcome',
        c: 'podcast-ep-4',
      });
    });

    it('counts a click on a child of the link under the link', () => {
      const page = openPage(`${MARKETING_ORIGIN}/welcome`, {
        html: '<a href="/signup"><span id="in">Start</span></a>',
      });
      click(page, '#in');
      expect(eventNames(page)).toEqual(['link:/signup']);
    });

    // The autocapture failure mode this design exists to make impossible: a
    // name derived from something a person typed. No form control is a link or
    // a button, so nothing the delegated listener resolves can read one.
    it('sends no event for a click on a form input', () => {
      const page = openPage(`${MARKETING_ORIGIN}/newsletter`, {
        html: '<form><input id="email" type="email" /><textarea id="note"></textarea><select id="pick"><option>a</option></select></form>',
      });
      click(page, '#email');
      click(page, '#note');
      click(page, '#pick');
      expect(eventNames(page)).toEqual([]);
    });

    it('sends no event for a click on ordinary copy', () => {
      const page = openPage(`${MARKETING_ORIGIN}/welcome`, {
        html: '<p id="prose">Nothing to click here</p>',
      });
      click(page, '#prose');
      expect(eventNames(page)).toEqual([]);
    });

    it('sends no event for an element that yields no legal name', () => {
      const page = openPage(`${MARKETING_ORIGIN}/welcome`, { html: '<button>   </button>' });
      click(page, 'button');
      expect(eventNames(page)).toEqual([]);
    });
  });

  describe('scroll depth', () => {
    it('sends each threshold once as the page is read down', () => {
      const page = openPage(`${MARKETING_ORIGIN}/blog`);
      expect(eventNames(page)).toEqual([]);
      scrollTo(page, 200);
      scrollTo(page, 400);
      scrollTo(page, 800);
      expect(eventNames(page)).toEqual([...GROWTH_SCROLL_EVENTS]);
    });

    it('sends a threshold no more than once however often it is crossed', () => {
      const page = openPage(`${MARKETING_ORIGIN}/blog`);
      scrollTo(page, 400);
      scrollTo(page, 0);
      scrollTo(page, 400);
      expect(eventNames(page)).toEqual(['scroll-25', 'scroll-50']);
    });

    it('counts a page with nothing to scroll as read to the end', () => {
      const page = openPage(`${MARKETING_ORIGIN}/terms`, { scrollHeight: 600, clientHeight: 600 });
      expect(eventNames(page)).toEqual([...GROWTH_SCROLL_EVENTS]);
    });
  });

  describe('the script itself', () => {
    it('is small enough to inline in every marketing page', () => {
      expect(new TextEncoder().encode(GROWTH_INIT_SCRIPT).byteLength).toBeLessThan(3072);
    });

    it('runs before bundles load, so it names no module system', () => {
      expect(GROWTH_INIT_SCRIPT).not.toMatch(/\bimport\s+/u);
      expect(GROWTH_INIT_SCRIPT).not.toMatch(/\bexport\s+/u);
      expect(GROWTH_INIT_SCRIPT).not.toMatch(/\brequire\s*\(/u);
    });

    // The promise is that nothing lands on the device — no cookie, no storage
    // of any class — and that nothing a person typed is ever read. Asserted
    // over the script's own text, because that is what a reviewer reads and
    // what an auditor greps.
    it.each(['Storage', 'cookie', 'indexedDB', 'value'])('never names %s', (forbidden) => {
      expect(GROWTH_INIT_SCRIPT).not.toContain(forbidden);
    });
  });

  // The build's allowlist is derived by the shared function and the script
  // derives the name it sends. A disagreement drops real events silently, so
  // the two are held against each other over a page built from the function's
  // own chain of sources rather than from a list somebody remembered to extend.
  describe('agreement with the shared derivation', () => {
    /** A probe answer that is already a legal event name for the source carrying it. */
    function probeValue(source: string): string {
      return source === 'href' ? '/signup' : `probe-${source}`;
    }

    /**
     * The attributes {@link deriveEventName} reads off an element, in the order
     * it asks for them, taken from the function itself: it is handed an element
     * that answers nothing, so it walks its whole chain, and that element
     * records what it was asked for.
     *
     * Derived rather than written down so that a source added to the function
     * joins the fixture with no case written — the transcription in
     * {@link GROWTH_INIT_SCRIPT} then yields nothing on that element and the
     * agreement below goes red.
     *
     * What this can see follows from what the probe is: one bare `<button>`,
     * every attribute answering `null`, no copy, nothing matched. So the list
     * is the attributes the function asks of that element on that path, and a
     * branch stays invisible here whenever it turns on something the probe does
     * not vary — what the function does with an answer, what it asks only once
     * an answer has come back, what it asks only of an element this probe is
     * not. The reading is one-directional too: the page is derived from the
     * function, so a source {@link GROWTH_INIT_SCRIPT} reads and the function
     * does not leaves no trace here. And a source the function stops reading
     * leaves this page along with it, which is one of the jobs
     * {@link PRIORITY_PAGE} is kept for.
     */
    function nameSources(): readonly string[] {
      const asked: string[] = [];
      const probe: EventNameElement = {
        tagName: 'button',
        textContent: null,
        getAttribute(attribute: string): string | null {
          asked.push(attribute);
          return null;
        },
      };
      deriveEventName(probe);
      return asked;
    }

    /** One element per source, carrying that source alone so nothing else can name it. */
    function elementFor(source: string): string {
      const value = probeValue(source);
      return source === 'href'
        ? `<a href="${value}"></a>`
        : `<button ${source}="${value}"></button>`;
    }

    const DERIVED_SOURCES = nameSources();
    const DERIVED_PAGE = DERIVED_SOURCES.map((source) => elementFor(source)).join('\n      ');

    /**
     * Kept rather than superseded by the derived page, which is a page of
     * single-source elements and so shows neither which source wins when
     * several are present, nor the fall-throughs a source's own value decides —
     * a destination that names no page, a trailing slash, an override that
     * cannot be made legal, an element that yields nothing at all. It also
     * catches a source the function stops reading, which vanishes from the
     * derived page rather than failing it: drop the id read and the button
     * carrying both an id and a label reds the agreement below.
     */
    const PRIORITY_PAGE = `
      <a href="/signup" data-track="Hero CTA">Start free</a>
      <a href="/privacy">Privacy policy</a>
      <a href="https://github.com/hushbox">Read the source</a>
      <a href="mailto:hello@hushbox.ai">Email us</a>
      <a href="#main">Skip to content</a>
      <a href="/blog/">Blog</a>
      <button id="openMenu" aria-label="Open the menu"></button>
      <button aria-label="Dismiss">x</button>
      <button>Load more posts</button>
      <button data-track="not a legal *name*">Fallback</button>
      <button>   </button>
    `;

    const FIXTURE_PAGE = `${DERIVED_PAGE}${PRIORITY_PAGE}`;

    it('derives the same name for every element on a fixture page', () => {
      const page = openPage(`${MARKETING_ORIGIN}/welcome`, { html: FIXTURE_PAGE });
      const elements = [...page.window.document.querySelectorAll(GROWTH_CLICK_SELECTOR)];
      const observed = elements.map((element) => {
        const before = eventNames(page).length;
        clickElement(page, element);
        const after = eventNames(page);
        return after.length > before ? (after.at(-1) ?? null) : null;
      });
      expect(observed).toEqual(elements.map((element) => deriveEventName(element)));
      expect(observed.filter((name) => name !== null)).toHaveLength(elements.length - 1);
    });

    // A source whose element names nothing tests nothing, so the fixture would
    // still pass while covering less than it appears to — the failure a derived
    // fixture inherits from the hand-written one unless it is asserted away.
    it('exercises every source it derives', () => {
      const page = openPage(`${MARKETING_ORIGIN}/welcome`, { html: DERIVED_PAGE });
      const unnamed = DERIVED_SOURCES.filter((source) => {
        const element = page.window.document.querySelector(`[${source}]`);
        return element === null || deriveEventName(element) === null;
      });
      expect(DERIVED_SOURCES).not.toHaveLength(0);
      expect(unnamed).toEqual([]);
    });
  });
});

/** The hostname every local stack serves from, whichever service holds the port. */
const LOCAL_HOSTNAME = 'localhost';

const MARKETING_HOSTNAME = new URL(MARKETING_BASE_URL).hostname;

/**
 * The hostnames `ADMIN_URL` is spelled with in the environment registry, before
 * `scripts/generate-env.ts` rewrites each `<service>.localhost` to its allocated
 * `localhost:<port>`. Only the deployed one is a hostname the admin interface
 * answers on: a local stack collapses every service onto {@link LOCAL_HOSTNAME},
 * which a local build admits, so the framed copy's silence there is the
 * production build's property rather than this guard's.
 */
const ADMIN_HOSTNAMES = [
  ...new Set(
    Object.values(Mode)
      .map((mode) => resolveRaw(envConfig.ADMIN_URL, mode))
      .filter((value): value is string => typeof value === 'string')
      .map((value) => new URL(value).hostname)
  ),
];

/**
 * The hostnames each build is driven against: the two it may admit,
 * {@link ADMIN_HOSTNAMES}, and one that is nobody's.
 */
const PROBE_HOSTNAMES = [
  ...new Set([MARKETING_HOSTNAME, LOCAL_HOSTNAME, ...ADMIN_HOSTNAMES, 'example.com']),
];

/**
 * Every mode a marketing build is emitted under, with the hostnames its beacon
 * counts on.
 *
 * The mode reaches the layouts as Vite's own `MODE`, which names the stack the
 * build was made for — `development`, `e2e` or `test` for a local stack,
 * `production` for the deployed site — and the layouts resolve it through
 * `createEnvUtilities` before asking for the script. Every local stack serves
 * marketing at `localhost`, because `scripts/generate-env.ts` rewrites each
 * `<service>.localhost` in the environment registry to its allocated
 * `localhost:<port>`, so a build for one has to count there or the beacon is
 * inert everywhere the site is served outside production.
 */
const BUILD_MODES = [
  { mode: 'development', admits: [MARKETING_HOSTNAME, LOCAL_HOSTNAME] },
  { mode: 'e2e', admits: [MARKETING_HOSTNAME, LOCAL_HOSTNAME] },
  { mode: 'test', admits: [MARKETING_HOSTNAME, LOCAL_HOSTNAME] },
  { mode: 'production', admits: [MARKETING_HOSTNAME] },
] as const;

/** The script the build for `mode` emits. */
function scriptFor(mode: string): string {
  return growthInitScript(createEnvUtilities({ NODE_ENV: mode }));
}

/** Whether a page at `hostname` running `script` sends anything. */
function counts(script: string, hostname: string): boolean {
  return openPage(`https://${hostname}/welcome`, { script }).sent.length > 0;
}

describe('growthInitScript', () => {
  it.each(BUILD_MODES)(
    'counts on exactly the hostnames a $mode build admits',
    ({ mode, admits }) => {
      const script = scriptFor(mode);
      expect(PROBE_HOSTNAMES.filter((hostname) => counts(script, hostname))).toEqual([...admits]);
    }
  );

  // The marketing site is built a second time for the admin origin to frame, so
  // the copy an operator reads has the beacon in it. It counting would inflate
  // the very numbers the dashboard beside it reports, which is the whole reason
  // the guard exists.
  it.each(BUILD_MODES)('sends nothing on an admin hostname under $mode', ({ mode }) => {
    const script = scriptFor(mode);
    expect(ADMIN_HOSTNAMES.filter((hostname) => counts(script, hostname))).toEqual([]);
  });

  // `apps/marketing/scripts/growth-index.ts` decides whether a built page
  // renders the beacon by looking for GROWTH_INIT_SCRIPT in that page's HTML.
  // A build whose script did not carry it verbatim would match no page, and the
  // extractor raises on a build in which no page renders the beacon, which
  // fails the deploy that runs it as the Worker's build command and the CI
  // drift check that runs it over a production build.
  it.each(BUILD_MODES)('carries the production script verbatim under $mode', ({ mode }) => {
    expect(scriptFor(mode)).toContain(GROWTH_INIT_SCRIPT);
  });

  it.each(BUILD_MODES)(
    'is small enough to inline in every marketing page under $mode',
    ({ mode }) => {
      expect(new TextEncoder().encode(scriptFor(mode)).byteLength).toBeLessThan(3072);
    }
  );
});
