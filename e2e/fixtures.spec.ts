import { existsSync } from 'node:fs';

import { TIMEOUTS } from './config/timeouts.js';
import { expectApiErrors, expectConsoleErrors, instrumentPage, test, expect } from './fixtures.js';
import { matrix } from '../scripts/lib/playwright/browser-matrix.js';
import type { Browser, BrowserContext, Page } from './fixtures.js';

const SPEC_MATRIX = matrix({
  engine: 'engine-any',
  formFactor: 'either',
  reason:
    'Every guardrail asserted here is a Playwright-driver mechanism — a console listener, a context route — installed and read node-side, so no rendering engine takes part in the decision under test.',
});

const UNREAD_NO_STORE_MATRIX = matrix({
  engine: 'engine-pinned',
  pinnedEngine: 'chromium',
  formFactor: 'desktop',
  reason:
    'Only this engine never finishes loading a no-store fetch body the page leaves unread, so only here can a teardown that waits on that body hang. Firefox and WebKit finish the load, and on them this proof passes whether or not teardown waits.',
});

const REFUSED_FETCH_LINE_MATRIX = matrix({
  engine: 'engine-pinned',
  pinnedEngine: 'chromium',
  formFactor: 'desktop',
  reason:
    'The proof needs a refused fetch logged as an error-level console entry whose source is the request URL. Firefox logs no such entry, so it cannot run this; WebKit logs one, but the matrix pins no engine but this one.',
});

const REFUSED_CONNECTION_LINE_MATRIX = matrix({
  engine: 'engine-pinned',
  pinnedEngine: 'chromium',
  formFactor: 'desktop',
  reason:
    'The proof needs a routed connection refusal logged as an error-level console entry whose source is the request URL. Firefox logs no entry for it, and WebKit reports a routed refusal as blocked by its inspector, at info level.',
});

const DISPOSAL_MATRIX = matrix({
  engine: 'engine-any',
  formFactor: 'either',
  reason:
    'Disposal is a runner fixture closing contexts node-side, and the driver writes each HAR on that close, so no rendering engine takes part in whether the disposal runs.',
});

/**
 * A host no name server can answer: `.invalid` is reserved for exactly that
 * (RFC 2606), so this request can never leave the machine for a real third
 * party whether the allowlist aborts it or not. That is what makes it safe to
 * point a page at from the test asserting the allowlist is what stops it.
 */
const NON_ALLOWLISTED_URL = 'http://blocked.invalid/probe';

/** The console text the guard is provoked with, distinct enough to assert on. */
const PROVOKED_CONSOLE_TEXT = 'provoked console error for the page-guardrail proof';

/**
 * A page and an API response the test serves itself through page routes, on a
 * host no name server can answer (see {@link NON_ALLOWLISTED_URL}). Nothing
 * here reaches the dev stack, so the API-error guard is provoked by a refusal
 * this test fully controls rather than by an endpoint that must be persuaded
 * to fail.
 */
const PROBE_ORIGIN = 'http://probe.invalid';
const PROBE_PAGE_URL = `${PROBE_ORIGIN}/probe.html`;
const PROBE_API_URL = `${PROBE_ORIGIN}/api/probe`;
const PROBE_PAGE_BODY = '<html><body>page-guardrail probe</body></html>';

/**
 * The refusal code the body-keyed allowance below matches on, and the body
 * carrying it. One constant for both, so the allowance cannot drift from the
 * response it is written against.
 */
const PROBE_API_ERROR_CODE = 'PROVOKED_API_REFUSAL_CODE';
const PROBE_API_BODY = `{"code":"${PROBE_API_ERROR_CODE}"}`;

/**
 * A URL whose one load the page aborts, and a longer URL it is a prefix of. The
 * console error the noise test provokes names the aborted URL exactly; the one
 * the prefix test provokes names only the longer URL.
 */
const ABORTED_URL = `${PROBE_ORIGIN}/a/`;
const EXTENDED_URL = `${ABORTED_URL}b`;

/** A URL whose first load the page aborts and whose second load is refused. */
const RELOADED_URL = `${PROBE_ORIGIN}/r`;

