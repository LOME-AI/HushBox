import { existsSync } from 'node:fs';

import { apiPort, isApiUrl } from './api-origin.js';
import { formatNetworkViolations, type NetworkViolation } from './network-allowlist.js';

import type { BrowserContext, Page, Request, Response, TestInfo } from '@playwright/test';

/**
 * Network `errorText` families for an in-flight load cancelled by navigation,
 * page close, or an `AbortController` — `net::ERR_ABORTED` (Chromium),
 * `NS_BINDING_ABORTED` / `NS_ERROR_DOM_BAD_URI` (Firefox — the latter is what
 * Firefox reports when a request is abandoned because the document began
 * unloading, e.g. a key prefetch firing as the page navigates away), and
 * `Load request cancelled` (WebKit). The single source of truth for "a dropped
 * load is teardown noise": the console correlation marks these requests' URLs
 * aborted, and `DEFAULT_API_ALLOW` derives its network-channel allowance from
 * the same list.
 */
const ABORT_ERROR_TEXTS = [
  'net::ERR_ABORTED',
  'NS_BINDING_ABORTED',
  'NS_ERROR_DOM_BAD_URI',
  'Load request cancelled',
];

/**
 * Per page, the network events the console guard weighs each console error
 * against: every load the network layer reported as aborted, and every
 * response it delivered or failure other than an abort it reported, each keyed
 * by its exact URL and stamped with its place in the page's event order, the
 * sequence {@link ConsoleEntry.order} also draws from. Teardown reads it to
 * drop the resource-load console error an engine emits for a cancelled load —
 * browser-agnostically, keyed on the abort *fact* rather than each engine's
 * console prose (a Firefox font download, a script, a stylesheet) — while a
 * later load of the same URL that fails on its own still surfaces, because its
 * response or its failure lies between the abort and its error. A script or
 * stylesheet refused by status is itself reported aborted right after its
 * console error on Chromium and WebKit, as is a refused fetch with an empty body
 * the page leaves unread on Chromium, so those errors are dropped as well.
 */
interface NetworkOrder {
  aborts: Map<string, number[]>;
  separators: Map<string, number[]>;
}
const networkOrders = new WeakMap<Page, NetworkOrder>();

/**
 * A captured console error, the `location().url` it came from (`''` for an
 * uncaught page error), and its place in the page's event order. Text and
 * source travel together so the abort correlation never has to index two
 * parallel arrays.
 */
interface ConsoleEntry {
  text: string;
  url: string;
  order: number;
}

/**
 * A console-error allowance that reads the error's source URL as well as its
 * text. An engine's generic resource-load line ("Failed to load resource: the
 * server responded with a status of 404") is the same string whatever failed,
 * so a text-only allowance for it covers every URL on the page; a matcher is
 * how such an allowance is held to the one origin it was written for. `url` is
 * `''` for an uncaught page error, which carries no source.
 */
export type ConsoleErrorMatcher = (error: { text: string; url: string }) => boolean;

function recordAt(byUrl: Map<string, number[]>, url: string, order: number): void {
  const orders = byUrl.get(url);
  if (orders === undefined) {
    byUrl.set(url, [order]);
    return;
  }
  orders.push(order);
}

