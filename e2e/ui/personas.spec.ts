import { TEST_ID_BUILDERS } from '@hushbox/shared';
import { test } from '../fixtures.js';
import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';

import { expect } from '../helpers/expect.js';

const SPEC_MATRIX = matrix({ engine: 'engine-matrix', formFactor: 'either' });

test.describe('Persona Login', SPEC_MATRIX, () => {
  test('/dev/personas page loads with all persona cards', async ({ unauthenticatedPage: page }) => {
    await page.goto('/dev/personas', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: /developer personas/i })).toBeVisible();

    await expect(page.getByTestId(TEST_ID_BUILDERS.personaCard('alice'))).toBeVisible();
    await expect(page.getByTestId(TEST_ID_BUILDERS.personaCard('bob'))).toBeVisible();
    await expect(page.getByTestId(TEST_ID_BUILDERS.personaCard('charlie'))).toBeVisible();
  });
});