/** A context with no stored session, so these probes carry no persona. */
const blankContext = (browser: Browser): Promise<BrowserContext> =>
  browser.newContext({ storageState: { cookies: [], origins: [] } });

/** Serves the probe page, so the page's own fetches resolve against the probe origin. */
async function serveProbePage(page: Page): Promise<void> {
  await page.route(PROBE_PAGE_URL, (route) =>
    route.fulfill({ contentType: 'text/html', body: PROBE_PAGE_BODY })
  );
}

/**
 * Starts a fetch of `url`, which the caller's route holds unanswered, and
 * cancels it from the page once the request has been issued. Resolves when the
 * network layer has reported the abort, the event the console guard correlates.
 */
async function abortOneLoad(page: Page, url: string): Promise<void> {
  const requested = page.waitForEvent('request', (request) => request.url() === url);
  const controller = await page.evaluateHandle((target) => {
    const abortController = new AbortController();
    // The rejection is the abort being provoked; unhandled, it would reach the
    // console guard as an uncaught page error.
    fetch(target, { signal: abortController.signal }).catch(() => undefined);
    return abortController;
  }, url);
  await requested;
  const aborted = page.waitForEvent('requestfailed', (request) => request.url() === url);
  await controller.evaluate((abortController) => {
    abortController.abort();
  });
  await aborted;
}

/**
 * The per-page guardrails, proven by provocation rather than by reading the
 * fixture that installs them.
 *
 * Each test drives {@link instrumentPage} — the one function every page
 * fixture in `e2e/fixtures.ts` installs its guardrails and runs its verdict
 * through — and awaits that verdict itself, because a guardrail's whole
 * observable behaviour is the failure it raises there. A test cannot observe
 * its own fixture teardown failing, so the verdict is called in the test
 * body, where its rejection is assertable.
 */