export function attachConsoleErrors(page: Page): { entries: ConsoleEntry[]; cleanup: () => void } {
  const entries: ConsoleEntry[] = [];
  const network: NetworkOrder = { aborts: new Map(), separators: new Map() };
  networkOrders.set(page, network);
  let eventCount = 0;
  const nextOrder = (): number => {
    eventCount += 1;
    return eventCount;
  };
  const onConsole = (msg: {
    type: () => string;
    text: () => string;
    location: () => { url: string };
  }): void => {
    if (msg.type() !== 'error') return;
    entries.push({ text: msg.text(), url: msg.location().url, order: nextOrder() });
  };
  const onPageError = (err: Error): void => {
    entries.push({ text: `[UNCAUGHT] ${err.message}`, url: '', order: nextOrder() });
  };
  const onRequestFailed = (request: Request): void => {
    const errorText = request.failure()?.errorText ?? '';
    const isAbort = ABORT_ERROR_TEXTS.some((token) => errorText.includes(token));
    recordAt(isAbort ? network.aborts : network.separators, request.url(), nextOrder());
  };
  const onResponse = (response: Response): void => {
    recordAt(network.separators, response.url(), nextOrder());
  };
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('requestfailed', onRequestFailed);
  page.on('response', onResponse);
  return {
    entries,
    cleanup: () => {
      page.off('console', onConsole);
      page.off('pageerror', onPageError);
      page.off('requestfailed', onRequestFailed);
      page.off('response', onResponse);
      networkOrders.delete(page);
    },
  };
}

const API_ERROR_BODY_CAP = 2000;

/**
 * Capture backend responses (API host:port, see {@link isApiUrl}) with status
 * >= 400 and network-level request failures. Body fetch is wrapped in
 * try/catch because streaming responses
 * (SSE) can't be re-read after the fact and `response.text()` rejects.
 * Mirror of `attachConsoleErrors` — same lifecycle, same attach pattern on
 * test failure, surfaced as `api-errors-<label>` test attachment.
 *
 * `extraApiUrl` widens the capture to an additional API origin the default
 * predicate can't see — the admin SPA's `/api` vite proxy, where browser-side
 * admin API traffic carries the admin dev-server host:port, not `HB_API_PORT`.
 */
export function attachApiErrors(
  page: Page,
  extraApiUrl?: (url: string) => boolean
): {
  errors: string[];
  settle: (needsBody: (line: string) => boolean) => Promise<void>;
  cleanup: () => void;
} {
  const errors: string[] = [];
  const isCapturedApiUrl = (url: string): boolean => isApiUrl(url) || extraApiUrl?.(url) === true;
  /**
   * Every body read started for this page, keyed by the index of the line it
   * folds its body into — what {@link settle} chooses from, the second half of
   * the ordering constraint below.
   */
  const bodyReads = new Map<number, Promise<void>>();
  // Ordering constraint, not a style choice, and it has two halves because a
  // Playwright event handler cannot block while the body needs a round trip to
  // the browser. An entry pushed only once its body read resolved would be
  // appended to an array {@link judgePage} has already read, losing a
  // failure that arrives late in a test — so the entry lands synchronously
  // here. An allowance may key on the body alone, and one evaluated against an
  // entry whose body has not landed yet admits nothing — so teardown settles
  // the reads of the entries no allowance admits on their status line before
  // it judges, and waits on no other read: Chromium never finishes loading a
  // `no-store` body the page leaves unread, and every API error response is
  // `no-store`, so a read no verdict needs could hold teardown until the test
  // times out.
  const foldBodyIn = async (response: Response, index: number, line: string): Promise<void> => {
    // Streaming responses (SSE) can't be re-read after the fact and
    // `response.text()` rejects; swallow that into an empty body.
    const body = await response.text().catch(() => '');
    if (body === '') return;
    errors[index] = `${line}\n  body: ${body.slice(0, API_ERROR_BODY_CAP)}`;
  };
  const onResponse = (response: Response): void => {
    const url = response.url();
    if (!isCapturedApiUrl(url)) return;
    const status = response.status();
    if (status < 400) return;
    const time = new Date().toISOString();
    const method = response.request().method();
    const line = `${time} ${String(status)} ${response.statusText()} ${method} ${url}`;
    const index = errors.length;
    errors.push(line);
    bodyReads.set(index, foldBodyIn(response, index, line));
  };
  const onRequestFailed = (request: Request): void => {
    const url = request.url();
    if (!isCapturedApiUrl(url)) return;
    const failure = request.failure();
    errors.push(
      `${new Date().toISOString()} NETWORK_FAILED ${request.method()} ${url} — ${failure?.errorText ?? 'unknown'}`
    );
  };
  page.on('response', onResponse);
  page.on('requestfailed', onRequestFailed);
  return {
    errors,
    // One pass over the reads started by the time it is called, never a loop
    // that drains until none is left: a page still being answered at teardown
    // — a poll refusing on a revoked session — would feed such a loop for as
    // long as it kept refusing.
    settle: async (needsBody) => {
      await Promise.all(
        errors.flatMap((line, index) => {
          const read = bodyReads.get(index);
          return read !== undefined && needsBody(line) ? [read] : [];
        })
      );
    },
    cleanup: () => {
      page.off('response', onResponse);
      page.off('requestfailed', onRequestFailed);
    },
  };
}

