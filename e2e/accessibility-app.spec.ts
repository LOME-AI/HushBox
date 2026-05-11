import { test, expect } from './fixtures.js';
import { expectNoA11yViolations } from './helpers/axe.js';
import { expectAllTogglesPersisted, walkAccessibilityToggles } from './helpers/accessibility.js';

/**
 * Authenticated in-app accessibility page walkthrough.
 *
 * Reuses the project-level `authenticatedPage` fixture (test-alice) so this
 * spec works on every device project. Walks through the same set of
 * representative toggles as the marketing spec (shared helper), then asserts
 * persistence after reload.
 */

test.describe('Authenticated /accessibility page', () => {
  test('walkthrough toggles persist and stay axe-clean', async ({
    authenticatedPage,
  }, testInfo) => {
    const page = authenticatedPage;
    test.setTimeout(60_000);

    await test.step('navigate to /accessibility — axe-clean by default', async () => {
      // Clear persisted preferences from previous runs so the walkthrough
      // starts from defaults. Doing it via a `?` route navigation first lets
      // localStorage clear succeed before the panel mounts and reads it.
      await page.goto('/chat', { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => {
        globalThis.localStorage.removeItem('hushbox.a11y.v1');
      });
      await page.goto('/accessibility', { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('heading', { name: 'Accessibility', level: 1 })).toBeVisible();
      await expectNoA11yViolations(page, testInfo);
    });

    await walkAccessibilityToggles(page);

    await test.step('reload — settings persist on <html>', async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('heading', { name: 'Accessibility', level: 1 })).toBeVisible();
      await expectAllTogglesPersisted(page);
    });

    await test.step('axe-clean with all toggles applied', async () => {
      await expectNoA11yViolations(page, testInfo);
    });
  });
});
