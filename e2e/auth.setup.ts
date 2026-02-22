import { test as setup, expect } from '@playwright/test';
import { TEST_PERSONAS, TEST_2FA_TOTP_SECRET } from '../scripts/seed.js';
import { DEV_PASSWORD } from '../packages/shared/src/constants.js';
import { clearAuthRateLimits, generateTOTPCode } from './helpers/auth.js';
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const authDir = path.join(__dirname, '.auth');

// Filter to verified personas only (unverified cannot log in)
const verifiedPersonas = TEST_PERSONAS.filter((p) => p.emailVerified);

// Personas without 2FA can use the fast persona-card login
const standardPersonas = verifiedPersonas.filter((p) => !p.totpSecret);

// 2FA personas need login page + TOTP code
const twoFactorPersonas = verifiedPersonas.filter((p) => p.totpSecret);

// Ensure auth directory exists
setup.beforeAll(() => {
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }
});

// Standard personas: fast login via persona card
for (const persona of standardPersonas) {
  setup(`authenticate ${persona.name}`, async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto('/dev/personas?type=test');
    await page.locator(`[data-testid="persona-card-${persona.name}"]`).click();
    await page.waitForURL('/chat', { timeout: 30_000 });

    // Verify session persisted in Redis (catches silent SRH proxy failures)
    const verifyResponse = await page.request.get('/api/conversations');
    if (verifyResponse.status() === 401) {
      throw new Error(
        `Session verification failed for ${persona.name}: session not persisted in Redis`
      );
    }

    await context.storageState({ path: path.join(authDir, `${persona.name}.json`) });
    await context.close();
  });
}

// 2FA personas: login page with TOTP code
for (const persona of twoFactorPersonas) {
  setup(`authenticate ${persona.name}`, async ({ browser, request }) => {
    // Clear rate limits and used TOTP codes to handle retries
    await clearAuthRateLimits(request);

    const context = await browser.newContext();
    const page = await context.newPage();

    const email = `${persona.name}@test.hushbox.ai`;

    await page.goto('/login');
    await page.getByLabel('Email or Username').fill(email);
    await page.getByLabel('Password', { exact: true }).fill(DEV_PASSWORD);
    await page.getByLabel('Keep me signed in').check();
    await page.getByRole('button', { name: 'Log in' }).click();

    // Wait for 2FA modal
    const otpModal = page.getByTestId('two-factor-input-modal');
    await expect(otpModal).toBeVisible({ timeout: 30_000 });

    // Generate and enter TOTP code — OTP component auto-submits on completion
    const code = generateTOTPCode(TEST_2FA_TOTP_SECRET);
    await otpModal.getByTestId('otp-input').pressSequentially(code);

    await page.waitForURL('/chat', { timeout: 30_000 });

    // Verify session persisted in Redis (catches silent SRH proxy failures)
    const verifyResponse = await page.request.get('/api/conversations');
    if (verifyResponse.status() === 401) {
      throw new Error(
        `Session verification failed for ${persona.name}: session not persisted in Redis`
      );
    }

    await context.storageState({ path: path.join(authDir, `${persona.name}.json`) });
    await context.close();
  });
}