/**
 * Joiner per labeled-artifact prefix. `api-errors` uses a blank line between
 * entries because each entry can include a multi-line response body that
 * would visually merge into the next entry under a single `\n`.
 */
const ARTIFACT_JOINER: Record<'console-errors' | 'api-errors', string> = {
  'console-errors': '\n',
  'api-errors': '\n\n',
};

/**
 * Per-page opt-out lists for tests that intentionally provoke console/API
 * errors. By default, any uncaught console error or unsuccessful API response
 * fails the test at teardown — this catches regressions like the chat stream
 * parse failure and the `/chat/new` 404 prefetch without per-test boilerplate.
 *
 * Tests that need to allow specific patterns call `expectConsoleErrors(page, [...])`
 * or `expectApiErrors(page, [...])`. WeakMap keying means the lists are
 * garbage-collected with the page itself.
 */
interface AllowList {
  console: (RegExp | ConsoleErrorMatcher)[];
  api: RegExp[];
}
const pageAllowList = new WeakMap<Page, AllowList>();

function getAllowList(page: Page): AllowList {
  let list = pageAllowList.get(page);
  if (list === undefined) {
    list = { console: [], api: [] };
    pageAllowList.set(page, list);
  }
  return list;
}

function toRegExp(pattern: string | RegExp): RegExp {
  return typeof pattern === 'string' ? new RegExp(pattern, 'i') : pattern;
}

/**
 * Opt a page out of failing on console errors that the test **purposely**
 * provokes — e.g. a wrong-password assertion that surfaces a friendly error
 * banner, or a test that revokes a share link and then visits it.
 *
 * Do NOT use this to hide real application problems (accessibility hints,
 * `setState`-in-render warnings, hydration errors, etc.). Those should
 * surface as failures so they get fixed at the source. If a console error
 * fires on a test that isn't intentionally producing it, the right move is
 * to fix the app code, not to suppress the warning here.
 *
 * Patterns match each captured console line independently. Pass substrings
 * (matched case-insensitively), RegExps, or a {@link ConsoleErrorMatcher} for
 * an allowance that must also hold the error's source URL. Call before any
 * action that might produce the error.
 */
export function expectConsoleErrors(
  page: Page,
  patterns: (string | RegExp | ConsoleErrorMatcher)[]
): void {
  const list = getAllowList(page);
  list.console.push(...patterns.map((p) => (typeof p === 'string' ? toRegExp(p) : p)));
}

/**
 * Opt a page out of failing on API errors that the test **purposely**
 * provokes — e.g. a test that posts an invalid TOTP code and asserts the
 * 400 response, or a test that fetches a deliberately-nonexistent share
 * link and asserts the 404.
 *
 * Do NOT use this to hide real application problems (unexpected 4xx/5xx
 * responses from endpoints the test isn't deliberately exercising). Those
 * should surface as failures. Match precisely on `<status> <method> <url>`
 * (and optionally the body's `code`) so the opt-out can only mask the
 * exact request the test is asserting against — not other failures on the
 * same page.
 *
 * Patterns match each captured error line independently. Each line includes
 * the status code, method and URL and, whenever the response body is
 * re-readable, that body on the lines after it. Teardown waits for a body only
 * when no pattern admits the line without it, so a pattern may key on the body
 * alone, and a pattern that anchors the end of the status line with `$` needs
 * the `m` flag to go on admitting the line if its body lands. Call before any
 * action that might produce the error.
 */
