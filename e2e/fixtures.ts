import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import {
  test as base,
  expect as rawExpect,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
  type Request,
  type Response,
  type Route,
  type APIRequestContext,
  type TestInfo,
} from '@playwright/test';
import { TEST_IDS, TEST_SIGNALS } from '@hushbox/shared';
import { ChatPage } from './pages';
import { TIMEOUTS } from './config/timeouts.js';
import { requireEnv } from './helpers/env.js';
import { clearUsageRateLimits } from './helpers/auth.js';
import { postWithRetry } from './helpers/api-retry.js';
import {
  buildStorageInitScript,
  type RawStorageState,
} from '../scripts/storage-state-init-script.js';

const apiUrl = requireEnv('VITE_API_URL');

function attachConsoleErrors(page: Page): { errors: string[]; cleanup: () => void } {
  const errors: string[] = [];
  const onConsole = (msg: { type: () => string; text: () => string }): void => {
    if (msg.type() === 'error') errors.push(msg.text());
  };
  const onPageError = (err: Error): void => {
    errors.push(`[UNCAUGHT] ${err.message}`);
  };
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  return {
    errors,
    cleanup: () => {
      page.off('console', onConsole);
      page.off('pageerror', onPageError);
    },
  };
}

const API_ERROR_BODY_CAP = 2000;

/**
 * Capture /api/* responses with status >= 400 and network-level request
 * failures. Body fetch is wrapped in try/catch because streaming responses
 * (SSE) can't be re-read after the fact and `response.text()` rejects.
 * Mirror of `attachConsoleErrors` — same lifecycle, same attach pattern on
 * test failure, surfaced as `api-errors-<label>` test attachment.
 */
function attachApiErrors(page: Page): { errors: string[]; cleanup: () => void } {
  const errors: string[] = [];
  const recordResponse = async (response: Response): Promise<void> => {
    const url = response.url();
    if (!url.includes('/api/')) return;
    const status = response.status();
    if (status < 400) return;
    const time = new Date().toISOString();
    const method = response.request().method();
    // Streaming responses (SSE) can't be re-read after the fact and
    // `response.text()` rejects; swallow that into an empty body.
    const body = await response.text().catch(() => '');
    const trimmed = body ? `\n  body: ${body.slice(0, API_ERROR_BODY_CAP)}` : '';
    errors.push(`${time} ${String(status)} ${response.statusText()} ${method} ${url}${trimmed}`);
  };
  const onResponse = (response: Response): void => {
    void recordResponse(response);
  };
  const onRequestFailed = (request: Request): void => {
    const url = request.url();
    if (!url.includes('/api/')) return;
    const failure = request.failure();
    errors.push(
      `${new Date().toISOString()} NETWORK_FAILED ${request.method()} ${url} — ${failure?.errorText ?? 'unknown'}`
    );
  };
  page.on('response', onResponse);
  page.on('requestfailed', onRequestFailed);
  return {
    errors,
    cleanup: () => {
      page.off('response', onResponse);
      page.off('requestfailed', onRequestFailed);
    },
  };
}

/**
 * Network allowlist. The browser may only reach the
 * services the suite legitimately uses; any request to a non-allowlisted host
 * is a live third-party leaking into the hot path.
 *
 * Allowlisted hosts are `localhost`/`127.0.0.1` on the ports the dev stack
 * exposes — the app (preview + vite), the API (which also serves the WebSocket
 * on the same host:port), and MinIO (the R2/S3 emulator the browser hits
 * directly via presigned media URLs). Ports are read from the same `HB_*_PORT`
 * env the Playwright config and dev scripts use, so worktree-offset ports stay
 * correct without hardcoding `:4173`/`:8787`/`:9000`.
 *
 * `data:`/`blob:` schemes are always allowed — they are in-document media
 * (canvas blobs, decoded images) with no network egress.
 *
 * With the model catalog pinned, the AI gateway
 * (`ai-gateway.vercel.sh`) is never reached, so it is deliberately NOT
 * allowlisted: a request to it must fail the test.
 */
const ALLOWED_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1']);
const ALWAYS_ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(['data:', 'blob:']);

