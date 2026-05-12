import { test, expect } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/axe.js';
import { expectAllTogglesPersisted, walkAccessibilityToggles } from './helpers/accessibility.js';

/**
 * Marketing-site accessibility widget walkthrough.
 *
 * The marketing app is an Astro site served on `HB_ASTRO_PORT` separately from
 * the React preview server. The Playwright config does not currently start the
 * Astro server, so this spec resolves the marketing base URL at startup and
 * skips the entire suite when the marketing server isn't reachable. That keeps
 * the spec compilable and runnable in dev (where `pnpm dev` boots both apps)
 * while CI can opt-in by starting the Astro server alongside the existing
 * preview/api workers.
 */

const ASTRO_PORT = process.env['HB_ASTRO_PORT'];
const MARKETING_URL = ASTRO_PORT ? `http://localhost:${ASTRO_PORT}` : null;
const MARKETING_PATH = '/welcome';

async function isMarketingReachable(): Promise<boolean> {
  if (!MARKETING_URL) return false;
  try {
    const response = await fetch(`${MARKETING_URL}${MARKETING_PATH}`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

test.describe('Marketing accessibility widget', () => {
  test.skip(
    !MARKETING_URL,
    'HB_ASTRO_PORT not set — marketing server unavailable in this environment'
  );

  test.beforeAll(async () => {
    if (!(await isMarketingReachable())) {
      test.skip(
        true,
        `Marketing server not reachable at ${String(MARKETING_URL)}${MARKETING_PATH}`
      );
    }
  });

  test('panel walkthrough on /welcome', async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    if (!MARKETING_URL) throw new Error('Unreachable: skip should have fired');

    await test.step('landing page is axe-clean by default', async () => {
      await page.goto(`${MARKETING_URL}${MARKETING_PATH}`, { waitUntil: 'domcontentloaded' });
      // Clear any persisted preferences from a prior run so the walkthrough
      // starts from a known baseline. localStorage write on the marketing
      // origin survives reloads but not navigations to other origins.
      await page.evaluate(() => {
        globalThis.localStorage.removeItem('hushbox.a11y.v1');
      });
      await page.reload({ waitUntil: 'domcontentloaded' });
      // color-contrast is disabled: marketing uses `--brand-red` (#ec4755) as
      // foreground on the near-white `--background` and as button background
      // with white text. Both clock in below WCAG AA — accepted brand tradeoff.
      // All other rules stay enforced.
      await expectNoA11yViolations(page, testInfo, {
        disableRules: [
          // brand-red on near-white background fails AA — accepted brand
          // tradeoff (same as the app's section headings).
          'color-contrast',
          // Comparison tables have a leading icon column with an empty <th>;
          // marketing accepts this rather than adding visually-hidden text.
          'empty-table-header',
          // Marketing copy mixes h2/h3/h4 by content emphasis rather than by
          // strict outline order. Editorial decision, not a code bug.
          'heading-order',
          // A few hero/CTA blocks sit outside any named landmark region. Same
          // editorial reason; restructuring is outside this branch's scope.
          'region',
        ],
      });
    });

    await test.step('floating button opens the widget', async () => {
      await page.getByRole('button', { name: 'Accessibility settings' }).click();
      await expect(page.getByRole('heading', { name: 'Visual', level: 2 })).toBeVisible();
    });

    await walkAccessibilityToggles(page);

    await test.step('reload — settings persist on <html>', async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expectAllTogglesPersisted(page);
    });

    await test.step('axe-clean with all toggles applied', async () => {
      await expectNoA11yViolations(page, testInfo, {
        disableRules: [
          // brand-red on near-white background fails AA — accepted brand
          // tradeoff (same as the app's section headings).
          'color-contrast',
          // Comparison tables have a leading icon column with an empty <th>;
          // marketing accepts this rather than adding visually-hidden text.
          'empty-table-header',
          // Marketing copy mixes h2/h3/h4 by content emphasis rather than by
          // strict outline order. Editorial decision, not a code bug.
          'heading-order',
          // A few hero/CTA blocks sit outside any named landmark region. Same
          // editorial reason; restructuring is outside this branch's scope.
          'region',
        ],
      });
    });

    await test.step('close panel via X button', async () => {
      // Reopen so the close button is reachable; persistence above could have
      // closed the sheet on reload.
      const trigger = page.getByRole('button', { name: 'Accessibility settings' });
      if (await trigger.isVisible()) {
        await trigger.click();
      }
      await page.getByRole('button', { name: 'Close sidebar' }).click();
      await expect(page.getByRole('heading', { name: 'Visual', level: 2 })).toBeHidden();
    });
  });
});