export function expectApiErrors(page: Page, patterns: (string | RegExp)[]): void {
  const list = getAllowList(page);
  list.api.push(...patterns.map((p) => toRegExp(p)));
}

/**
 * Universally-allowed API errors. The navigation-cancel families come straight
 * from the single {@link ABORT_ERROR_TEXTS} source the console correlation also
 * keys on — a request dropped because the page navigated, closed, or its
 * `AbortController` fired is teardown noise on both channels, never an app
 * concern. (`ABORT_ERROR_TEXTS` entries are fixed literals with no regex
 * metacharacters, so they interpolate directly.)
 */
const DEFAULT_API_ALLOW: RegExp[] = [
  ...ABORT_ERROR_TEXTS.map((text) => new RegExp(`NETWORK_FAILED .* — ${text}`)),
  // A workerd/wrangler worker restart under host saturation answers an in-flight
  // request with a bare, CORS-headerless 503 — the runtime envelope, not an app
  // response — which fails the fetch at the network layer. Each engine names the
  // CORS block differently (Chromium "Preflight response is not successful",
  // WebKit "Origin … is not allowed by Access-Control-Allow-Origin"), so this
  // keys on the shared 503 fact, not the prose. Reads recover via the app-wide
  // query retry; the failed attempt is still logged. Scoped to 503 so a genuine
  // app/CORS 4xx still fails. See e2e/CLAUDE.md rule 2.10 (surface, not fail).
  /NETWORK_FAILED .* — .*Status code: 503/,
  // A transient network-level drop of an idempotent GET read (a workerd recycle
  // or a navigation-cancel under saturation severs the socket before any
  // response). The app's TanStack Query layer retries reads and recovers, so the
  // data still loads — and a read that genuinely never loads fails the test's own
  // assertion (the awaited message/element never appears). Scoped to GET so a
  // dropped mutation (non-idempotent, not auto-retried) still surfaces. Keyed on
  // the method + API host:port fact (backend routes are bare — no `/api/`
  // prefix), independent of each engine's errorText prose. Built from
  // `HB_API_PORT` so worktree-offset ports stay correct.
  new RegExp(String.raw`NETWORK_FAILED GET .*(?:localhost|127\.0\.0\.1):${apiPort}/`),
  // The same saturation sever on a *mutation*, where the socket drops with a
  // bare connection-failure errorText (no status reaches the client, so this is
  // distinct from the 503 envelope above). Every mutation is idempotent
  // (Idempotency-Key required; conversation create is keyed on a client-minted
  // id, the chat turn on an Idempotency-Key, and the stream POST re-issues on a
  // transport drop), so a severed attempt is reconciled by a retry or a
  // concurrent idempotent attempt — and a mutation whose effect genuinely never
  // lands fails the test's own assertion (no conversation row, no AI response).
  // Unlike the GET rule this is errorText-keyed, not method-keyed: a sever is
  // tolerated, but a real mutation 4xx/5xx still arrives on its own
  // status-bearing line and surfaces. Chromium reports the sever as
  // `net::ERR_FAILED`; other engines' equivalents join here when observed.
  /NETWORK_FAILED .* — net::ERR_FAILED/,
];