/**
 * Ports of the local services the browser legitimately reaches. Read once at
 * module load. `requireEnv` fail-fasts if the stack env wasn't generated —
 * matching the rest of the suite, which assumes `ensure-stack` ran first.
 *
 * - preview/vite: the app origin (`vite preview` serves E2E; vite dev exists
 *   for parity and worktree port-mapping).
 * - api: REST endpoints AND the conversation WebSocket (same host:port,
 *   `ws://` scheme — host-matching covers both).
 * - minio: the R2/S3 emulator; presigned GET URLs are fetched by the browser.
 */
function allowedLocalPorts(): ReadonlySet<string> {
  return new Set([
    requireEnv('HB_PREVIEW_PORT'),
    requireEnv('HB_VITE_PORT'),
    requireEnv('HB_API_PORT'),
    requireEnv('HB_MINIO_API_PORT'),
  ]);
}

const LOCAL_PORTS = allowedLocalPorts();

/**
 * Whether `hostname` falls under one of the opt-in domains: an exact match or
 * a subdomain. Matched on a leading-dot boundary (`host === domain` or
 * `host.endsWith('.' + domain)`) rather than a naive substring/`includes`, so
 * a look-alike like `evil-myhelcim.com.attacker.com` can never pass.
 */
function hostUnderExtraDomains(hostname: string, extraHosts: ReadonlySet<string>): boolean {
  for (const domain of extraHosts) {
    if (hostname === domain || hostname.endsWith(`.${domain}`)) return true;
  }
  return false;
}

/**
 * Decide whether a single request URL is allowed. Pure so the allow/deny
 * decision is testable without a browser. `extraHosts` carries the per-test
 * opt-in extension (real-payment billing tests — see `allowExternalHosts`);
 * an entry there is a domain family matched by suffix (the domain or any
 * subdomain of it), on any port. The default local allowlist below stays
 * exact-host: localhost/127.0.0.1 only, and only on the dev-stack ports.
 */
export function isRequestAllowed(url: string, extraHosts: ReadonlySet<string>): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // A URL Playwright can't parse can't be a legitimate egress we recognize.
    return false;
  }
  if (ALWAYS_ALLOWED_PROTOCOLS.has(parsed.protocol)) return true;
  if (hostUnderExtraDomains(parsed.hostname, extraHosts)) return true;
  return ALLOWED_HOSTNAMES.has(parsed.hostname) && LOCAL_PORTS.has(parsed.port);
}

/**
 * Domain families the real-payment ("Payment Flow (Full)" / token-portal)
 * billing tests legitimately reach — the ONLY sanctioned external egress.
 * Each entry is matched by suffix (the domain itself or any
 * subdomain — see `hostUnderExtraDomains`), so the whole `*.myhelcim.com` /
 * `*.helcim.com` family is covered: Helcim.js tokenizes the card in-browser
 * (e.g. `secure.myhelcim.com`) and in CI may call other Helcim gateway
 * sub-hosts during tokenization, none of which can be enumerated up front.
 * The Hookdeck webhook relay is server-side (CLI tunnel → localhost:API), but
 * its family is included so a browser-side Hookdeck call (should the flow ever
 * make one) is not a false positive. Listed as family roots only; subdomains
 * are implied by the suffix match. Locally these tests use a mock Helcim, so
 * this opt-in is a no-op there and the suite stays strict.
 */
const BILLING_EXTERNAL_HOSTS: readonly string[] = ['myhelcim.com', 'helcim.com', 'hookdeck.com'];

const pageExtraHosts = new WeakMap<Page, Set<string>>();

function getExtraHosts(page: Page): Set<string> {
  let hosts = pageExtraHosts.get(page);
  if (hosts === undefined) {
    hosts = new Set();
    pageExtraHosts.set(page, hosts);
  }
  return hosts;
}

/**
 * Opt a page into reaching external hosts that the test legitimately needs.
 * Defaults to the sanctioned billing payment hosts (Helcim + Hookdeck) when
 * called with no list. Call BEFORE any navigation that could trigger the
 * external request (e.g. at the top of the test, before `goto`), because the
 * allowlist route consults this set at request time.
 *
 * This is a sanctioned exception, not an escape hatch: only the
 * real-payment billing tests should call it. Everything else stays strict so
 * a stray live third-party in the hot path fails the test.
 *
 * The real-payment billing tests are also opted in automatically by their
 * `@webhook` tag (see `installNetworkAllowlist`), so they need no explicit
 * call; this export exists for any future test with a different external edge.
 */
