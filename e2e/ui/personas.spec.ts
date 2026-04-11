import { test } from '@playwright/test';
import { expect } from '../helpers/settled-expect.js';

test.describe('Persona Login', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('/dev/personas page loads with all persona cards', async ({ page }) => {
    await page.goto('/dev/personas', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: /developer personas/i })).toBeVisible();

    await expect(page.getByTestId('persona-card-alice')).toBeVisible();
    await expect(page.getByTestId('persona-card-bob')).toBeVisible();
    await expect(page.getByTestId('persona-card-charlie')).toBeVisible();
  });
});