/**
 * Universally-allowed console errors:
 *
 * 1. WebKit's local-network gating on iOS surfaces blocked fetches to
 *    `localhost`/private addresses as a `pageerror`
 *    (`<url> due to access control checks.`) even when the request ultimately
 *    succeeds via Playwright's request routing. Production never serves the
 *    app from localhost, so this pattern cannot mask a real cross-origin bug
 *    — it is a Playwright-on-WebKit artifact.
 *
 * 2. `Viewport argument key "interactive-widget" not recognized and ignored.`
 *    — the SPA's viewport meta sets `interactive-widget=resizes-content` for
 *    Android keyboard handling; WebKit doesn't recognize the Chrome-only
 *    attribute and logs a console.error on every page load. Real noise on
 *    every iphone-15/webkit test.
 *
 * 3. `[astro-island] Error hydrating /_astro/<chunk>.js TypeError: Importing a
 *    module script failed.` — WebKit (desktop Safari + iPhone-15) rejects
 *    in-flight dynamic `import()` calls when the page begins unloading. Tests
 *    that land on the Astro marketing site and then navigate away (e.g.
 *    post-delete-account → /welcome → /login) cancel hydration mid-flight,
 *    and Astro's hydration runner surfaces the rejection as a console error.
 *    Chromium and Firefox swallow the same rejection silently. The chunks
 *    load cleanly when the page stays put — see `marketing-roadmap.spec.ts`.
 *    Pure WebKit artifact, not a real hydration failure.
 */