export function allowExternalHosts(
  page: Page,
  hosts: readonly string[] = BILLING_EXTERNAL_HOSTS
): void {
  const set = getExtraHosts(page);
  for (const host of hosts) set.add(host);
}

/**
 * Tag that marks the real-payment billing tests (`Payment Flow (Full)` and the
 * token-login portal). They drive the real Helcim → Hookdeck path in CI, so
 * pages created under them are auto-opted into the billing external hosts.
 * Locally these tests use a mock Helcim and reach no external host, so the
 * extension is a harmless no-op there.
 */
const WEBHOOK_TAG = '@webhook';

interface NetworkViolation {
  host: string;
  url: string;
}

/**
 * Install the allowlist on a browser context. Every request is matched against
 * the allowlist; allowed requests continue untouched, blocked requests are
 * recorded and aborted. Returns the violations array (asserted empty at
 * teardown) and a cleanup that removes the route.
 *
 * Violations are collected explicitly here rather than read off the
 * `requestfailed` channel: aborting produces a `net::ERR_FAILED`/`ABORTED`
 * that is indistinguishable from the navigation-cancel noise already allowed
 * in `DEFAULT_API_ALLOW`. Collecting the host+URL at the decision point makes
 * the teardown failure precise and unambiguous.
 */
function installNetworkAllowlist(
  context: BrowserContext,
  page: Page,
  testInfo: TestInfo
): { violations: NetworkViolation[]; cleanup: () => Promise<void> } {
  if (testInfo.tags.includes(WEBHOOK_TAG)) {
    allowExternalHosts(page);
  }
  const violations: NetworkViolation[] = [];
  const handler = async (route: Route): Promise<void> => {
    const url = route.request().url();
    if (isRequestAllowed(url, getExtraHosts(page))) {
      await route.continue();
      return;
    }
    let host = url;
    try {
      host = new URL(url).host;
    } catch {
      // keep the raw url as the host label when it can't be parsed
    }
    violations.push({ host, url });
    await route.abort();
  };
  void context.route('**/*', handler);
  return {
    violations,
    cleanup: () => context.unroute('**/*', handler),
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
  console: RegExp[];
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
 * (matched case-insensitively) or RegExps. Call before any action that
 * might produce the error.
 */
export function expectConsoleErrors(page: Page, patterns: (string | RegExp)[]): void {
  const list = getAllowList(page);
  list.console.push(...patterns.map((p) => toRegExp(p)));
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
 * Patterns match each captured error line independently. Each line
 * includes the status code, method, URL, and (when re-readable) body.
 * Call before any action that might produce the error.
 */
export function expectApiErrors(page: Page, patterns: (string | RegExp)[]): void {
  const list = getAllowList(page);
  list.api.push(...patterns.map((p) => toRegExp(p)));
}

/**
 * Universally-allowed API errors: the navigation-cancel families each
 * browser engine emits when a request is dropped because the page
 * navigated, closed, or its `AbortController` fired (`net::ERR_ABORTED`
 * on Chromium, `NS_BINDING_ABORTED` on Firefox, `Load request cancelled`
 * on WebKit). Always teardown noise, never an app concern.
 */
const DEFAULT_API_ALLOW: RegExp[] = [
  /NETWORK_FAILED .* — net::ERR_ABORTED/,
  /NETWORK_FAILED .* — NS_BINDING_ABORTED/,
  /NETWORK_FAILED .* — Load request cancelled/,
  // A workerd/wrangler worker restart under host saturation answers an in-flight
  // request (including a CORS preflight OPTIONS) with a bare 503 — the runtime
  // envelope, not an app response. Reads go through the app-wide query retry
  // policy and recover, but the failed preflight is still logged. Scoped to 503
  // so a genuine app/CORS 4xx still fails. See E2E-RULES 2.10 (surface, not fail).
  /NETWORK_FAILED .* — Preflight response is not successful\. Status code: 503/,
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
  // Browser-logged counterpart of the saturation 503 preflight above (both the
  // pageerror and the "Failed to load resource" line). The query layer retries
  // and recovers; only the console log remains. Scoped to 503 so a real CORS
  // failure or app 4xx still fails the test.
  /Preflight response is not successful\. Status code: 503/,
];

function filterUnexpected(captured: string[], allowed: RegExp[]): string[] {
  return captured.filter((line) => !allowed.some((pattern) => pattern.test(line)));
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

type StorageState = NonNullable<BrowserContextOptions['storageState']>;
type StorageStateObject = Exclude<StorageState, string>;
type FixtureSpec = { persona: string } | { state: StorageState };

/**
 * Strip `origins` (localStorage entries) out of a storage state JSON and
 * return them as an equivalent `addInitScript` body. The default Playwright
 * behavior — apply origins by navigating the new context to each origin and
 * waiting for `load` — is the bottleneck in firefox `browser.newContext`
 * and the root cause of Group C fixture timeouts. Init scripts run before
 * any page script on every navigation, so the localStorage values are in
 * place by the time React boots, identical observable behavior at a
 * fraction of the cost.
 */
async function buildContextOptions(
  storageState: StorageState
): Promise<{ state: StorageState; initScript: string | null }> {
  if (typeof storageState !== 'string') {
    return { state: storageState, initScript: null };
  }
  const raw = JSON.parse(await readFile(storageState, 'utf8')) as RawStorageState;
  const initScript = buildStorageInitScript(raw);
  if (initScript === null) {
    return { state: storageState, initScript: null };
  }
  const cookies = raw.cookies as StorageStateObject['cookies'];
  return { state: { cookies, origins: [] }, initScript };
}

function createPageFixture(
  spec: FixtureSpec,
  label: string
): (
  deps: { browser: Browser },
  use: (page: Page) => Promise<void>,
  testInfo: TestInfo
) => Promise<void> {
  return async ({ browser }, use, testInfo) => {
    const harPath = testInfo.outputPath(`${label}.har`);
    const storageState =
      'persona' in spec ? `e2e/.auth/${testInfo.project.name}/${spec.persona}.json` : spec.state;
    const { state, initScript } = await buildContextOptions(storageState);
    // Record HAR on every attempt — `attachFailureArtifacts` only attaches it
    // when the attempt fails, so a flaky test's first (failing) attempt has
    // network data in the report instead of only the retry that passed.
    const context = await browser.newContext({
      storageState: state,
      recordHar: {
        path: harPath,
        mode: 'minimal',
        urlFilter: /\/api\//,
      },
    });
    if (initScript !== null) await context.addInitScript({ content: initScript });
    const page = await context.newPage();
    const { errors, cleanup } = attachConsoleErrors(page);
    const { errors: apiErrors, cleanup: cleanupApi } = attachApiErrors(page);
    const { violations, cleanup: cleanupNetwork } = installNetworkAllowlist(
      context,
      page,
      testInfo
    );
    await use(page);
    const failed = testInfo.status !== testInfo.expectedStatus;
    await teardownPage(
      {
        page,
        context,
        label,
        errors,
        apiErrors,
        violations,
        cleanup,
        cleanupApi,
        cleanupNetwork,
        harPath,
      },
      failed,
      testInfo
    );
  };
}

interface TestConversation {
  id: string;
  url: string;
}

interface GroupConversation {
  id: string;
  members: { userId: string; username: string; email: string }[];
}

interface MultiModelConversation {
  id: string;
  url: string;
}

interface MediaConversation {
  conversationId: string;
  assistantMessageId: string;
  page: Page;
}

interface CustomFixtures {
  /**
   * Auto-fixture: clears per-user usage rate-limit buckets (chat stream,
   * media download, share creation) at the start of every test. Stops late
   * tests in a worker from hitting 429s caused by prior tests reusing the
   * same test user. Trial IP limits are deliberately not cleared so that
   * `trial-chat.spec.ts` continues to exercise the trial cap firing.
   *
   * Returns `null` (and the fixture value is never read) — Playwright requires
   * a defined return type, and `void` is reserved for function return types.
   */
  resetRateLimitsAutoHook: null;
  authenticatedPage: Page;
  unauthenticatedPage: Page;
  /** Factory for creating fresh, fully-instrumented browser contexts on demand.
   *  Each page gets HAR recording, console error capture, and page snapshot on failure.
   *  Defaults to empty storage state (unauthenticated). Pass a storage state path for auth. */
  createPage: (storageState?: StorageState) => Promise<Page>;
  testConversation: TestConversation;
  multiModelConversation: MultiModelConversation;
  /** Authenticated conversation with one finished image generation. */
  imageConversation: MediaConversation;
  /** Authenticated conversation with one finished video generation. */
  videoConversation: MediaConversation;
  /** Authenticated low-balance user (~$0.01) for affordability error testing. */
  lowBalancePage: Page;
  authenticatedRequest: APIRequestContext;
  test2FAPage: Page;
  billingSuccessPage: Page;
  billingSuccessPage2: Page;
  billingFailurePage: Page;
  billingValidationPage: Page;
  billingDevModePage: Page;
  billingTokenRequest: APIRequestContext;
  groupConversation: GroupConversation;
  testBobPage: Page;
  testDavePage: Page;
  testBobRequest: APIRequestContext;
}

async function zeroLowBalanceWallets(
  requestContext: APIRequestContext,
  email: string
): Promise<void> {
  // Zero both wallets so the user is on the free tier with no allowance —
  // every preflight cost trips `insufficient_free_allowance` denial.
  await postWithRetry(requestContext, '/api/dev/wallet-balance', {
    data: { email, walletType: 'purchased', balance: '0.00000000' },
  });
  await postWithRetry(requestContext, '/api/dev/wallet-balance', {
    data: { email, walletType: 'free_tier', balance: '0.00000000' },
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

/**
 * Format the network-allowlist violation message. Distinct from the
 * console/API teardown failure so a live-third-party-in-the-hot-path breach
 * reads unambiguously and points at the opt-in escape hatch for the
 * legitimate-external case.
 */
function formatNetworkViolations(
  title: string,
  label: string,
  violations: NetworkViolation[]
): string {
  const lines = violations.map((v) => `  ${v.host} — ${v.url}`);
  return (
    `Blocked non-allowlisted network request(s) during test "${title}" (page "${label}").\n` +
    `The E2E suite may only reach the local app/api/ws/minio origins:\n` +
    `${lines.join('\n')}\n\n` +
    `If a host is legitimate, add it to the allowlist in fixtures.ts; if it is the ` +
    `sanctioned billing payment edge, opt in with allowExternalHosts(page).`
  );
}

async function attachFailureArtifacts(
  testInfo: TestInfo,
  entry: { page: Page; label: string; errors: string[]; apiErrors: string[]; harPath: string }
): Promise<void> {
  await attachLabeledArtifact(testInfo, 'console-errors', entry.label, entry.errors);
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
  if (existsSync(entry.harPath)) {
    await testInfo.attach(`har-${entry.label}`, {
      path: entry.harPath,
      contentType: 'application/json',
    });
  }
}

interface PageTeardownEntry {
  page: Page;
  context: BrowserContext;
  label: string;
  errors: string[];
  apiErrors: string[];
  violations: NetworkViolation[];
  cleanup: () => void;
  cleanupApi: () => void;
  cleanupNetwork: () => Promise<void>;
  harPath: string;
}

async function teardownPage(
  entry: PageTeardownEntry,
  failed: boolean,
  testInfo: TestInfo
): Promise<void> {
  // Promote captured errors to test assertions when the test would otherwise
  // pass. Tests opt-out per-page via `expectConsoleErrors` / `expectApiErrors`.
  const allowList = getAllowList(entry.page);
  const unexpectedConsole = filterUnexpected(entry.errors, [
    ...DEFAULT_CONSOLE_ALLOW,
    ...allowList.console,
  ]);
  const unexpectedApi = filterUnexpected(entry.apiErrors, [...DEFAULT_API_ALLOW, ...allowList.api]);
  const hasViolations = entry.violations.length > 0;
  const hasUnexpected = unexpectedConsole.length > 0 || unexpectedApi.length > 0 || hasViolations;

  if (failed || hasUnexpected) {
    await attachFailureArtifacts(testInfo, entry);
  }
  await entry.cleanupNetwork();
  entry.cleanup();
  entry.cleanupApi();
  await entry.context.close();

  if (!failed && hasViolations) {
    throw new Error(formatNetworkViolations(testInfo.title, entry.label, entry.violations));
  }
  if (!failed && (unexpectedConsole.length > 0 || unexpectedApi.length > 0)) {
    throw new Error(
      formatUnexpectedErrors(testInfo.title, entry.label, unexpectedConsole, unexpectedApi)
    );
  }
}

export const test = base.extend<CustomFixtures>({
  resetRateLimitsAutoHook: [
    async ({ playwright }, use) => {
      const ctx = await playwright.request.newContext({ baseURL: apiUrl });
      await clearUsageRateLimits(ctx);
      await ctx.dispose();
      await use(null);
    },
    { auto: true },
  ],

  authenticatedPage: createPageFixture({ persona: 'test-alice' }, 'authenticatedPage'),

  // Explicitly clear storage state to override project-level default auth
  unauthenticatedPage: createPageFixture(
    { state: { cookies: [], origins: [] } },
    'unauthenticatedPage'
  ),

  createPage: async ({ browser }, use, testInfo) => {
    const pages: PageTeardownEntry[] = [];
    let counter = 0;

    const DEFAULT_STORAGE_STATE: StorageState = { cookies: [], origins: [] };
    const factory = async (storageState: StorageState = DEFAULT_STORAGE_STATE): Promise<Page> => {
      counter++;
      const label = `unauthenticatedPage-${String(counter)}`;
      const harPath = testInfo.outputPath(`${label}.har`);
      const { state, initScript } = await buildContextOptions(storageState);
      const context = await browser.newContext({
        storageState: state,
        recordHar: { path: harPath, mode: 'minimal', urlFilter: /\/api\// },
      });
      if (initScript !== null) await context.addInitScript({ content: initScript });
      const page = await context.newPage();
      const { errors, cleanup } = attachConsoleErrors(page);
      const { errors: apiErrors, cleanup: cleanupApi } = attachApiErrors(page);
      const { violations, cleanup: cleanupNetwork } = installNetworkAllowlist(
        context,
        page,
        testInfo
      );
      pages.push({
        page,
        context,
        label,
        errors,
        apiErrors,
        violations,
        cleanup,
        cleanupApi,
        cleanupNetwork,
        harPath,
      });
      return page;
    };

    await use(factory);

    const failed = testInfo.status !== testInfo.expectedStatus;
    for (const entry of pages) {
      await teardownPage(entry, failed, testInfo);
    }
  },

  authenticatedRequest: async ({ playwright }, use, testInfo) => {
    const context = await playwright.request.newContext({
      baseURL: apiUrl,
      storageState: `e2e/.auth/${testInfo.project.name}/test-alice.json`,
    });
    await use(context);
    await context.dispose();
  },

  test2FAPage: createPageFixture({ persona: 'test-2fa' }, 'test2FAPage'),

  billingSuccessPage: createPageFixture({ persona: 'test-billing-success' }, 'billingSuccessPage'),
  billingSuccessPage2: createPageFixture(
    { persona: 'test-billing-success-2' },
    'billingSuccessPage2'
  ),
  billingFailurePage: createPageFixture({ persona: 'test-billing-failure' }, 'billingFailurePage'),
  billingValidationPage: createPageFixture(
    { persona: 'test-billing-validation' },
    'billingValidationPage'
  ),
  billingDevModePage: createPageFixture({ persona: 'test-billing-devmode' }, 'billingDevModePage'),

  billingTokenRequest: async ({ playwright }, use, testInfo) => {
    const context = await playwright.request.newContext({
      baseURL: apiUrl,
      storageState: `e2e/.auth/${testInfo.project.name}/test-billing-token.json`,
    });
    await use(context);
    await context.dispose();
  },

  groupConversation: async (
    { authenticatedPage: _authenticatedPage, authenticatedRequest },
    use,
    testInfo
  ) => {
    const projectName = testInfo.project.name;
    const aliceEmail = `test-alice-${projectName}@test.hushbox.ai`;
    const bobEmail = `test-bob-${projectName}@test.hushbox.ai`;
    const response = await postWithRetry(authenticatedRequest, '/api/dev/group-chat', {
      data: {
        ownerEmail: aliceEmail,
        memberEmails: [bobEmail],
        messages: [
          { senderEmail: aliceEmail, content: 'Hello from Alice', senderType: 'user' },
          { content: 'Echo: Hello! How can I help?', senderType: 'ai' },
          { senderEmail: bobEmail, content: 'Hi from Bob', senderType: 'user' },
          { senderEmail: aliceEmail, content: 'Alice replies', senderType: 'user' },
          { senderEmail: aliceEmail, content: 'Summarize this', senderType: 'user' },
          { content: 'Echo: Here is a summary of your conversation.', senderType: 'ai' },
        ],
      },
    });

    rawExpect(response.ok(), `group-chat creation failed: ${String(response.status())}`).toBe(true);
    const data = (await response.json()) as {
      conversationId: string;
      members: GroupConversation['members'];
    };
    await use({ id: data.conversationId, members: data.members });
    // No cleanup — CI database is ephemeral. Deleting here races with deferred
    // saveChatTurn() running via Wrangler's waitUntil(), producing billing_failed errors.
  },

  testBobPage: createPageFixture({ persona: 'test-bob' }, 'testBobPage'),

  testDavePage: createPageFixture({ persona: 'test-dave' }, 'testDavePage'),

  testBobRequest: async ({ playwright }, use, testInfo) => {
    const context = await playwright.request.newContext({
      baseURL: apiUrl,
      storageState: `e2e/.auth/${testInfo.project.name}/test-bob.json`,
    });
    await use(context);
    await context.dispose();
  },

  multiModelConversation: [
    async ({ authenticatedPage }, use) => {
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.goto();
      await chatPage.waitForAppStable();

      await chatPage.selectModels(2);
      await chatPage.expectComparisonBarVisible();

      const testMessage = `Multi-model fixture ${String(Date.now())}`;
      await chatPage.sendNewChatMessage(testMessage);
      await chatPage.waitForConversation();
      await chatPage.waitForMultiModelResponses(2);
      await chatPage.waitForStreamComplete();

      const url = new URL(authenticatedPage.url());
      const id = url.pathname.split('/').pop() ?? '';

      await use({ id, url: authenticatedPage.url() });
    },
    { timeout: TIMEOUTS.LONG },
  ],

  imageConversation: [
    async ({ authenticatedPage }, use) => {
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.goto();
      await chatPage.expectNewChatPageVisible();

      await chatPage.switchToImageMode();
      const prompt = `Image fixture ${String(Date.now())}`;
      await chatPage.sendNewChatMessage(prompt);
      await chatPage.waitForConversation();
      await chatPage.expectImageVisible();
      await chatPage.waitForStreamComplete();

      const url = new URL(authenticatedPage.url());
      const conversationId = url.pathname.split('/').pop() ?? '';

      const assistantMessageId =
        (await authenticatedPage
          .locator(`[${TEST_SIGNALS.role}="assistant"]`)
          .first()
          .getAttribute(TEST_SIGNALS.messageId)) ?? '';
      rawExpect(assistantMessageId, 'imageConversation: missing assistant message id').not.toBe('');

      await use({ conversationId, assistantMessageId, page: authenticatedPage });
    },
    { timeout: TIMEOUTS.LONG },
  ],

  videoConversation: [
    async ({ authenticatedPage }, use) => {
      const chatPage = new ChatPage(authenticatedPage);
      await chatPage.goto();
      await chatPage.expectNewChatPageVisible();

      await chatPage.switchToVideoMode();
      const prompt = `Video fixture ${String(Date.now())}`;
      await chatPage.sendNewChatMessage(prompt);
      await chatPage.waitForConversation();
      await chatPage.expectVideoVisible();
      await chatPage.waitForStreamComplete();

      const url = new URL(authenticatedPage.url());
      const conversationId = url.pathname.split('/').pop() ?? '';

      const assistantMessageId =
        (await authenticatedPage
          .locator(`[${TEST_SIGNALS.role}="assistant"]`)
          .first()
          .getAttribute(TEST_SIGNALS.messageId)) ?? '';
      rawExpect(assistantMessageId, 'videoConversation: missing assistant message id').not.toBe('');

      await use({ conversationId, assistantMessageId, page: authenticatedPage });
    },
    { timeout: TIMEOUTS.LONG },
  ],

  // Low-balance page: authenticated as test-billing-validation (zero starting balance);
  // both wallets are zeroed via the dev endpoint before the test runs so the
  // user lands on free tier with no allowance — any preflight cost denies with
  // `insufficient_free_allowance`. The "paid + $0.01" route doesn't work here:
  // the $0.50 paid-tier cushion always covers image/Smart-Model preflight costs.
  // Reset to $0 after the test to avoid bleed.
  lowBalancePage: async ({ browser, playwright }, use, testInfo) => {
    const projectName = testInfo.project.name;
    const lowBalanceEmail = `test-billing-validation-${projectName}@test.hushbox.ai`;
    const storageStatePath = `e2e/.auth/${projectName}/test-billing-validation.json`;
    const requestContext = await playwright.request.newContext({
      baseURL: apiUrl,
      storageState: storageStatePath,
    });

    await zeroLowBalanceWallets(requestContext, lowBalanceEmail);

    const harPath = testInfo.outputPath('lowBalancePage.har');
    const isRetry = testInfo.retry > 0;
    const context = await browser.newContext({
      storageState: storageStatePath,
      ...(isRetry && {
        recordHar: { path: harPath, mode: 'minimal', urlFilter: /\/api\// },
      }),
    });
    const page = await context.newPage();
    const { errors, cleanup } = attachConsoleErrors(page);
    const { errors: apiErrors, cleanup: cleanupApi } = attachApiErrors(page);
    const { violations, cleanup: cleanupNetwork } = installNetworkAllowlist(
      context,
      page,
      testInfo
    );
    await use(page);
    const failed = testInfo.status !== testInfo.expectedStatus;
    await teardownPage(
      {
        page,
        context,
        label: 'lowBalancePage',
        errors,
        apiErrors,
        violations,
        cleanup,
        cleanupApi,
        cleanupNetwork,
        harPath,
      },
      failed,
      testInfo
    );

    await postWithRetry(requestContext, '/api/dev/wallet-balance', {
      data: { email: lowBalanceEmail, walletType: 'purchased', balance: '0.00000000' },
    });
    await requestContext.dispose();
  },

  testConversation: async ({ authenticatedPage, authenticatedRequest }, use, testInfo) => {
    const testMessage = `Fixture setup ${String(Date.now())}`;
    const aliceEmail = `test-alice-${testInfo.project.name}@test.hushbox.ai`;
    const response = await postWithRetry(authenticatedRequest, '/api/dev/conversation', {
      data: {
        ownerEmail: aliceEmail,
        messages: [
          { content: testMessage, senderType: 'user' },
          { content: `Echo: ${testMessage}`, senderType: 'ai' },
        ],
      },
    });

    rawExpect(response.ok(), `conversation creation failed: ${String(response.status())}`).toBe(
      true
    );
    const data = (await response.json()) as { conversationId: string };
    const id = data.conversationId;

    // Navigate to the conversation so the page is ready for test interactions.
    // Wait for both seeded messages to render — waitForConversationLoaded only
    // waits for the first message-item, which can resolve on just the user
    // message while the AI reply is still decrypting. Tests assuming "the
    // conversation is ready" need both present.
    await authenticatedPage.goto(`/chat/${id}`, { waitUntil: 'domcontentloaded' });
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.waitForConversationLoaded();
    await rawExpect(chatPage.messageList.getByTestId(TEST_IDS.messageItem)).toHaveCount(2);

    await use({ id, url: `/chat/${id}` });
  },
});

// Both `expect` and `unsettledExpect` resolve to plain Playwright `expect`;
// `unsettledExpect` is a retained alias so spec files importing either name
// keep resolving.
export { expect, expect as unsettledExpect } from './helpers/expect.js';
