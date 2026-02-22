import type { Page, APIRequestContext } from '@playwright/test';
import { setTimeout as delay } from 'node:timers/promises';
import { generateTotpCodeSync } from '@hushbox/crypto';
import { TEST_EMAIL_DOMAIN } from '../../packages/shared/src/constants.js';

const API_BASE = 'http://localhost:8787';

/**
 * Fills the signup form and submits. Does NOT verify email.
 * After success, expects the "Check your email" confirmation.
 */
export async function signUpViaUI(
  page: Page,
  options: { username: string; email: string; password: string }
): Promise<void> {
  await page.goto('/signup');
  await page.getByLabel('Username').fill(options.username);
  await page.getByLabel('Email').fill(options.email);
  await page.getByLabel('Password', { exact: true }).fill(options.password);
  await page.getByLabel('Confirm password').fill(options.password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByText('Check your email').waitFor({ timeout: 30_000 });
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
  const response = await request.get(
    `${API_BASE}/api/dev/verify-token/${encodeURIComponent(email)}`
  );
  if (!response.ok()) {
    throw new Error(`Failed to get verify token for ${email}: ${String(response.status())}`);
  }
  const { token } = (await response.json()) as { token: string };
  await page.goto(`/verify?token=${token}`);
  return token;
}

/**
 * Fills the login form and submits. Waits for navigation to /chat.
 * Does NOT handle 2FA — use loginWithTOTP for 2FA users.
 */
export async function loginViaUI(
  page: Page,
  options: { email: string; password: string; keepSignedIn?: boolean }
): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email or Username').fill(options.email);
  await page.getByLabel('Password', { exact: true }).fill(options.password);

  if (options.keepSignedIn) {
    await page.getByLabel('Keep me signed in').check();
  }

  await page.getByRole('button', { name: 'Log in' }).click();
  await page.waitForURL('/chat', { timeout: 30_000 });
}

/**
 * Full signup + verify + login combo.
 */
export async function signUpAndVerify(
  page: Page,
  request: APIRequestContext,
  options: { username: string; email: string; password: string }
): Promise<void> {
  await signUpViaUI(page, options);
  await verifyEmailViaAPI(request, page, options.email);
  await loginViaUI(page, { email: options.email, password: options.password });
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
 * Clears all auth-related rate limits via dev endpoint.
 * Call this in beforeEach to prevent rate limit failures across test runs.
 */
export async function clearAuthRateLimits(request: APIRequestContext): Promise<void> {
  await request.delete(`${API_BASE}/api/dev/auth-rate-limits`);
}

/**
 * Waits for the TOTP code to rotate to a new value.
 * TOTP codes change every 30 seconds. This polls every 2s until a fresh code appears.
 * Use this between steps that verify different TOTP codes for the same user
 * to avoid the 90-second replay protection window.
 */
export async function waitForNextTOTPCode(secret: string, currentCode: string): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < 35_000) {
    const code = generateTOTPCode(secret);
    if (code !== currentCode) return code;
    await delay(2000);
  }
  throw new Error('Timed out waiting for next TOTP code');
}

/**
 * Logs out via the sidebar footer dropdown menu.
 * Clicks the sidebar trigger → "Log Out" → waits for /login.
 */
export async function logoutViaUI(page: Page): Promise<void> {
  await page.getByTestId('sidebar-trigger').click();
  await page.getByTestId('menu-logout').click();
  await page.waitForURL('/login', { timeout: 15_000 });
}

/**
 * Navigates to settings via the sidebar footer dropdown menu.
 * Clicks the sidebar trigger → "Settings" → waits for /settings.
 */
export async function navigateToSettings(page: Page): Promise<void> {
  await page.getByTestId('sidebar-trigger').click();
  await page.getByTestId('menu-settings').click();
  await page.waitForURL('/settings', { timeout: 15_000 });
}