const DEFAULT_CONSOLE_ALLOW: RegExp[] = [
  /\[UNCAUGHT\] (https?:)?\/\/?(localhost|127\.0\.0\.1|0\.0\.0\.0)[:/].*due to access control checks\.?/,
  /Viewport argument key "interactive-widget" not recognized and ignored\./,
  /\[astro-island\] Error hydrating .*TypeError: Importing a module script failed/,
  // The saturation 503 envelope, console side: a workerd recycle answers a
  // cross-origin /api request with a bare response lacking CORS headers, so the
  // browser blocks it and logs a cross-origin error. Each engine phrases it
  // differently — Chromium "has been blocked by CORS policy: No
  // 'Access-Control-Allow-Origin' header", Firefox "Cross-Origin Request
  // Blocked", WebKit "Origin … is not allowed by Access-Control-Allow-Origin",
  // and the Chromium preflight variant "Preflight response is not successful".
  // Keyed on the CORS-block fact across engines, NOT on a status code (Chromium's
  // message carries none). Safe to drop the 503 scope: the app sets CORS headers
  // on every real response, so a genuine CORS regression blocks every
  // cross-origin request and fails the whole suite at once — never
  // intermittently. The query layer retries and recovers.
  /has been blocked by CORS policy|Cross-Origin Request Blocked|is not allowed by Access-Control-Allow-Origin|Preflight response is not successful/,
  // Chromium's companion failed-load line for the same blocked fetch — a
  // network-level failure, not an app status. A real 4xx/5xx logs "responded
  // with a status of N" instead and still surfaces.
  /Failed to load resource: net::ERR_FAILED/,
  // Firefox's network-level companion when the 503 severs the socket outright:
  // the CORS request "did not succeed" with a "(null)" status.
  /Cross-Origin Request Blocked: .*CORS request did not succeed\)\. Status code: \(null\)\./,
  // ResizeObserver "loop" notices are a benign browser frame-budget artifact: a
  // ResizeObserver callback mutated layout and the browser deferred the
  // remaining notifications to the next frame (it self-heals — they are
  // delivered then). It is never an app fault, but a host-saturated, starved
  // frame makes it fire far more often, turning any test into a flake. Both the
  // modern Chromium phrasing ("completed with undelivered notifications") and
  // the legacy one ("loop limit exceeded") are the same benign condition. A real
  // infinite resize loop would instead manifest as the tested UI never settling,
  // which the test's own assertions catch.
  /ResizeObserver loop (?:completed with undelivered notifications|limit exceeded)/,
  // A WebSocket upgrade to the dev realtime endpoint
  // (ws://localhost:<api>/conversations/<id>/websocket or /chat/trial/websocket)
  // can be rejected once before the client reconnects: a link-guest socket races
  // ahead of its principal/access resolving (a 401), or a workerd recycle under
  // saturation drops the in-flight upgrade. The client reconnects and realtime
  // recovers; the browser still logs the one rejected upgrade — and each engine
  // phrases it differently (Chromium "WebSocket connection to … failed: …",
  // Firefox "Firefox can't establish a connection to the server at …"). Keyed on
  // the *fact* that the line names the dev websocket URL rather than any engine's
  // prose — the same browser-agnostic principle as the abort correlation. The
  // only console lines that carry that URL are WS connection failures, and a
  // genuine realtime regression still fails via the realtime assertions that
  // depend on a live socket (a dead socket never delivers the awaited frame), so
  // this backstop is redundant for real breakage.
  /wss?:\/\/(?:localhost|127\.0\.0\.1):\d+\/(?:conversations\/[0-9a-f-]+|chat\/trial)\/websocket/,
  // Firefox logs a console error when an `@font-face` download is cancelled by a
  // navigation that fires while the font is still in flight (status 2152398850 =
  // NS_BINDING_ABORTED). This is the same navigation-cancel class the
  // abort-correlation below already drops for tracked requests — but CSS-engine
  // font loads don't surface as Playwright `requestfailed` events, so they can't
  // be correlated by URL and slip through. Host saturation widens the
  // font-in-flight-at-navigation window, so a navigation away from a page that
  // is still loading a dev-served font (e.g. the marketing site's JetBrains
  // Mono) can cancel the download. The font falls back to the system monospace;
  // nothing functional breaks. Scoped to a local dev-served font, so a
  // missing/renamed font (a deterministic 404, caught by the marketing render
  // tests) is not masked.
  /downloadable font: download failed.*source: https?:\/\/(?:localhost|127\.0\.0\.1):\d+\/[^"']*\.woff2?/,
  // Streamdown's code plugin calls Shiki to highlight code blocks and logs
  // `[Streamdown Code] Failed to highlight code: <err>` when a highlight throws.
  // The app already wraps the plugin (createSafeCodePlugin) to short-circuit
  // unsupported/partial languages, but Shiki loads grammars+theme as async WASM,
  // and under host saturation that work is starved and can throw transiently for
  // a supported language too — the base plugin logs from inside its own call, so
  // the wrapper can't intercept it. The block falls back to unhighlighted text;
  // nothing functional breaks. A real misconfiguration would fail every render
  // (caught by the code-block render tests), not intermittently under load.
  /\[Streamdown Code\] Failed to highlight code:/,
  // The document sandbox ships `webrtc 'block'` (`apps/sandbox/src/csp.ts`) as a
  // forward-looking hint for engines that may honour the draft directive; the
  // containment that actually blocks WebRTC is deleting the constructors in the
  // frame. Chromium does not implement the directive and says so once per
  // sandbox frame mount, so every page embedding the sandbox emits it. Pinned to
  // the single directive the app ships: any other unrecognized directive — a
  // real CSP typo — still surfaces.
  /Unrecognized Content-Security-Policy directive 'webrtc'\./,
];

function isAllowedLine(line: string, allowed: RegExp[]): boolean {
  return allowed.some((pattern) => pattern.test(line));
}

function filterUnexpected(captured: string[], allowed: RegExp[]): string[] {
  return captured.filter((line) => !isAllowedLine(line, allowed));
}

/** Whether any allowance admits `entry`, by its text or by its source URL. */
function isAllowedConsoleEntry(
  entry: ConsoleEntry,
  allowed: (RegExp | ConsoleErrorMatcher)[]
): boolean {
  return allowed.some((allow) =>
    typeof allow === 'function' ? allow(entry) : allow.test(entry.text)
  );
}

