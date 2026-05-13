import { test, expect } from '../fixtures.js';
import { UsagePage } from '../pages';
import { navigateToUsage } from '../helpers/auth.js';

test.describe('Usage Analytics', () => {
  test('usage page renders charts and filters work', async ({ authenticatedPage }) => {
    const usagePage = new UsagePage(authenticatedPage);

    await test.step('navigate via sidebar menu', async () => {
      await authenticatedPage.goto('/chat', { waitUntil: 'domcontentloaded' });
      await navigateToUsage(authenticatedPage);
      await expect(usagePage.usageContent).toBeVisible();
    });

    await test.step('all charts render with data on All range', async () => {
      await usagePage.selectDateRange('all');
      await usagePage.expectAllChartsVisible();

      await usagePage.expectChartHasData(usagePage.spendingChart);
      await usagePage.expectChartHasData(usagePage.costByModelChart);
      await usagePage.expectChartHasData(usagePage.tokenUsageChart);
      await usagePage.expectChartHasData(usagePage.balanceHistoryChart);

      await expect(usagePage.kpiTotalSpentValue).not.toHaveText('$0.00');
      await expect(usagePage.kpiMessagesValue).not.toHaveText('0');
    });

    await test.step('date range filters update KPIs', async () => {
      const allTimeText = await usagePage.getKpiTotalSpentText();

      await usagePage.selectDateRange('7d');

      await expect(async () => {
        const sevenDayText = await usagePage.getKpiTotalSpentText();
        expect(sevenDayText).not.toBe(allTimeText);
      }).toPass({ timeout: 5000 });
    });

    await test.step('model filter narrows data', async () => {
      // Switch back to All time so we have data
      await usagePage.selectDateRange('all');
      await usagePage.expectChartHasData(usagePage.costByModelChart);

      await usagePage.selectModel('anthropic/claude-opus-4.6');

      await usagePage.expectChartHasData(usagePage.costByModelChart);

      await usagePage.clearModelFilter();
    });
  });
});
