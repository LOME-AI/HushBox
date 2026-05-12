import AxeBuilder from '@axe-core/playwright';
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';

interface ExpectNoA11yViolationsOptions {
  /**
   * Axe rule IDs to skip for this run. Use sparingly — prefer fixing the
   * violation. Intended for known brand-driven exceptions (e.g. the marketing
   * site's `color-contrast` on `--brand-red`, which is a documented design
   * tradeoff rather than an accidental bug).
   */
  readonly disableRules?: readonly string[];
}

/**
 * Run axe-core analysis on the page and assert zero violations.
 *
 * If `testInfo` is provided, any violations are attached as a JSON file to the
 * test result so the failure report is actionable. Pass `testInfo` for any new
 * spec — it costs nothing on success and saves diagnostic time on failure.
 *
 * @param page - The Playwright Page to analyse.
 * @param testInfo - Optional Playwright TestInfo for attaching the violations
 *   payload to the failed test. Strongly recommended.
 * @param options - Optional rule-disable list for brand-driven exceptions.
 */
export async function expectNoA11yViolations(
  page: Page,
  testInfo?: TestInfo,
  options?: ExpectNoA11yViolationsOptions
): Promise<void> {
  let builder = new AxeBuilder({ page });
  const disable = options?.disableRules;
  if (disable !== undefined && disable.length > 0) {
    builder = builder.disableRules([...disable]);
  }
  const results = await builder.analyze();
  if (results.violations.length > 0 && testInfo) {
    await testInfo.attach('axe-violations', {
      body: JSON.stringify(results.violations, null, 2),
      contentType: 'application/json',
    });
  }
  expect(results.violations).toEqual([]);
}
