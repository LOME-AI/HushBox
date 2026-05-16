import { test, expect } from './fixtures.js';
import { ACCESSIBILITY_PREFERENCES_DEFAULTS } from '@hushbox/shared';
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
  // Reset Alice's server-side prefs each run — accessibility-db-sync.spec.ts
  // and prior failed runs of this spec persist non-default state via LWW,
  // and the page rehydrates from the server (useAccessibilitySync) regardless
  // of localStorage. Without this reset the walkthrough starts from polluted
  // state and the cycle assertions are off by one.
  test.beforeEach(async ({ authenticatedRequest }) => {
    const response = await authenticatedRequest.put('/api/user-preferences/accessibility', {
      data: {
        preferences: ACCESSIBILITY_PREFERENCES_DEFAULTS,
        updatedAt: new Date().toISOString(),
      },
    });
    expect(response.ok()).toBe(true);
  });

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
      // The page title now lives in the shared PageHeader (a <span>, hidden
      // below md breakpoint), so we anchor on the first section heading
      // instead — it's always visible regardless of viewport size.
      await expect(page.getByRole('heading', { name: 'Quick starts', level: 2 })).toBeVisible();
      await expectNoA11yViolations(page, testInfo, {
        disableRules: [
          // Global rule sets h1-h6 to var(--color-brand-red) (#ec4755). On the
          // near-white --background (#faf9f6) every section heading falls to
          // ~3.56:1, below WCAG AA 4.5:1. Accepted brand tradeoff.
          'color-contrast',
          // Page title moved into the shared PageHeader as a <span> (hidden
          // below md viewport on iPhone) rather than an <h1>, so axe's
          // best-practice "every page should have one h1" rule fails. The
          // refactor was deliberate — the section h2s carry the structure.
          'page-has-heading-one',
        ],
      });
    });

    await walkAccessibilityToggles(page);

    await test.step('reload — settings persist on <html>', async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      // The page title now lives in the shared PageHeader (a <span>, hidden
      // below md breakpoint), so we anchor on the first section heading
      // instead — it's always visible regardless of viewport size.
      await expect(page.getByRole('heading', { name: 'Quick starts', level: 2 })).toBeVisible();
      await expectAllTogglesPersisted(page);
    });

    await test.step('axe-clean with all toggles applied', async () => {
      await expectNoA11yViolations(page, testInfo, {
        disableRules: [
          // Global rule sets h1-h6 to var(--color-brand-red) (#ec4755). On the
          // near-white --background (#faf9f6) every section heading falls to
          // ~3.56:1, below WCAG AA 4.5:1. Accepted brand tradeoff.
          'color-contrast',
          // Page title moved into the shared PageHeader as a <span> (hidden
          // below md viewport on iPhone) rather than an <h1>, so axe's
          // best-practice "every page should have one h1" rule fails. The
          // refactor was deliberate — the section h2s carry the structure.
          'page-has-heading-one',
        ],
      });
    });
  });
});
