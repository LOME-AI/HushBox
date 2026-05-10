import AxeBuilder from '@axe-core/playwright';
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';

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
 */
export async function expectNoA11yViolations(page: Page, testInfo?: TestInfo): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  if (results.violations.length > 0 && testInfo) {
    await testInfo.attach('axe-violations', {
      body: JSON.stringify(results.violations, null, 2),
      contentType: 'application/json',
    });
  }
  expect(results.violations).toEqual([]);
}
