import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  test as base,
  expect as rawExpect,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
  type Route,
  type APIRequestContext,
  type TestInfo,
} from '@playwright/test';
import { TEST_IDS } from '@hushbox/shared';
import { ChatPage } from './pages';
import { TIMEOUTS } from './config/timeouts.js';
import { API_HAR_URL_FILTER } from './helpers/api-origin.js';
import { requireEnv } from './helpers/env.js';
import { clearUsageRateLimits } from './helpers/auth.js';
import { postWalletBalanceSeedUnchecked } from './helpers/dev-wallet-balance.js';
import { guestIp } from './helpers/guest-identity.js';
import { idempotentPost } from './helpers/idempotent-request.js';
import {
  allowExternalHosts,
  getExtraHosts,
  isRequestAllowed,
  WEBHOOK_TAG,
  type NetworkViolation,
} from './helpers/network-allowlist.js';
import { expectOkResponse } from './helpers/ok-response.js';
import {
  attachApiErrors,
  attachConsoleErrors,
  closeInstrumentedContext,
  judgePage,
  type InstrumentedContext,
} from './helpers/page-guardrails.js';
import { callerHeaders } from './helpers/project-headers.js';
import { withRequestRetry } from './helpers/resilient-request.js';
import { pooledPersonaName } from '../scripts/seed.js';
import {
  moneyGateFailure,
  resetMoneyLedger,
  takeMoneyLedger,
} from '../scripts/lib/money/money-gate.js';
import {
  buildStorageInitScript,
  type RawStorageState,
} from '../scripts/storage-state-init-script.js';

const apiUrl = requireEnv('VITE_API_URL');

/**
 * Storage-state path for a persona, resolved to the current Playwright worker's
 * isolated copy (the roster is `POOLED_PERSONA_BASE_NAMES`). Two
 * parallel workers therefore authenticate as distinct users with distinct
 * wallets, so their chat-turn admission holds never contend (the chat-402 fix).
 */
function pooledStorageStatePath(baseName: string, testInfo: TestInfo): string {
  const persona = pooledPersonaName(baseName, testInfo.parallelIndex);
  return `e2e/.auth/${testInfo.project.name}/${persona}.json`;
}

/** Project- and worker-aware persona email, matching `pooledStorageStatePath`. */
function pooledPersonaEmail(baseName: string, testInfo: TestInfo): string {
  const persona = pooledPersonaName(baseName, testInfo.parallelIndex);
  return `${persona}-${testInfo.project.name}@test.hushbox.ai`;
}

/**
 * Artifact policy mirrors `playwright.config.ts`: CI captures nothing, local
 * keeps what the e2e debug report consumes. HAR is a per-context network capture
 * the report attaches on failure (`har-<label>`), so it is recorded locally —
 * including under `e2e:fast` — and skipped only in CI. The in-memory console/API
 * error capture is always on regardless.
 */
const skipHar = !!process.env['CI'];

/**
 * The `recordHar` context option, or `undefined` in CI so no network capture is
 * recorded (mirrors the trace/screenshot gate in playwright.config.ts: CI keeps
 * no artifacts, local keeps what the debug report consumes). Returned spread into
 * `newContext({...})`; callers that gate HAR on a retry pass their own predicate
 * instead.
 */
