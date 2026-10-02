import { SECOND_MS, TEST_DAY_START } from '@hushbox/shared/test-instants';
import { matrix } from '../../../scripts/lib/playwright/browser-matrix.js';
import { test, expect } from '../fixtures.js';
import { utcDatetimeLocalFromNow } from './newsletter.js';

const SPEC_MATRIX = matrix({ engine: 'engine-fixed', formFactor: 'desktop' });

/** The near-future lead the newsletter spec schedules an issue with. */
const SCHEDULE_LEAD_MS = 45 * SECOND_MS;

/** A scheduled instant on each side of the input's minute normalization. */
const LANDINGS = [
  { name: 'on a whole minute', now: TEST_DAY_START - SCHEDULE_LEAD_MS },
  { name: 'between whole minutes', now: TEST_DAY_START - SCHEDULE_LEAD_MS + SECOND_MS },
] as const;

/**
 * Each test takes the built-in page and sets its own markup: no app is loaded,
 * so no request leaves the page for a guardrail to police.
 */
test.describe('utcDatetimeLocalFromNow', SPEC_MATRIX, () => {
  for (const landing of LANDINGS) {
    test(`an instant landing ${landing.name} round-trips through a datetime-local input`, async ({
      page,
    }) => {
      await page.setContent('<label>Scheduled at <input type="datetime-local"></label>');
      const input = page.getByLabel('Scheduled at');
      const value = utcDatetimeLocalFromNow(SCHEDULE_LEAD_MS, landing.now);

      await input.fill(value);

      await expect(input).toHaveValue(value);
      // Read as UTC, the way the compose panel reads the field.
      expect(Date.parse(`${value}Z`)).toBe(landing.now + SCHEDULE_LEAD_MS);
    });
  }
});
