import { test, expect } from '../fixtures.js';
import { UsagePage } from '../pages';

test.describe('Usage Analytics', () => {
  test('usage page renders charts and filters work', async ({ authenticatedPage }) => {
    const usagePage = new UsagePage(authenticatedPage);

    await test.step('navigate via sidebar menu', async () => {
      // Open sidebar footer dropdown
      await authenticatedPage.getByTestId('sidebar-dropdown-trigger').click();
      await authenticatedPage.getByTestId('menu-usage').click();
      await authenticatedPage.waitForURL('/usage');
      await expect(usagePage.usageContent).toBeVisible();
    });

    await test.step('all charts render with data on All range', async () => {
      await usagePage.selectDateRange('all');
      await usagePage.expectAllChartsVisible();

      // Verify each chart has rendered SVG data (not just empty containers)
      await usagePage.expectChartHasData(usagePage.spendingChart);
      await usagePage.expectChartHasData(usagePage.costByModelChart);
      await usagePage.expectChartHasData(usagePage.tokenUsageChart);
      await usagePage.expectChartHasData(usagePage.balanceHistoryChart);

      // KPI cards should show non-zero values
      await expect(usagePage.kpiTotalSpent).not.toContainText('$0.00');
      await expect(usagePage.kpiMessages).not.toContainText('0');
    });

    await test.step('date range filters update KPIs', async () => {
      // Record All-time total
      const allTimeText = await usagePage.getKpiTotalSpentText();

      // Switch to 7d — should show less than All
      await usagePage.selectDateRange('7d');

      // Wait for data to update (KPI text should change)
      await expect(async () => {
        const sevenDayText = await usagePage.getKpiTotalSpentText();
        expect(sevenDayText).not.toBe(allTimeText);
      }).toPass({ timeout: 5000 });
    });

    await test.step('model filter narrows data', async () => {
      // Switch back to All time so we have data
      await usagePage.selectDateRange('all');
      await usagePage.expectChartHasData(usagePage.costByModelChart);

      // Select a specific model
      await usagePage.selectModel('anthropic/claude-opus-4.6');

      // Cost by model chart should still render with filtered data
      await usagePage.expectChartHasData(usagePage.costByModelChart);

      // Clear the filter
      await usagePage.clearModelFilter();
    });
  });
});
