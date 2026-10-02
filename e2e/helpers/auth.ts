import { generateTotpCodeSync } from '@hushbox/crypto';
import { isMobileWidth, TEST_IDS, TEST_SIGNALS } from '@hushbox/shared';
import { TEST_EMAIL_DOMAIN } from '../../packages/shared/src/constants.js';
import { TIMEOUTS } from '../config/timeouts.js';
import { requireEnv } from './env.js';
import { idempotentDelete } from './idempotent-request.js';
import { expectOkResponse } from './ok-response.js';
import { waitForAppStable } from './page-signals.js';
import type { Page, APIRequestContext, Locator } from '@playwright/test';

const API_BASE = requireEnv('VITE_API_URL');

/**
 * Passes the beta welcome, fills the signup form and submits. Does NOT verify email.
 * After success, expects the "Check your email" confirmation.
 */
export async function signUpViaUI(
  page: Page,
  request: APIRequestContext,
  options: { username: string; email: string; password: string }
): Promise<void> {
  const submit = async (): Promise<void> => {
    await page.goto('/signup', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Join the beta' }).click();
    await page.getByLabel('Username').fill(options.username);
    await page.getByLabel('Email').fill(options.email);
    await page.getByLabel('Password', { exact: true }).fill(options.password);
    await page.getByLabel('Confirm password').fill(options.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByText('Check your email').waitFor({ timeout: TIMEOUTS.ROUTE });
  };

  try {
    await submit();
  } catch {
    // A wrangler/workerd recycle under host saturation severs the in-flight
    // OPAQUE register call (the page stays on /signup with no confirmation). The
    // dev verify-token endpoint is the oracle: a committed register/finish
    // leaves the account and its verify token present even when the response was
    // severed, so accept that as success rather than re-submitting into the
    // unique-email constraint. If no account landed, the register never reached
    // commit, so a single fresh submit is safe.
    if (await accountExists(request, options.email)) return;
    await submit();
  }
}

/**
 * Calls the dev endpoint to get the email verification token, then navigates
 * to the verification URL. Returns the token.
 */
export async function verifyEmailViaAPI(
  request: APIRequestContext,
  page: Page,
  email: string
): Promise<string> {
  const response = await request.get(`${API_BASE}/dev/verify-token/${encodeURIComponent(email)}`);
  await expectOkResponse(response, `verify token read for ${email}`);
  const { token } = (await response.json()) as { token: string };
  await page.goto(`/verify?token=${token}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Email verified' }).waitFor({ timeout: TIMEOUTS.ROUTE });
  return token;
}

/**
 * Fills the login form and submits. Waits for navigation to /chat.
 * Does NOT handle 2FA — use loginWithTOTP for 2FA users.
 *
 * Pass `keepSignedIn` whenever a second page of the same context will be
 * opened. Without it the sign-in marker is written to sessionStorage, which is
 * per-tab, so the second page boots with no marker — and that branch
 * (`doInitAuth` in `apps/web/src/lib/auth/auth.ts`) purges the origin-wide
 * device-key store, logging the first page out.
 */
export async function loginViaUI(
  page: Page,
  options: { email: string; password: string; keepSignedIn?: boolean }
): Promise<void> {
  const submit = async (): Promise<void> => {
    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Email or Username').fill(options.email);
    await page.getByLabel('Password', { exact: true }).fill(options.password);

    if (options.keepSignedIn) {
      await page.getByLabel('Keep me signed in').check();
    }

    await page.getByRole('button', { name: 'Log in' }).click();
    await page.waitForURL('/chat', { timeout: TIMEOUTS.ROUTE });
  };

  try {
    await submit();
  } catch {
    // A wrangler/workerd recycle under host saturation severs the in-flight
    // OPAQUE login call, leaving the page on /login with no navigation. A login
    // carries no server-side state to collide with, so re-running it from a
    // fresh form is safe; one retry covers a single recycle window. This helper
    // is for expected-success logins only (failure-path tests drive the form
    // directly), so the broad catch is intentional — a genuine failure still
    // surfaces when the second attempt also fails to reach /chat.
    await submit();
  }
  // Login fires a non-awaited client navigation to /chat; waitForURL resolves on
  // URL commit, not when that navigation settles. Wait for the landing page's
  // stability signal so a caller's next hard navigation (reload/goto) can't race
  // and cancel the still-in-flight redirect.
  await waitForAppStable(page);
}

/**
 * Full signup + verify + login combo.
 */
export async function signUpAndVerify(
  page: Page,
  request: APIRequestContext,
  options: { username: string; email: string; password: string }
): Promise<void> {
  await signUpViaUI(page, request, options);
  await verifyEmailViaAPI(request, page, options.email);
  await loginViaUI(page, { email: options.email, password: options.password });
}

/**
 * True once a user row with a pending email-verify token exists for `email` —
 * i.e. register/finish committed. The request context retries a recycle drop on
 * its own, so the oracle survives saturation; a 404 (terminal) means no account
 * yet.
 */
async function accountExists(request: APIRequestContext, email: string): Promise<boolean> {
  const response = await request.get(`${API_BASE}/dev/verify-token/${encodeURIComponent(email)}`);
  return response.ok();
}

/**
 * Generates a TOTP code from a secret.
 */
export function generateTOTPCode(secret: string): string {
  return generateTotpCodeSync(secret);
}

/**
 * Generates a unique email for test isolation.
 * Format: {prefix}-{timestamp}-{random}@test.hushbox.ai
 */
export function uniqueEmail(prefix: string): string {
  const timestamp = Date.now();
  const random = crypto.getRandomValues(new Uint8Array(4));
  const hex = [...random].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}-${String(timestamp)}-${hex}@${TEST_EMAIL_DOMAIN}`;
}

/**
 * Generates a unique canonical username for test isolation. Returns the
 * already-normalized form (lowercase, no spaces) so callers don't have to
 * think about USERNAME_REGEX (`/^[a-z][a-z0-9_]{2,19}$/`). Mirrors
 * `uniqueEmail`'s entropy recipe — without 4 bytes of random suffix,
 * parallel tests starting in the same millisecond collide on the
 * `users_username_unique` constraint and the /register/finish call fails.
 *
 * Output length: 3 (prefix) + 4 (timestamp) + 8 (hex) = 15 chars.
 */
export function uniqueUsername(prefix: string): string {
  const cleanPrefix =
    prefix
      .slice(0, 3)
      .toLowerCase()
      .replaceAll(/[^a-z]/g, '') || 'tst';
  const random = crypto.getRandomValues(new Uint8Array(4));
  const hex = [...random].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${cleanPrefix}${String(Date.now()).slice(-4)}${hex}`;
}

/**
 * Clears auth rate limits via the dev endpoint, for this caller and for the
 * accounts it names — nothing else. `identifiers` takes emails or usernames in
 * any case; each clears that account's lockouts, its email throttles and its
 * TOTP replay markers. Of the per-IP auth throttles, only the ones keyed to
 * THIS caller's address go, whatever is named. The windows keyed on an account
 * and an address together — login's and recovery's per-network lockouts — need
 * both: naming the account clears them for this call's address alone.
 *
 * Pass `[]` when the accounts a test exercises do not exist yet — a fresh
 * signup carries no counters, so the per-IP dimension is the whole ask. Name
 * every persona a test drives repeatedly through a lockout: a seeded persona's
 * counters outlive the test that spent them.
 *
 * The endpoint deliberately cannot clear an account it was not given. Every
 * Playwright worker and the api suite share one Redis, and while it globbed,
 * one worker's reset deleted counters another worker was mid-way through
 * asserting on.
 *
 * The email-verification consume throttle, keyed on a token, is cleared by
 * nothing at all; it drains when its own window expires.
 */
export async function clearAuthRateLimits(
  request: APIRequestContext,
  identifiers: readonly string[]
): Promise<void> {
  await idempotentDelete(request, `${API_BASE}/dev/auth-rate-limits`, {
    data: { identifiers },
  });
}

/**
 * Clears usage rate limits so consecutive E2E tests sharing a user don't
 * saturate the per-minute buckets. Two scopes, not one: every per-user and
 * per-share bucket the endpoint's own `USAGE_RESET_PREFIXES` names goes for
 * every identity in the environment, and of the per-IP buckets only the ones
 * keyed to THIS caller's address. Naming that list rather than restating its
 * contents is deliberate: a restatement here decays silently the moment a
 * bucket joins it.
 *
 * `asIp` presents a different caller, which is the only way to reach another
 * identity's per-IP buckets: a guest window is cleared by a call made from that
 * guest's address. It does not widen the wipe — the endpoint is caller-scoped
 * whoever calls it.
 */
export async function clearUsageRateLimits(
  request: APIRequestContext,
  asIp?: string
): Promise<void> {
  await idempotentDelete(
    request,
    `${API_BASE}/dev/usage-rate-limits`,
    asIp === undefined ? {} : { headers: { 'cf-connecting-ip': asIp } }
  );
}

/**
 * Returns a TOTP code the server will accept now, even when a code was already
 * consumed earlier in the same 30-second window. Clears the user's replay
 * markers via the dev endpoint so the current code is no longer replay-blocked;
 * the server's replay check and crypto verification still run against it.
 */
export async function getAcceptableTOTPCode(
  request: APIRequestContext,
  email: string,
  secret: string
): Promise<string> {
  await idempotentDelete(request, `${API_BASE}/dev/totp-replay`, { data: { email } });
  return generateTOTPCode(secret);
}

/**
 * Presses Escape once when something else owns the pixel at `target`'s centre.
 *
 * The condition is the hit test Playwright's own actionability check runs, not
 * the presence of an overlay anywhere on the page: a modal sheet legitimately
 * covers what is beneath it, so only a cover over the element about to be
 * clicked is evidence that a click cannot land. An Escape fired on presence
 * alone would close a layer the caller still depends on.
 *
 * One press, never a loop. Escape dismisses the topmost layer, so a second
 * press would close a layer that was never in the way; where one press does not
 * clear the cover, the click that follows retries actionability and then fails
 * naming the element that intercepted it, which is the more useful report.
 *
 * The wait is what makes the hit test run at all: an instant visibility probe
 * returns false on a target that has not painted yet and skips the dismissal
 * entirely, making the protection load-dependent. Where the target paints, the
 * wait costs nothing, because the caller's click demands the same visibility
 * immediately afterwards; where it never paints, this wait rather than the click
 * is what hangs, and `locator.waitFor` has no default timeout, so without a
 * budget it spends the enclosing test's whole one. The failure names the locator
 * either way: the budget buys the latency and a bound stated here.
 */
async function dismissOverlayCovering(page: Page, target: Locator): Promise<void> {
  await target.waitFor({ state: 'visible', timeout: TIMEOUTS.ASSERT });

  const covered = await target.evaluate((element) => {
    const { left, top, width, height } = element.getBoundingClientRect();
    const atPoint = document.elementFromPoint(left + width / 2, top + height / 2);
    // A null hit means the centre lies outside the viewport, which is not a
    // cover; the click's own actionability check owns that case.
    return atPoint !== null && !element.contains(atPoint);
  });
  if (!covered) return;

  await page.keyboard.press('Escape');
}

/**
 * Opens the main sidebar Sheet on mobile if it's not already visible.
 * On desktop viewports this is a no-op (sidebar is always rendered).
 *
 * A modal sheet a caller left open earlier — the member sidebar, say — renders
 * a full-viewport overlay at mobile widths that swallows every click at the
 * hamburger until the test's budget runs out, so a cover over the hamburger is
 * dismissed before it is clicked.
 *
 * The budget on the sidebar wait is not redundant, for the reason recorded on
 * {@link dismissOverlayCovering}.
 */
export async function openMobileSidebarIfNeeded(page: Page): Promise<void> {
  const viewport = page.viewportSize();
  if (viewport === null || !isMobileWidth(viewport.width)) return;

  const sidebar = page.getByTestId(TEST_IDS.sidebar);
  if (await sidebar.isVisible()) return;

  const hamburger = page.getByTestId(TEST_IDS.hamburgerButton);
  await dismissOverlayCovering(page, hamburger);
  await hamburger.click();
  await sidebar.waitFor({ state: 'visible', timeout: TIMEOUTS.ASSERT });
}

/**
 * Logs out via the sidebar footer dropdown menu, returning once the app reports
 * — on the document the sign-out reload produced — that it holds no session.
 *
 * Where that leaves the page is the route's own business and deliberately not
 * asserted here: sign-out reloads in place, so a `requireAuth` route redirects
 * the cleared session to the login page while an unguarded one (the chat index)
 * stays put as a trial page. A caller that needs the login form navigates to it.
 *
 * The load event fences the outgoing document from the incoming one. Sign-out
 * clears the auth store before it calls reload, so the signed-out signal turns
 * true on the outgoing document as well, and gating on the signal alone can
 * return while that document is still on screen.
 */
export async function logoutViaUI(page: Page): Promise<void> {
  await openMobileSidebarIfNeeded(page);
  await page.getByTestId(TEST_IDS.accountButton).click();
  const reloaded = page.waitForEvent('load', { timeout: TIMEOUTS.ROUTE });
  await page.getByTestId(TEST_IDS.menuLogout).click();
  await reloaded;
  await page
    .locator(`[${TEST_SIGNALS.signedOut}="true"]`)
    .waitFor({ state: 'visible', timeout: TIMEOUTS.APP_STABLE });
}

/**
 * Navigates to settings via the sidebar footer dropdown menu.
 * Clicks the account button → "Settings" → waits for /settings.
 */
export async function navigateToSettings(page: Page): Promise<void> {
  await openMobileSidebarIfNeeded(page);
  await page.getByTestId(TEST_IDS.accountButton).click();
  await page.getByTestId(TEST_IDS.menuSettings).click();
  await page.waitForURL('/settings', { timeout: TIMEOUTS.ROUTE });
}

/**
 * Navigates to usage via the sidebar footer dropdown menu.
 * Clicks the account button → "Usage" → waits for /usage.
 */
export async function navigateToUsage(page: Page): Promise<void> {
  await openMobileSidebarIfNeeded(page);
  await page.getByTestId(TEST_IDS.accountButton).click();
  await page.getByTestId(TEST_IDS.menuUsage).click();
  await page.waitForURL('/usage', { timeout: TIMEOUTS.ROUTE });
}
