import { test, expect } from '@playwright/test';

test.describe('Web App Smoke Tests', () => {
  test('core pages load correctly', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL('/chat');

    await expect(page.getByRole('textbox', { name: 'Ask me anything...' })).toBeVisible();

    await page.goto('/projects');
    await expect(page.locator('body')).toContainText('Projects');
  });
});

test.describe('Persona Login', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('/dev/personas page loads with all persona cards', async ({ page }) => {
    await page.goto('/dev/personas');
    await expect(page.getByRole('heading', { name: /developer personas/i })).toBeVisible();

    await expect(page.getByTestId('persona-card-alice')).toBeVisible();
    await expect(page.getByTestId('persona-card-bob')).toBeVisible();
    await expect(page.getByTestId('persona-card-charlie')).toBeVisible();
  });
});
