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
  type APIRequestContext,
  type TestInfo,
} from '@playwright/test';
import { ChatPage } from './pages';
import { requireEnv } from './helpers/env.js';
import { clearUsageRateLimits } from './helpers/auth.js';
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
    await use(page);
    const failed = testInfo.status !== testInfo.expectedStatus;
    await teardownPage(
      { page, context, label, errors, apiErrors, cleanup, cleanupApi, harPath },
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
  await requestContext.post('/api/dev/wallet-balance', {
    data: { email, walletType: 'purchased', balance: '0.00000000' },
  });
  await requestContext.post('/api/dev/wallet-balance', {
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

async function teardownPage(
  entry: {
    page: Page;
    context: BrowserContext;
    label: string;
    errors: string[];
    apiErrors: string[];
    cleanup: () => void;
    cleanupApi: () => void;
    harPath: string;
  },
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
  const hasUnexpected = unexpectedConsole.length > 0 || unexpectedApi.length > 0;

  if (failed || hasUnexpected) {
    await attachFailureArtifacts(testInfo, entry);
  }
  entry.cleanup();
  entry.cleanupApi();
  await entry.context.close();

  if (!failed && hasUnexpected) {
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
    const pages: {
      page: Page;
      context: BrowserContext;
      label: string;
      errors: string[];
      apiErrors: string[];
      cleanup: () => void;
      cleanupApi: () => void;
      harPath: string;
    }[] = [];
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
      pages.push({ page, context, label, errors, apiErrors, cleanup, cleanupApi, harPath });
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
    const response = await authenticatedRequest.post('/api/dev/group-chat', {
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
    { timeout: 60_000 },
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
          .locator('[data-role="assistant"]')
          .first()
          .getAttribute('data-message-id')) ?? '';
      rawExpect(assistantMessageId, 'imageConversation: missing assistant message id').not.toBe('');

      await use({ conversationId, assistantMessageId, page: authenticatedPage });
    },
    { timeout: 60_000 },
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
          .locator('[data-role="assistant"]')
          .first()
          .getAttribute('data-message-id')) ?? '';
      rawExpect(assistantMessageId, 'videoConversation: missing assistant message id').not.toBe('');

      await use({ conversationId, assistantMessageId, page: authenticatedPage });
    },
    { timeout: 60_000 },
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
    await use(page);
    const failed = testInfo.status !== testInfo.expectedStatus;
    await teardownPage(
      {
        page,
        context,
        label: 'lowBalancePage',
        errors,
        apiErrors,
        cleanup,
        cleanupApi,
        harPath,
      },
      failed,
      testInfo
    );

    await requestContext.post('/api/dev/wallet-balance', {
      data: { email: lowBalanceEmail, walletType: 'purchased', balance: '0.00000000' },
    });
    await requestContext.dispose();
  },

  testConversation: async ({ authenticatedPage, authenticatedRequest }, use, testInfo) => {
    const testMessage = `Fixture setup ${String(Date.now())}`;
    const aliceEmail = `test-alice-${testInfo.project.name}@test.hushbox.ai`;
    const response = await authenticatedRequest.post('/api/dev/conversation', {
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
    await rawExpect(chatPage.messageList.locator('[data-testid="message-item"]')).toHaveCount(2);

    await use({ id, url: `/chat/${id}` });
  },
});

export { expect, unsettledExpect } from './helpers/settled-expect.js';
