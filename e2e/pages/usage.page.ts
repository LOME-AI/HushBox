import { type Locator, type Page } from '@playwright/test';
import { expect, unsettledExpect } from '../helpers/settled-expect.js';

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
    this.usageContent = page.getByTestId('usage-content');
    this.filters = page.getByTestId('usage-filters');
    this.dateRangeButtons = page.getByTestId('date-range-buttons');
    this.modelFilter = page.getByTestId('model-filter');
    this.kpiCards = page.getByTestId('usage-kpi-cards');
    this.kpiTotalSpent = page.getByTestId('kpi-total-spent');
    this.kpiTotalSpentValue = page.getByTestId('kpi-total-spent-value');
    this.kpiMessages = page.getByTestId('kpi-messages');
    this.kpiMessagesValue = page.getByTestId('kpi-messages-value');
    this.kpiTokens = page.getByTestId('kpi-tokens');
    this.kpiAvgCost = page.getByTestId('kpi-avg-cost');
    this.spendingChart = page.getByTestId('spending-over-time-chart');
    this.costByModelChart = page.getByTestId('cost-by-model-chart');
    this.tokenUsageChart = page.getByTestId('token-usage-chart');
    this.conversationChart = page.getByTestId('spending-by-conversation-chart');
    this.balanceHistoryChart = page.getByTestId('balance-history-chart');
  }

  async goto(): Promise<void> {
    await this.page.goto('/usage');
    await expect(this.usageContent).toBeVisible();
  }

  async selectDateRange(range: '7d' | '30d' | '90d' | 'all'): Promise<void> {
    await this.page.getByTestId(`range-${range}`).click();
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
    await unsettledExpect(chart.locator('.recharts-surface')).toBeVisible();
  }

  async getKpiTotalSpentText(): Promise<string> {
    return (await this.kpiTotalSpent.textContent()) ?? '';
  }
}