/** A URL written out in a console message, as Firefox's font error writes `source: <url>`. */
const URL_IN_MESSAGE = /[a-z][\d+.a-z-]*:\/\/[^\s"'<>`\u201C\u201D]+/giu;

/**
 * Whether an abort of exactly `url` accounts for a console error at `order`:
 * some abort of it has no response to it and no other failure of it between the
 * abort and the error, whichever came first — a load's console line can
 * precede its abort event.
 */
function isExplainedByAbort(network: NetworkOrder, url: string, order: number): boolean {
  const aborts = network.aborts.get(url) ?? [];
  const separators = network.separators.get(url) ?? [];
  return aborts.some((abortOrder) => {
    const from = Math.min(abortOrder, order);
    const to = Math.max(abortOrder, order);
    return !separators.some((separatorOrder) => separatorOrder > from && separatorOrder < to);
  });
}

/**
 * A console error is navigation-cancel noise when an abort explains it (see
 * {@link isExplainedByAbort}) of a URL equal to its `location().url` or to a
 * URL written out in its message. The cross-browser counterpart of
 * `DEFAULT_API_ALLOW`'s network-abort families: it suppresses the resource-load
 * console error any engine emits for a load cancelled by navigation/teardown,
 * without a per-engine regex.
 */
function isAbortedResourceError(entry: ConsoleEntry, network: NetworkOrder): boolean {
  const named = entry.text.match(URL_IN_MESSAGE) ?? [];
  const urls = entry.url === '' ? named : [entry.url, ...named];
  return urls.some((url) => isExplainedByAbort(network, url, entry.order));
}

/**
 * Console errors for `page` minus the resource-load errors an abort accounts
 * for (the page navigated/closed mid-load) — the browser-agnostic counterpart
 * of `DEFAULT_API_ALLOW`'s abort families. Each {@link ConsoleEntry} carries its
 * own source URL, so no parallel-array indexing is involved and a URL-scoped
 * allowance still has the source to read downstream.
 */
function dropAbortedResourceErrors(page: Page, entries: ConsoleEntry[]): ConsoleEntry[] {
  const network = networkOrders.get(page);
  if (network === undefined || network.aborts.size === 0) return entries;
  return entries.filter((entry) => !isAbortedResourceError(entry, network));
}

/**
 * Attach a labeled text artifact (`console-errors-<label>`, `api-errors-<label>`)
 * to the failing test. Skips attachment when there are no errors — Playwright
 * shows empty attachments which clutter the report. Used by every page-creating
 * fixture so the attach shape stays uniform across labels.
 */
async function attachLabeledArtifact(
  testInfo: TestInfo,
  prefix: 'console-errors' | 'api-errors',
  label: string,
  errors: string[]
): Promise<void> {
  if (errors.length === 0) return;
  await testInfo.attach(`${prefix}-${label}`, {
    body: errors.join(ARTIFACT_JOINER[prefix]),
    contentType: 'text/plain',
  });
}

function formatUnexpectedErrors(
  title: string,
  label: string,
  unexpectedConsole: string[],
  unexpectedApi: string[]
): string {
  const sections: string[] = [];
  if (unexpectedConsole.length > 0) {
    sections.push(`Console:\n  ${unexpectedConsole.join('\n  ')}`);
  }
  if (unexpectedApi.length > 0) {
    sections.push(`API:\n  ${unexpectedApi.join('\n  ')}`);
  }
  return (
    `Unexpected errors during test "${title}" (page "${label}"):\n${sections.join('\n')}\n\n` +
    `If these are expected, opt out with expectConsoleErrors(page, [...]) / expectApiErrors(page, [...]).`
  );
}

async function attachFailureArtifacts(
  testInfo: TestInfo,
  entry: {
    page: Page;
    label: string;
    entries: ConsoleEntry[];
    apiErrors: string[];
  }
): Promise<void> {
  await attachLabeledArtifact(
    testInfo,
    'console-errors',
    entry.label,
    entry.entries.map((e) => e.text)
  );
  await attachLabeledArtifact(testInfo, 'api-errors', entry.label, entry.apiErrors);
  const snapshot = await entry.page
    .locator(':root')
    .ariaSnapshot()
    .catch(() => null);
  if (snapshot) {
    await testInfo.attach(`page-snapshot-${entry.label}`, {
      body: snapshot,
      contentType: 'text/yaml',
    });
  }
}

/**
 * Attach the context's recorded HAR, if one was recorded and written. Separate
 * from {@link attachFailureArtifacts} because it must run after the context is
 * closed, which is the only artifact with that ordering requirement.
 */
async function attachHar(testInfo: TestInfo, label: string, harPath: string): Promise<void> {
  if (!existsSync(harPath)) return;
  await testInfo.attach(`har-${label}`, {
    path: harPath,
    contentType: 'application/json',
  });
}

/** What {@link judgePage} reads: one page's captured failures. */
interface PageVerdictEntry {
  page: Page;
  label: string;
  entries: ConsoleEntry[];
  apiErrors: string[];
  violations: NetworkViolation[];
  settleApi: (needsBody: (line: string) => boolean) => Promise<void>;
}

/** An instrumented context, and the listeners and route closing it detaches. */
export interface InstrumentedContext {
  context: BrowserContext;
  label: string;
  harPath: string;
  cleanup: () => void;
  cleanupApi: () => void;
  cleanupNetwork: () => Promise<void>;
}

/**
 * Detach the per-page listeners and close the context, then attach its HAR if
 * the test has failed: Playwright flushes the recorded HAR to disk as part of
 * closing, so the file exists only afterwards. A context already closed when
 * this runs, as Playwright's built-in `context` fixture closes its own at its
 * teardown, has no route left to remove and nothing to close.
 */
export async function closeInstrumentedContext(
  entry: InstrumentedContext,
  testInfo: TestInfo
): Promise<void> {
  entry.cleanup();
  entry.cleanupApi();
  if (!entry.context.isClosed()) {
    await entry.cleanupNetwork();
    await entry.context.close();
  }
  if (testInfo.status !== testInfo.expectedStatus) {
    await attachHar(testInfo, entry.label, entry.harPath);
  }
}

/**
 * Promote the page's captured failures to a test failure, attaching the
 * artifacts read off the live page first. The context stays open: a context
 * closed while the test still reads as passing loses its trace, so
 * {@link closeInstrumentedContext} closes it once this verdict is recorded.
 */
export async function judgePage(
  entry: PageVerdictEntry,
  failed: boolean,
  testInfo: TestInfo
): Promise<void> {
  // Promote captured errors to test assertions when the test would otherwise
  // pass. Tests opt-out per-page via `expectConsoleErrors` / `expectApiErrors`.
  const allowList = getAllowList(entry.page);
  const consoleAllowed = [...DEFAULT_CONSOLE_ALLOW, ...allowList.console];
  const unexpectedConsole = dropAbortedResourceErrors(entry.page, entry.entries)
    .filter((consoleEntry) => !isAllowedConsoleEntry(consoleEntry, consoleAllowed))
    .map((consoleEntry) => consoleEntry.text);
  // An allowance may match only the response body, so the verdict waits for the
  // body reads of the entries no allowance admits without one.
  const apiAllowed = [...DEFAULT_API_ALLOW, ...allowList.api];
  await entry.settleApi((line) => !isAllowedLine(line, apiAllowed));
  const unexpectedApi = filterUnexpected(entry.apiErrors, apiAllowed);
  const hasViolations = entry.violations.length > 0;
  const hasUnexpected = unexpectedConsole.length > 0 || unexpectedApi.length > 0 || hasViolations;

  if (failed || hasUnexpected) {
    await attachFailureArtifacts(testInfo, entry);
  }

  if (!failed && hasViolations) {
    throw new Error(formatNetworkViolations(testInfo.title, entry.label, entry.violations));
  }
  if (!failed && (unexpectedConsole.length > 0 || unexpectedApi.length > 0)) {
    throw new Error(
      formatUnexpectedErrors(testInfo.title, entry.label, unexpectedConsole, unexpectedApi)
    );
  }
}
