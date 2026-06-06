import { type Locator, type Page } from '@playwright/test';
import { TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import { expect } from '../helpers/expect.js';

export class UsagePage {
  readonly page: Page;
  readonly usageContent: Locator;
  readonly filters: Locator;
  readonly dateRangeButtons: Locator;
  readonly modelFilter: Locator;
  readonly kpiCards: Locator;
  readonly kpiTotalSpent: Locator;
  readonly kpiTotalSpentValue: Locator;
  readonly kpiMessages: Locator;
  readonly kpiMessagesValue: Locator;
  readonly kpiTokens: Locator;
  readonly kpiAvgCost: Locator;
  readonly spendingChart: Locator;
  readonly costByModelChart: Locator;
  readonly tokenUsageChart: Locator;
  readonly conversationChart: Locator;
  readonly balanceHistoryChart: Locator;

  constructor(page: Page) {
    this.page = page;
    this.usageContent = page.getByTestId(TEST_IDS.usageContent);
    this.filters = page.getByTestId(TEST_IDS.usageFilters);
    this.dateRangeButtons = page.getByTestId(TEST_IDS.dateRangeButtons);
    this.modelFilter = page.getByTestId(TEST_IDS.modelFilter);
    this.kpiCards = page.getByTestId(TEST_IDS.usageKpiCards);
    this.kpiTotalSpent = page.getByTestId(TEST_IDS.kpiTotalSpent);
    this.kpiTotalSpentValue = page.getByTestId(TEST_ID_BUILDERS.kpiValue(TEST_IDS.kpiTotalSpent));
    this.kpiMessages = page.getByTestId(TEST_IDS.kpiMessages);
    this.kpiMessagesValue = page.getByTestId(TEST_ID_BUILDERS.kpiValue(TEST_IDS.kpiMessages));
    this.kpiTokens = page.getByTestId(TEST_IDS.kpiTokens);
    this.kpiAvgCost = page.getByTestId(TEST_IDS.kpiAvgCost);
    this.spendingChart = page.getByTestId(TEST_IDS.spendingOverTimeChart);
    this.costByModelChart = page.getByTestId(TEST_IDS.costByModelChart);
    this.tokenUsageChart = page.getByTestId(TEST_IDS.tokenUsageChart);
    this.conversationChart = page.getByTestId(TEST_IDS.spendingByConversationChart);
    this.balanceHistoryChart = page.getByTestId(TEST_IDS.balanceHistoryChart);
  }

  async goto(): Promise<void> {
    await this.page.goto('/usage', { waitUntil: 'domcontentloaded' });
    await expect(this.usageContent).toBeVisible();
  }

  async selectDateRange(range: '7d' | '30d' | '90d' | 'all'): Promise<void> {
    await this.page.getByTestId(TEST_ID_BUILDERS.range(range)).click();
  }

  async selectModel(model: string): Promise<void> {
    await this.modelFilter.click();
    await this.page.getByRole('option', { name: model }).click();
  }

  async clearModelFilter(): Promise<void> {
    await this.modelFilter.click();
    await this.page.getByRole('option', { name: 'All Models' }).click();
  }

  async expectAllChartsVisible(): Promise<void> {
    await expect(this.kpiCards).toBeVisible();
    await expect(this.spendingChart).toBeVisible();
    await expect(this.costByModelChart).toBeVisible();
    await expect(this.tokenUsageChart).toBeVisible();
    await expect(this.conversationChart).toBeVisible();
    await expect(this.balanceHistoryChart).toBeVisible();
  }

  async expectChartHasData(chart: Locator): Promise<void> {
    // Recharts renders SVG with class "recharts-surface" when data is present
    await expect(chart.locator('.recharts-surface')).toBeVisible();
  }

  async getKpiTotalSpentText(): Promise<string> {
    return (await this.kpiTotalSpent.textContent()) ?? '';
  }
}