test.describe('Page guardrails', SPEC_MATRIX, () => {
  test('fails on a console error when the network allowlist is skipped', async ({
    browser,
  }, testInfo) => {
    const context = await blankContext(browser);
    const page = await context.newPage();
    const { finish } = instrumentPage(context, page, testInfo, {
      label: 'console-guard-probe',
      networkAllowlist: false,
    });

    await page.evaluate((text: string) => {
      console.error(text);
    }, PROVOKED_CONSOLE_TEXT);

    await expect(finish()).rejects.toThrow(PROVOKED_CONSOLE_TEXT);
  });

  test('leaves the page open when its verdict fails the test', async ({ browser }, testInfo) => {
    const context = await blankContext(browser);
    const page = await context.newPage();
    const { finish } = instrumentPage(context, page, testInfo, {
      label: 'verdict-leaves-page-open-probe',
    });

    await page.evaluate((text: string) => {
      console.error(text);
    }, PROVOKED_CONSOLE_TEXT);

    await expect(finish()).rejects.toThrow(PROVOKED_CONSOLE_TEXT);
    expect(page.isClosed()).toBe(false);
  });

  test('fails on a non-allowlisted request when the network allowlist is installed', async ({
    browser,
  }, testInfo) => {
    const context = await blankContext(browser);
    const page = await context.newPage();
    const { finish } = instrumentPage(context, page, testInfo, {
      label: 'allowlist-guard-probe',
    });

    // Aborted by the allowlist, which is why the navigation itself fails and
    // why the teardown below has a violation to report.
    await expect(page.goto(NON_ALLOWLISTED_URL)).rejects.toThrow();

    await expect(finish()).rejects.toThrow('blocked.invalid');
  });

  test('fails on a refused API response that arrives as the test is ending', async ({
    browser,
  }, testInfo) => {
    const context = await blankContext(browser);
    const page = await context.newPage();
    const { finish } = instrumentPage(context, page, testInfo, {
      label: 'api-error-late-probe',
      networkAllowlist: false,
      extraApiUrl: (url) => url === PROBE_API_URL,
    });
    // Chromium and WebKit log the refused fetch as a resource-load console
    // error carrying the request's URL as its source; scoped to this probe's
    // own request, so nothing else on the page is masked. Firefox logs none.
    expectConsoleErrors(page, [(error) => error.url === PROBE_API_URL]);
    // The allowlist is off for this page, so these page routes shadow nothing:
    // they are what serves the probe, not a bypass of a guard.
    await page.route(PROBE_PAGE_URL, (route) =>
      route.fulfill({ contentType: 'text/html', body: PROBE_PAGE_BODY })
    );
    await page.route(PROBE_API_URL, (route) => route.fulfill({ status: 400, body: '{}' }));
    await page.goto(PROBE_PAGE_URL, { waitUntil: 'domcontentloaded' });

    // The refusal is provoked and the teardown reached in the same turn: the
    // guard's listener has seen the response, and the body read it folds in
    // needs a round trip to the browser, so this is the window in which a
    // captured failure is at risk of being read past.
    const responded = page.waitForEvent('response', (r) => r.url() === PROBE_API_URL);
    await page.evaluate((url) => {
      void fetch(url);
    }, PROBE_API_URL);
    await responded;

    await expect(finish()).rejects.toThrow(/API:\s+\S+ 400 Bad Request GET/);
  });

  test('admits a late-arriving refused response by an allowance that matches only its body', async ({
    browser,
  }, testInfo) => {
    const context = await blankContext(browser);
    const page = await context.newPage();
    const { finish } = instrumentPage(context, page, testInfo, {
      label: 'api-error-body-allowance-probe',
      networkAllowlist: false,
      extraApiUrl: (url) => url === PROBE_API_URL,
    });
    // Deliberately carries no status-line pattern, which is the shape an
    // allowance takes when the response body is the only thing distinguishing
    // the refusal the test provokes from one it does not expect. It can admit
    // the entry only if the body is part of that entry when the verdict is
    // computed.
    expectApiErrors(page, [new RegExp(PROBE_API_ERROR_CODE)]);
    expectConsoleErrors(page, [(error) => error.url === PROBE_API_URL]);
    await page.route(PROBE_PAGE_URL, (route) =>
      route.fulfill({ contentType: 'text/html', body: PROBE_PAGE_BODY })
    );
    await page.route(PROBE_API_URL, (route) =>
      route.fulfill({ status: 400, contentType: 'application/json', body: PROBE_API_BODY })
    );
    await page.goto(PROBE_PAGE_URL, { waitUntil: 'domcontentloaded' });

    // Same window as the late-arrival probe: the refusal is provoked and the
    // teardown reached in the same turn, so the body read is still outstanding
    // when teardown begins.
    const responded = page.waitForEvent('response', (r) => r.url() === PROBE_API_URL);
    await page.evaluate((url) => {
      void fetch(url);
    }, PROBE_API_URL);
    await responded;

    await expect(finish()).resolves.toBeUndefined();
  });

  test('records no violation for a non-allowlisted request when the allowlist is skipped', async ({
    browser,
  }, testInfo) => {
    const context = await blankContext(browser);
    const page = await context.newPage();
    const { finish } = instrumentPage(context, page, testInfo, {
      label: 'allowlist-skipped-probe',
      networkAllowlist: false,
    });
    // The navigation is provoked to fail (the host resolves nowhere), and an
    // engine that logs that failure to the console would otherwise fail this
    // page at teardown on a guardrail other than the one under test. Scoped to
    // this probe's own URL, so nothing else on the page is masked.
    expectConsoleErrors(page, [NON_ALLOWLISTED_URL]);

    await expect(page.goto(NON_ALLOWLISTED_URL)).rejects.toThrow();

    await expect(finish()).resolves.toBeUndefined();
  });

  test('fails on a console error naming a URL that merely begins with an aborted one', async ({
    browser,
  }, testInfo) => {
    const context = await blankContext(browser);
    const page = await context.newPage();
    const { finish } = instrumentPage(context, page, testInfo, {
      label: 'abort-prefix-probe',
      networkAllowlist: false,
    });
    await serveProbePage(page);
    await page.route(ABORTED_URL, () => {
      // Never answered: the page's own cancel is what ends this load.
    });
    await page.goto(PROBE_PAGE_URL, { waitUntil: 'domcontentloaded' });
    await abortOneLoad(page, ABORTED_URL);

    await page.evaluate((url) => {
      console.error(`request failed: ${url}`);
    }, EXTENDED_URL);

    await expect(finish()).rejects.toThrow(EXTENDED_URL);
  });

  test('drops a console error naming exactly a URL whose load was aborted', async ({
    browser,
  }, testInfo) => {
    const context = await blankContext(browser);
    const page = await context.newPage();
    const { finish } = instrumentPage(context, page, testInfo, {
      label: 'abort-noise-probe',
      networkAllowlist: false,
    });
    await serveProbePage(page);
    await page.route(ABORTED_URL, () => {
      // Never answered: the page's own cancel is what ends this load.
    });
    await page.goto(PROBE_PAGE_URL, { waitUntil: 'domcontentloaded' });
    await abortOneLoad(page, ABORTED_URL);

    await page.evaluate((url) => {
      console.error(`request failed: ${url}`);
    }, ABORTED_URL);

    await expect(finish()).resolves.toBeUndefined();
  });
});