function harOption(
  harPath: string
): { recordHar: { path: string; mode: 'minimal'; urlFilter: RegExp } } | undefined {
  if (skipHar) return undefined;
  return { recordHar: { path: harPath, mode: 'minimal', urlFilter: API_HAR_URL_FILTER } };
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
 *
 * `enabled` is required rather than defaulted, so a page-creating path can
 * only skip the allowlist by saying so: the one way this guard can be lost is
 * silently, on a page whose spec never asked to lose it.
 */
function installNetworkAllowlist(
  context: BrowserContext,
  page: Page,
  testInfo: TestInfo,
  enabled: boolean
): { violations: NetworkViolation[]; cleanup: () => Promise<void> } {
  // No route registered, so nothing to abort, nothing to record and nothing to
  // unroute — and that absence is the whole effect being asked for: see the
  // `networkAllowlist` option for why registering one at all is the problem.
  if (!enabled) return { violations: [], cleanup: () => Promise.resolve() };
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
// Cache the read + parse + init-script build per persona path — the JSON is
// fixed for the run, and Playwright treats the result as read-only.
const contextOptionsCache = new Map<string, { state: StorageState; initScript: string | null }>();

async function buildContextOptions(
  storageState: StorageState
): Promise<{ state: StorageState; initScript: string | null }> {
  if (typeof storageState !== 'string') {
    return { state: storageState, initScript: null };
  }
  const cached = contextOptionsCache.get(storageState);
  if (cached !== undefined) return cached;
  const raw = JSON.parse(await readFile(storageState, 'utf8')) as RawStorageState;
  const initScript = buildStorageInitScript(raw);
  const result =
    initScript === null
      ? { state: storageState, initScript: null }
      : {
          state: { cookies: raw.cookies as StorageStateObject['cookies'], origins: [] },
          initScript,
        };
  contextOptionsCache.set(storageState, result);
  return result;
}

function createPageFixture(
  spec: FixtureSpec,
  label: string
): (
  deps: { browser: Browser; networkAllowlist: boolean },
  use: (page: Page) => Promise<void>,
  testInfo: TestInfo
) => Promise<void> {
  return async ({ browser, networkAllowlist }, use, testInfo) => {
    const harPath = testInfo.outputPath(`${label}.har`);
    const storageState =
      'persona' in spec ? pooledStorageStatePath(spec.persona, testInfo) : spec.state;
    const { state, initScript } = await buildContextOptions(storageState);
    // Record HAR on every attempt — `closeInstrumentedContext` attaches it
    // only when the attempt fails, so a flaky test's first (failing) attempt
    // has network data in the report instead of only the retry that passed.
    const context = await browser.newContext({
      storageState: state,
      ...harOption(harPath),
    });
    if (initScript !== null) await context.addInitScript({ content: initScript });
    const page = await context.newPage();
    const { finish } = instrumentPage(context, page, testInfo, {
      label,
      harPath,
      networkAllowlist,
    });
    await use(page);
    await finish();
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

interface ChargedModels {
  /**
   * Distinct models the seed charged this account for. The dev endpoint picks
   * that many ids off the live catalog, so it is the count of columns the
   * seed alone puts on a per-model chart.
   */
  modelCount: number;
}

interface MediaConversation {
  conversationId: string;
  assistantMessageId: string;
  page: Page;
}

/** Seed a finished image/video turn via the dev endpoint; returns its ids. */
async function seedMediaConversation(
  request: APIRequestContext,
  testInfo: TestInfo,
  mediaType: 'image' | 'video',
  userContent: string
): Promise<{ conversationId: string; assistantMessageId: string }> {
  const ownerEmail = pooledPersonaEmail('test-alice', testInfo);
  const response = await idempotentPost(request, '/dev/media-conversation', {
    data: { ownerEmail, userContent, mediaType },
  });
  await expectOkResponse(response, `${mediaType} conversation creation`);
  return (await response.json()) as { conversationId: string; assistantMessageId: string };
}

/**
 * No file imports this: `admin/fixtures.ts` re-extends `test`, whose inferred
 * type names it, and withholding the export fails that file with TS4023.
 */
export interface CustomFixtures {
  /**
   * Auto-fixture: clears every per-user and per-share usage rate-limit bucket
   * the dev endpoint's `USAGE_RESET_PREFIXES` names, at the start of every
   * test — the list is named rather than restated so a bucket joining it
   * cannot falsify this. Stops late tests in a worker from hitting 429s caused
   * by prior tests reusing the same test user. Trial IP limits are deliberately
   * not cleared so that `trial-chat.spec.ts` continues to exercise the trial
   * cap firing.
   *
   * Returns `null` (and the fixture value is never read) — Playwright requires
   * a defined return type, and `void` is reserved for function return types.
   */
  resetRateLimitsAutoHook: null;
  /**
   * Auto-fixture: fails a test that read money from the running system and
   * asserted nothing exact about it. Both halves are the money vocabulary's own
   * runtime record — the reads it performed and the comparators that ran — so
   * no list of money-touching specs exists to fall out of date. The rule it
   * enforces is `e2e/CLAUDE.md` 1.5; the decision and its message live in
   * `scripts/lib/money/money-gate.ts`, where they are unit-tested.
   *
   * Returns `null` for the reason `resetRateLimitsAutoHook` does.
   */
  exactMoneyGateAutoHook: null;
  /**
   * Auto-fixture: closes every context {@link instrumentPage} instrumented
   * during the test, after every page's verdict, and attaches each recorded
   * HAR when the test failed. A page fixture's verdict leaves its context open
   * so that a failure it raises is recorded before the close, which is what
   * keeps the context's recording in the trace.
   *
   * Returns `null` for the reason `resetRateLimitsAutoHook` does.
   */
  closeInstrumentedContextsAutoHook: null;
  /**
   * Whether the page fixtures in this module install the network allowlist on
   * the pages they create. `true` unless a spec declares otherwise with
   * `test.use({ networkAllowlist: false })`, so a page is guarded unless its
   * spec says it is not.
   *
   * The one reason to turn it off is that the allowlist is a Playwright route,
   * and registering ANY route switches on WebKit's page-wide request
   * interception — under which WebKit cancels a `keepalive` request still in
   * flight when a cross-document navigation begins. A click that both fires a
   * keepalive beacon and navigates therefore loses the beacon. Measured with
   * four variants: the beacon arrives with no route registered, and does not
   * with a catch-all route, with a predicate that never matches anything, or
   * with a narrow route on the beacon path alone; Chromium delivers under all
   * four. Registering is what does it, not what the route does — so nothing
   * short of registering no route recovers the beacon.
   *
   * It removes the allowlist and nothing else. The console-error and
   * API-error guards attach listeners rather than routes, so they stay armed
   * on a page that declares this, which is why the option is per-page rather
   * than the spec taking an uninstrumented page.
   *
   * It reaches the page fixtures this module creates. A page instrumented
   * directly through {@link instrumentPage} — the admin suite's `adminPage` —
   * takes that function's own argument instead.
   */
  networkAllowlist: boolean;
  authenticatedPage: Page;
  unauthenticatedPage: Page;
  /** Factory for creating fresh, fully-instrumented browser contexts on demand.
   *  Each page gets HAR recording, console error capture, and page snapshot on failure.
   *  Defaults to empty storage state (unauthenticated). Pass a storage state path for auth. */
  createPage: (storageState?: StorageState) => Promise<Page>;
  testConversation: TestConversation;
  /** Spending on several distinct models, for the pages that report usage. */
  chargedModels: ChargedModels;
  multiModelConversation: MultiModelConversation;
  /** Authenticated conversation with one finished image generation. */
  imageConversation: MediaConversation;
  /** Authenticated conversation with one finished video generation. */
  videoConversation: MediaConversation;
  /** Authenticated zero-wallet (free-tier) user, for affordability error testing. */
  lowBalancePage: Page;
  authenticatedRequest: APIRequestContext;
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

/**
 * Withheld from export, `admin/fixtures.ts` fails with TS4023 for the reason
 * `CustomFixtures` carries.
 */
export interface CustomWorkerFixtures {
  /**
   * Request context reused by `resetRateLimitsAutoHook`, built once per worker so
   * each test pays only the DELETE. Request contexts hold no isolation state.
   */
  rateLimitResetRequest: APIRequestContext;
}

async function zeroLowBalanceWallets(
  requestContext: APIRequestContext,
  email: string
): Promise<void> {
  // Zero both wallets so the payer resolves to the free tier, whose spendable
  // is the day-keyed daily allowance and not a wallet balance. That is the
  // whole effect, and it leaves the payer with the day's allowance to spend:
  // a turn is refused only when its estimate exceeds that allowance, which a
  // caller reaches by COST. The allowance cannot be pre-spent from a test —
  // `allowance_spending` is written only by the billing slice at settlement,
  // and no dev route reaches it.
  await postWalletBalanceSeedUnchecked(requestContext, email, 'purchased', '0.00000000');
  await postWalletBalanceSeedUnchecked(requestContext, email, 'free_tier', '0.00000000');
}

/**
 * Every context {@link instrumentPage} instrumented, per test, in the order it
 * instrumented them; `closeInstrumentedContextsAutoHook` closes them.
 */
const instrumentedContexts = new WeakMap<TestInfo, InstrumentedContext[]>();

/** Closes every context instrumented during `testInfo`'s test. */
async function closeInstrumentedContexts(testInfo: TestInfo): Promise<void> {
  const entries = instrumentedContexts.get(testInfo) ?? [];
  instrumentedContexts.delete(testInfo);
  for (const entry of entries) {
    await closeInstrumentedContext(entry, testInfo);
  }
}

/**
 * Install the per-page guardrails on `page` and hand back the verdict that
 * enforces them: console-error capture, unexpected-API-≥400 capture (the
 * default API origin plus any `extraApiUrl` origin, such as the admin SPA's
 * `/api` proxy), the network allowlist, and failure artifacts.
 *
 * Every page-creating fixture in this module goes through here, and so does a
 * page the harness did not build — the admin suite's `adminPage`, which rides
 * the built-in `page` fixture to keep the project's baseURL/device options.
 * One installer is what makes a guardrail's proof transferable: a test that
 * provokes one of these guards through this function is exercising the same
 * code every fixture page runs, so the two cannot drift apart.
 *
 * Call before the page's first navigation. `finish()` must run after `use()`:
 * it attaches failure artifacts and promotes captured errors to test failures
 * (opt-outs via `expectConsoleErrors` / `expectApiErrors` apply), and leaves
 * the context open for `closeInstrumentedContextsAutoHook` to close.
 *
 * `harPath` names the file a `recordHar` context is writing to, so teardown
 * can attach it after the close that flushes it; omit it for a context that
 * records none. `networkAllowlist` defaults to installing the allowlist, so a
 * caller can only lose that guard by naming it.
 */
export function instrumentPage(
  context: BrowserContext,
  page: Page,
  testInfo: TestInfo,
  options: {
    label: string;
    extraApiUrl?: (url: string) => boolean;
    harPath?: string;
    networkAllowlist?: boolean;
  }
): { finish: () => Promise<void> } {
  const { entries, cleanup } = attachConsoleErrors(page);
  const {
    errors: apiErrors,
    settle: settleApi,
    cleanup: cleanupApi,
  } = attachApiErrors(page, options.extraApiUrl);
  const { violations, cleanup: cleanupNetwork } = installNetworkAllowlist(
    context,
    page,
    testInfo,
    options.networkAllowlist ?? true
  );
  const registered = instrumentedContexts.get(testInfo) ?? [];
  registered.push({
    context,
    label: options.label,
    harPath: options.harPath ?? '',
    cleanup,
    cleanupApi,
    cleanupNetwork,
  });
  instrumentedContexts.set(testInfo, registered);
  return {
    finish: async () => {
      const failed = testInfo.status !== testInfo.expectedStatus;
      await judgePage(
        { page, label: options.label, entries, apiErrors, violations, settleApi },
        failed,
        testInfo
      );
    },
  };
}

export const test = base.extend<CustomFixtures, CustomWorkerFixtures>({
  // An option, so a spec declares it once with `test.use(...)` rather than
  // every page fixture growing a parameter its callers thread. Default `true`:
  // the guard is lost only where a spec asks, never by omission. See the
  // `networkAllowlist` entry in `CustomFixtures` for what asking costs and why
  // a spec would.
  networkAllowlist: [true, { option: true }],
  // Wrap the built-in request context once so every node-side API call retries a
  // transient saturation sever (5xx envelope or socket drop) by construction —
  // a plain `request.get(...)` is resilient and there are no per-call retry
  // wrappers to forget. `authenticatedRequest` and every
  // `playwright.request.newContext` the harness creates are wrapped the same
  // way; lint forbids reaching past this via `page.request.<method>()`.
  request: async ({ request }, use) => {
    await use(withRequestRetry(request));
  },
  // The caller identity every context created during a test presents. The
  // project's own `extraHTTPHeaders` can name only slot 0 — config evaluation
  // has no worker index — so this narrows it to the running worker's slot, and
  // Playwright applies the resolved option as the default for every browser and
  // request context built inside the test, hand-built ones included. Without it
  // a project's workers share one per-IP window and spend each other's budget.
  extraHTTPHeaders: async ({ extraHTTPHeaders }, use) => {
    await use({ ...extraHTTPHeaders, ...callerHeaders() });
  },
  // Worker-scoped, yet it still presents this worker's caller address: it is
  // pulled in as a dependency of a test-scoped auto fixture, by which point
  // Playwright's own artifacts fixture has installed the hook that applies the
  // resolved context options to every context built during the test. The
  // address it presents is the one the reset must present — the dev endpoint
  // clears the per-IP buckets of its own caller and no other.
  rateLimitResetRequest: [
    async ({ playwright }, use) => {
      const ctx = withRequestRetry(await playwright.request.newContext({ baseURL: apiUrl }));
      await use(ctx);
      await ctx.dispose();
    },
    { scope: 'worker' },
  ],
  // Both of this worker's identities, because the endpoint clears the per-IP
  // buckets of its CALLER alone: the request context carries this worker's
  // caller address, and the second call presents the guest address the specs
  // in this worker send from. Skipping the second one would leave every
  // sessionless window that address spends cleared by nobody and accumulating
  // within its 60s window.
  // Together, since neither call's per-IP keys are the other's and the shared
  // prefixes they both walk delete idempotently.
  resetRateLimitsAutoHook: [
    async ({ rateLimitResetRequest }, use) => {
      await Promise.all([
        clearUsageRateLimits(rateLimitResetRequest),
        clearUsageRateLimits(rateLimitResetRequest, guestIp()),
      ]);
      await use(null);
    },
    { auto: true },
  ],

  // Cleared before the test can touch anything and drained after it, which is
  // what makes a process-wide ledger a per-test one: a worker runs its tests
  // one at a time. It depends on no other fixture, so it is set up first and
  // torn down last — after every page teardown, and therefore after the
  // console/API/allowlist failures those raise.
  exactMoneyGateAutoHook: [
    // Playwright's innerFixtureParameterNames (lib/common/index.js) reads the first parameter's named props as fixture dependencies and rejects rest props.
    // eslint-disable-next-line no-empty-pattern -- the empty pattern is the only shape a dependency-free fixture can take
    async ({}, use, testInfo) => {
      resetMoneyLedger();
      await use(null);
      // A test that already failed is passed over rather than gated: a second
      // error beside the real one buries it, and a missing money assertion is
      // not a conclusion to draw about a test that never got that far.
      const failure = moneyGateFailure(takeMoneyLedger(), {
        title: testInfo.title,
        file: path.relative(process.cwd(), testInfo.file),
        failed: testInfo.status !== testInfo.expectedStatus,
      });
      if (failure !== null) throw new Error(failure);
    },
    { auto: true },
  ],

  // With no dependencies it is set up before every page fixture, so it is torn
  // down after all of them. Playwright records a fixture's teardown error as
  // the fixture throws it, so every page's verdict is in the test's status
  // before any context closes here; a context closed while the test still
  // reads as passing has its trace recording discarded.
  closeInstrumentedContextsAutoHook: [
    // eslint-disable-next-line no-empty-pattern -- the empty pattern is the only shape a dependency-free fixture can take
    async ({}, use, testInfo) => {
      await use(null);
      await closeInstrumentedContexts(testInfo);
    },
    // Its own slot: sharing the test's, it would be skipped once a verdict torn
    // down before it had spent that slot, leaving every context open.
    { auto: true, timeout: TIMEOUTS.LONG },
  ],

  authenticatedPage: createPageFixture({ persona: 'test-alice' }, 'authenticatedPage'),

  // Explicitly clear storage state to override project-level default auth
  unauthenticatedPage: createPageFixture(
    { state: { cookies: [], origins: [] } },
    'unauthenticatedPage'
  ),

  createPage: async ({ browser, networkAllowlist }, use, testInfo) => {
    const finishes: (() => Promise<void>)[] = [];
    let counter = 0;

    const DEFAULT_STORAGE_STATE: StorageState = { cookies: [], origins: [] };
    const factory = async (storageState: StorageState = DEFAULT_STORAGE_STATE): Promise<Page> => {
      counter++;
      const label = `unauthenticatedPage-${String(counter)}`;
      const harPath = testInfo.outputPath(`${label}.har`);
      const { state, initScript } = await buildContextOptions(storageState);
      const context = await browser.newContext({
        storageState: state,
        ...harOption(harPath),
      });
      if (initScript !== null) await context.addInitScript({ content: initScript });
      const page = await context.newPage();
      const { finish } = instrumentPage(context, page, testInfo, {
        label,
        harPath,
        networkAllowlist,
      });
      finishes.push(finish);
      return page;
    };

    await use(factory);

    for (const finish of finishes) {
      await finish();
    }
  },

  authenticatedRequest: async ({ playwright }, use, testInfo) => {
    const context = await playwright.request.newContext({
      baseURL: apiUrl,
      storageState: pooledStorageStatePath('test-alice', testInfo),
    });
    await use(withRequestRetry(context));
    await context.dispose();
  },

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
    await use(withRequestRetry(context));
    await context.dispose();
  },

  groupConversation: async (
    { authenticatedPage: _authenticatedPage, authenticatedRequest },
    use,
    testInfo
  ) => {
    const aliceEmail = pooledPersonaEmail('test-alice', testInfo);
    const bobEmail = pooledPersonaEmail('test-bob', testInfo);
    const response = await idempotentPost(authenticatedRequest, '/dev/group-chat', {
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

    await expectOkResponse(response, 'group-chat creation');
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
      storageState: pooledStorageStatePath('test-bob', testInfo),
    });
    await use(withRequestRetry(context));
    await context.dispose();
  },

  // Spend across several models, seeded through the dev endpoint so the usage
  // page has something of this account's own to report. The e2e roster is
  // minted with wallet balances and email verification only; `hasSampleData`
  // selects which dev personas get bulk sample data (`personasWithSampleData`
  // in `scripts/seed.ts`) and is never consulted for the e2e roster, so no
  // pooled persona carries usage history. Without this seed a spec that reads
  // the page reports whatever earlier specs happened to leave on the same
  // worker slot.
  chargedModels: async ({ authenticatedRequest }, use, testInfo) => {
    const modelCount = 2;
    const response = await idempotentPost(authenticatedRequest, '/dev/conversation', {
      data: {
        ownerEmail: pooledPersonaEmail('test-alice', testInfo),
        aiTurn: {
          userContent: `Charged-models fixture ${String(Date.now())}`,
          responseCount: modelCount,
        },
      },
    });
    await expectOkResponse(response, 'charged-model spending seed');
    await use({ modelCount });
  },

  // API-seeded multi-model turn: one user message and two sibling AI responses
  // sharing a parent message and batch id (the exact shape `saveChatTurn`
  // writes), seeded server-side via the dev endpoint instead of driving the UI
  // through a real two-model send. The two AI rows carry distinct live-catalog
  // model ids (distinct nametags) and non-null seed costs (visible cost badges).
  multiModelConversation: async ({ authenticatedPage, authenticatedRequest }, use, testInfo) => {
    const userContent = `Multi-model fixture ${String(Date.now())}`;
    const aliceEmail = pooledPersonaEmail('test-alice', testInfo);
    const response = await idempotentPost(authenticatedRequest, '/dev/conversation', {
      data: {
        ownerEmail: aliceEmail,
        aiTurn: { userContent, responseCount: 2 },
      },
    });

    await expectOkResponse(response, 'multi-model conversation creation');
    const data = (await response.json()) as { conversationId: string };
    const id = data.conversationId;

    await authenticatedPage.goto(`/chat/${id}`, { waitUntil: 'domcontentloaded' });
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.waitForConversationLoaded();
    // Both AI siblings render as multi-model peers (proves the shared parent +
    // batch id), and each shows a cost badge — the shape the dependent specs
    // (nametags, per-model cost, retry/regenerate) assert against.
    await rawExpect(chatPage.messageList).toHaveAttribute('data-assistant-count', '2', {
      timeout: TIMEOUTS.CONVERSATION_LOAD,
    });
    await rawExpect(chatPage.messageList).toHaveAttribute('data-cost-count', '2', {
      timeout: TIMEOUTS.CONVERSATION_LOAD,
    });

    // Leave the composer in 2-model mode. The seed populates the conversation's
    // history but not the client's model selection; a follow-up send relies on
    // this selection to fan out to two models (matching the prior UI-driven
    // fixture's persisted post-state). `data-app-stable` only exists on the
    // new-chat route, so gate on the conversation being loaded (above) instead.
    await chatPage.selectModels(2);

    await use({ id, url: `/chat/${id}` });
  },

  // API-seeded image turn (one prompt + one finished AI image) — no UI generate.
  imageConversation: async ({ authenticatedPage, authenticatedRequest }, use, testInfo) => {
    const { conversationId, assistantMessageId } = await seedMediaConversation(
      authenticatedRequest,
      testInfo,
      'image',
      `Image fixture ${String(Date.now())}`
    );

    await authenticatedPage.goto(`/chat/${conversationId}`, { waitUntil: 'domcontentloaded' });
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.waitForConversationLoaded();
    // Gate handoff on the seed decoding, so a broken seed fails here, not mid-test.
    await chatPage.expectImageVisible();

    await use({ conversationId, assistantMessageId, page: authenticatedPage });
  },

  // API-seeded video turn — see imageConversation.
  videoConversation: async ({ authenticatedPage, authenticatedRequest }, use, testInfo) => {
    const { conversationId, assistantMessageId } = await seedMediaConversation(
      authenticatedRequest,
      testInfo,
      'video',
      `Video fixture ${String(Date.now())}`
    );

    await authenticatedPage.goto(`/chat/${conversationId}`, { waitUntil: 'domcontentloaded' });
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.waitForConversationLoaded();
    await chatPage.expectVideoVisible();

    await use({ conversationId, assistantMessageId, page: authenticatedPage });
  },

  // Low-balance page: authenticated as test-billing-validation (zero starting balance);
  // both wallets are zeroed via the dev endpoint before the test runs so the user
  // lands on the free tier, funded by the day's allowance — see
  // `zeroLowBalanceWallets` for what that does and does not establish. The
  // "paid + $0.01" route doesn't work here: the $0.50 paid-tier cushion always
  // covers image/Smart-Model preflight costs. Reset to $0 after the test to
  // avoid bleed.
  lowBalancePage: async ({ browser, playwright, networkAllowlist }, use, testInfo) => {
    const projectName = testInfo.project.name;
    const lowBalanceEmail = `test-billing-validation-${projectName}@test.hushbox.ai`;
    const storageStatePath = `e2e/.auth/${projectName}/test-billing-validation.json`;
    const requestContext = withRequestRetry(
      await playwright.request.newContext({
        baseURL: apiUrl,
        storageState: storageStatePath,
      })
    );

    await zeroLowBalanceWallets(requestContext, lowBalanceEmail);

    const harPath = testInfo.outputPath('lowBalancePage.har');
    const isRetry = testInfo.retry > 0;
    const context = await browser.newContext({
      storageState: storageStatePath,
      ...(isRetry && {
        recordHar: { path: harPath, mode: 'minimal', urlFilter: API_HAR_URL_FILTER },
      }),
    });
    const page = await context.newPage();
    const { finish } = instrumentPage(context, page, testInfo, {
      label: 'lowBalancePage',
      harPath,
      networkAllowlist,
    });
    await use(page);
    await finish();

    await postWalletBalanceSeedUnchecked(
      requestContext,
      lowBalanceEmail,
      'purchased',
      '0.00000000'
    );
    await requestContext.dispose();
  },

  testConversation: async ({ authenticatedPage, authenticatedRequest }, use, testInfo) => {
    const testMessage = `Fixture setup ${String(Date.now())}`;
    const aliceEmail = pooledPersonaEmail('test-alice', testInfo);
    const response = await idempotentPost(authenticatedRequest, '/dev/conversation', {
      data: {
        ownerEmail: aliceEmail,
        messages: [
          { content: testMessage, senderType: 'user' },
          { content: `Echo: ${testMessage}`, senderType: 'ai' },
        ],
      },
    });

    await expectOkResponse(response, 'conversation creation');
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

export { allowExternalHosts } from './helpers/network-allowlist.js';
export { expectApiErrors, expectConsoleErrors } from './helpers/page-guardrails.js';
export type { ConsoleErrorMatcher } from './helpers/page-guardrails.js';
export { expect } from './helpers/expect.js';

// Re-export the Playwright value-less types specs need, so specs source them
// here instead of importing `@playwright/test` directly (lint-banned in specs)
// — the fixtures module is the single door to the harness for both runtime
// values and types.
export type {
  APIRequestContext,
  Browser,
  BrowserContext,
  Locator,
  Page,
  Request,
  Response,
} from '@playwright/test';
