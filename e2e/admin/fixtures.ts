import { devAdminTokenResponseSchema, TEST_IDS } from '@hushbox/shared';
import {
  test as base,
  expect,
  expectApiErrors,
  expectConsoleErrors,
  instrumentPage,
  type ConsoleErrorMatcher,
} from '../fixtures.js';
import { requireEnv } from '../helpers/env.js';
import { expectOkResponse } from '../helpers/ok-response.js';
import { withProjectHeaders } from '../helpers/project-headers.js';
import { withRequestRetry } from '../helpers/resilient-request.js';
import { DEV_ADMIN_ACTORS, type DevAdminActor } from './helpers/actors.js';
import type { APIRequestContext, Page } from '@playwright/test';

const apiUrl = requireEnv('VITE_API_URL');
const adminPort = requireEnv('HB_ADMIN_PORT');
const ADMIN_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1']);

/**
 * Whether `url` is browser-side admin-API traffic: the admin SPA always calls
 * relative `/api/*` on its OWN origin (the admin dev server proxies it to the
 * Worker — apps/admin vite.config.ts), so these requests carry the admin
 * host:port, never `HB_API_PORT`. Feeds `instrumentPage`'s API-error capture.
 */
function isAdminProxiedApiUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    ADMIN_HOSTS.has(parsed.hostname) &&
    parsed.port === adminPort &&
    parsed.pathname.startsWith('/api/')
  );
}

/**
 * Factory returning a Worker-direct `APIRequestContext` authenticated as the
 * given dev admin actor: mints a dev Access JWT from the dev-only
 * `GET /dev/admin-token` route (the same mint the SPA's dev-auth fetch wrapper
 * uses) and attaches it under the header the route names
 * (`Cf-Access-Jwt-Assertion`). Requests hit the Worker's bare paths
 * (`/admin/...`) — no `/api` prefix; that prefix exists only on the SPA's
 * proxied origin.
 */
type AdminApiFactory = (actor?: DevAdminActor) => Promise<APIRequestContext>;

interface AdminFixtures {
  /** Per-actor authenticated API contexts for admin-plane routes. */
  adminApi: AdminApiFactory;
  /**
   * The admin SPA, navigated to the dashboard and settled (shell rendered).
   * Browser flows need no auth plumbing: the SPA self-authenticates in local
   * dev via its dev-auth fetch wrapper.
   *
   * READ BUDGET: this navigation spends one dashboard read of 240/hr on the
   * SPA's default actor in every admin test that takes this fixture, whatever
   * the spec is testing — which is why a run must start that window at zero,
   * which the E2E bring-up's flush of the stack's Redis database does locally
   * and a CI runner's empty Redis does in CI;
   * `resetAdminDashboardReads` in `apps/api/src/dev/redis-resets.ts` states why
   * it has a reset. Nothing clears it during a run.
   */
  adminPage: Page;
}

/**
 * The OpModal blindly probes `GET /api/admin/ops/<name>/prefill` on every
 * op-form open; a 404 is the designed "no resolver — open blank" signal
 * (silent prefill), never an error. Every spec that opens an op form triggers
 * it, so the allowance is suite-wide. Scoped to exactly GET + the prefill
 * path + status 404: any other status, method, or admin-API path still fails.
 * Matches the captured-line shape `<time> <status> <statusText> <method>
 * <url>` (body on following lines).
 */
const PREFILL_PROBE_404 = new RegExp(
  String.raw`^\S+ 404 [^\n]*GET https?://[^\n/]+/api/admin/ops/[^/\s]+/prefill$`,
  'm'
);

/**
 * Chromium's companion console line for the same prefill-probe 404. Its text
 * carries no URL — the line is byte-identical whatever failed to load — so the
 * allowance reads the console error's source URL instead of its text alone and
 * admits it only for the admin-API origin the api-errors channel above
 * polices. A 404 on an admin static asset (a script, a stylesheet, an icon)
 * carries the same text from a path `isAdminProxiedApiUrl` refuses, so it
 * reaches neither channel's allowance and fails the test.
 */
const PREFILL_PROBE_404_CONSOLE_TEXT =
  /^Failed to load resource: the server responded with a status of 404 \(Not Found\)$/;

const prefillProbe404Console: ConsoleErrorMatcher = (error) =>
  PREFILL_PROBE_404_CONSOLE_TEXT.test(error.text) && isAdminProxiedApiUrl(error.url);

export const test = base.extend<AdminFixtures>({
  adminApi: async ({ playwright }, use) => {
    const contexts: APIRequestContext[] = [];

    const factory: AdminApiFactory = async (actor = DEV_ADMIN_ACTORS[0]) => {
      const mintContext = withRequestRetry(
        await playwright.request.newContext({ baseURL: apiUrl })
      );
      try {
        const response = await mintContext.get('/dev/admin-token', {
          params: { email: actor },
        });
        await expectOkResponse(response, `adminApi: dev admin token mint for ${actor}`);
        const { token, header } = devAdminTokenResponseSchema.parse(await response.json());
        const context = withRequestRetry(
          await playwright.request.newContext({
            baseURL: apiUrl,
            extraHTTPHeaders: withProjectHeaders({ [header]: token }),
          })
        );
        contexts.push(context);
        return context;
      } finally {
        await mintContext.dispose();
      }
    };

    await use(factory);

    for (const context of contexts) {
      await context.dispose();
    }
  },

  adminPage: async ({ context, page }, use, testInfo) => {
    // The built-in `page` fixture carries none of the base suite's per-page
    // guardrails; wire them before the first navigation so console errors,
    // unexpected admin-API ≥400s, and non-allowlisted egress fail the test.
    const instrumentation = instrumentPage(context, page, testInfo, {
      label: 'adminPage',
      extraApiUrl: isAdminProxiedApiUrl,
    });
    expectApiErrors(page, [PREFILL_PROBE_404]);
    expectConsoleErrors(page, [prefillProbe404Console]);
    await page.goto('/');
    await expect(page.getByTestId(TEST_IDS.adminShell)).toBeVisible();
    await use(page);
    await instrumentation.finish();
  },
});

export { expect } from '../fixtures.js';

// Re-export the Playwright types admin specs need, so admin specs source them
// here instead of importing `@playwright/test` directly (lint-banned in specs).
export type { APIRequestContext, Locator, Page } from '@playwright/test';