test.describe('Page guardrails on an unread no-store body', UNREAD_NO_STORE_MATRIX, () => {
  test('lets teardown finish past a status-allowed no-store refusal the page never reads', async ({
    browser,
  }, testInfo) => {
    const context = await blankContext(browser);
    const page = await context.newPage();
    const { finish } = instrumentPage(context, page, testInfo, {
      label: 'api-error-unread-no-store-probe',
      networkAllowlist: false,
      extraApiUrl: (url) => url === PROBE_API_URL,
    });
    expectConsoleErrors(page, [(error) => error.url === PROBE_API_URL]);
    expectApiErrors(page, [/404 Not Found GET \S+\/api\/probe$/m]);
    await serveProbePage(page);
    // The header every API error response carries.
    await page.route(PROBE_API_URL, (route) =>
      route.fulfill({
        status: 404,
        contentType: 'application/json',
        headers: { 'cache-control': 'private, no-store' },
        body: PROBE_API_BODY,
      })
    );
    await page.goto(PROBE_PAGE_URL, { waitUntil: 'domcontentloaded' });

    const responded = page.waitForEvent('response', (r) => r.url() === PROBE_API_URL);
    await page.evaluate((url) => {
      void fetch(url);
    }, PROBE_API_URL);
    await responded;

    await expect(finish()).resolves.toBeUndefined();
  });
});

test.describe('Page guardrails on a reloaded URL', REFUSED_FETCH_LINE_MATRIX, () => {
  test('fails on a refused load of a URL whose earlier load was aborted', async ({
    browser,
  }, testInfo) => {
    const context = await blankContext(browser);
    const page = await context.newPage();
    const { finish } = instrumentPage(context, page, testInfo, {
      label: 'abort-then-refusal-probe',
      networkAllowlist: false,
    });
    await serveProbePage(page);
    // The later route is consulted first and lapses after one request, so the
    // first load is held for the page to cancel and the second is refused.
    // Not empty: Chromium cancels an empty-body fetch the page leaves unread, and
    // that abort, landing after the refusal's console line, would account for it.
    await page.route(RELOADED_URL, (route) => route.fulfill({ status: 500, body: PROBE_API_BODY }));
    await page.route(
      RELOADED_URL,
      () => {
        // Never answered: the page's own cancel is what ends this load.
      },
      { times: 1 }
    );
    await page.goto(PROBE_PAGE_URL, { waitUntil: 'domcontentloaded' });
    await abortOneLoad(page, RELOADED_URL);

    const logged = page.waitForEvent(
      'console',
      (message) => message.type() === 'error' && message.location().url === RELOADED_URL
    );
    await page.evaluate((url) => {
      void fetch(url);
    }, RELOADED_URL);
    await logged;

    await expect(finish()).rejects.toThrow(/status of 500/);
  });
});

