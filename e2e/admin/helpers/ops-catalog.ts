import { TEST_IDS } from '@hushbox/shared';
import { TIMEOUTS } from '../../config/timeouts.js';
import { expect } from '../fixtures.js';
import type { Locator, Page } from '@playwright/test';

/**
 * The ops-catalog screen: the operator's generic door to every registered
 * operation. A newly registered op reaches this table with no UI work, so it
 * is the surface that decides whether an op is reachable at all. Raw
 * selectors are confined here (rule 3.3).
 */

/** Navigate to the catalog and wait for the table to render. */
export async function openOpsCatalog(page: Page): Promise<void> {
  await page.goto('/ops');
  await expect(page.getByTestId(TEST_IDS.adminOpsTable)).toBeVisible({ timeout: TIMEOUTS.ROUTE });
}

/**
 * The catalog row whose FIRST cell is exactly `opName`. Scoped to that cell
 * rather than the row's text because the Inverse column carries op names too:
 * a whole-row text filter matches a mutual pair's other half as well.
 */
function opCatalogRow(page: Page, opName: string): Locator {
  return page
    .getByTestId(TEST_IDS.adminOpsTable)
    .locator('tbody tr')
    .filter({ has: page.locator(`td:nth-child(1):text-is("${opName}")`) });
}

/** The Inverse cell of one catalog row — the registered inverse as the operator sees it. */
export function catalogInverseCell(page: Page, opName: string): Locator {
  return opCatalogRow(page, opName).locator('td:nth-child(5)');
}

/** Open one op's form through its row's Run button (the catalog must be open). */
export async function runOpFromCatalog(page: Page, opName: string): Promise<void> {
  const row = opCatalogRow(page, opName);
  await expect(row).toHaveCount(1);
  await row.getByTestId(TEST_IDS.adminOpsRun).click();
  await expect(page.getByTestId(TEST_IDS.adminOpModal)).toBeVisible({ timeout: TIMEOUTS.MODAL });
}
