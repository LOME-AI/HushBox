import { test, expect } from '../fixtures.js';
import { ChatPage } from '../pages';

/**
 * The suite pins the
 * browser timezone and locale so date/number/collation behaviour is identical on
 * every machine. These are set in `playwright.config.ts` (`use.timezoneId` /
 * `use.locale`). This contract proves the pins actually reach the running page —
 * a misconfigured or overridden project would surface here rather than as a
 * locale-dependent flake somewhere deep in a date/number assertion.
 *
 * The expected values mirror `playwright.config.ts`; they are the contract.
 */
const EXPECTED_TIMEZONE = 'UTC';
const EXPECTED_LOCALE = 'en-US';

test.describe('Deterministic config contract', () => {
  test('the page runs in the configured UTC timezone and en-US locale', async ({
    authenticatedPage,
  }) => {
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.goto();
    await chatPage.waitForAppStable();

    const resolved = await authenticatedPage.evaluate(() => ({
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      locale: navigator.language,
    }));

    expect(resolved.timeZone).toBe(EXPECTED_TIMEZONE);
    expect(resolved.locale).toBe(EXPECTED_LOCALE);
  });
});