test.describe(
  'Page guardrails on a reloaded URL refused at connection',
  REFUSED_CONNECTION_LINE_MATRIX,
  () => {
    test('fails on a connection refusal of a URL whose earlier load was aborted', async ({
      browser,
    }, testInfo) => {
      const context = await blankContext(browser);
      const page = await context.newPage();
      const { finish } = instrumentPage(context, page, testInfo, {
        label: 'abort-then-connection-refusal-probe',
        networkAllowlist: false,
      });
      await serveProbePage(page);
      // The later route is consulted first and lapses after one request, so the
      // first load is held for the page to cancel and the second is refused.
      await page.route(RELOADED_URL, (route) => route.abort('connectionrefused'));
      await page.route(
        RELOADED_URL,
        () => {
          // Never answered: the page's own cancel is what ends this load.
        },
        { times: 1 }
      );
      await page.goto(PROBE_PAGE_URL, { waitUntil: 'domcontentloaded' });
      await abortOneLoad(page, RELOADED_URL);

      const logged = page.waitForEvent(
        'console',
        (message) => message.type() === 'error' && message.location().url === RELOADED_URL
      );
      await page.evaluate((url) => {
        // Unhandled, the rejection would fail teardown as an uncaught page error
        // whatever the console guard decides about the refusal's own line.
        fetch(url).catch(() => undefined);
      }, RELOADED_URL);
      await logged;

      await expect(finish()).rejects.toThrow(
        'Failed to load resource: net::ERR_CONNECTION_REFUSED'
      );
    });
  }
);

/** The contexts a stalled test instrumented, and the HAR file each records to. */
interface StalledContexts {
  contexts: BrowserContext[];
  harPaths: string[];
}

const stallingTest = test.extend<{ stalledContexts: StalledContexts }>({
  // Requested by the test, so it is set up after the disposal auto fixture and
  // torn down before it. Its teardown stands in for a page verdict that hangs.
  stalledContexts: async ({ browser }, use, testInfo) => {
    const stalled: StalledContexts = { contexts: [], harPaths: [] };
    for (const label of ['stalled-teardown-first', 'stalled-teardown-second']) {
      const harPath = testInfo.outputPath(`${label}.har`);
      const context = await browser.newContext({
        storageState: { cookies: [], origins: [] },
        recordHar: { path: harPath },
      });
      instrumentPage(context, await context.newPage(), testInfo, { label, harPath });
      stalled.contexts.push(context);
      stalled.harPaths.push(harPath);
    }
    await use(stalled);
    // Teardown runs in a slot sized to the larger of the project's timeout and
    // the test's, so only a resize made from inside that slot shortens it.
    testInfo.setTimeout(TIMEOUTS.QUICK);
    await new Promise<never>(() => {
      // Never settles: the slot's timeout is what ends this teardown.
    });
  },
});

stallingTest.describe(
  'Context disposal after a teardown that exhausts the test slot',
  DISPOSAL_MATRIX,
  () => {
    // eslint-disable-next-line no-restricted-syntax -- serial: the second test reads the contexts and HAR paths the first test's stalled teardown left, which only the same worker, running the two in order, holds
    stallingTest.describe.configure({ mode: 'serial' });

    const left: StalledContexts = { contexts: [], harPaths: [] };

    // The body fails before the stalled teardown times out, so the test ends
    // `failed`, which `fail` accepts; the timeout alone would end it `timedOut`.
    stallingTest.fail(
      'fails with a teardown that stalls until its slot is spent',
      ({ stalledContexts }) => {
        left.contexts.push(...stalledContexts.contexts);
        left.harPaths.push(...stalledContexts.harPaths);
        expect(stalledContexts.contexts.map((context) => context.isClosed())).toEqual([
          false,
          false,
        ]);
        throw new Error('the failure this test is declared to have');
      }
    );

    stallingTest('disposes of every context the stalled test left', () => {
      expect(left.contexts.map((context) => context.isClosed())).toEqual([true, true]);
      expect(left.harPaths.map((harPath) => existsSync(harPath))).toEqual([true, true]);
    });
  }
);
