import { type Locator, type Page } from '@playwright/test';
import { TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import { expect } from '../helpers/expect.js';

export class UsagePage {
  readonly page: Page;
  readonly usageContent: Locator;
  readonly filters: Locator;
  readonly dateRangeButtons: Locator;
  readonly modelFilter: Locator;
  readonly summary: Locator;
  readonly totalSpent: Locator;
  readonly messagesFact: Locator;
  readonly spendingChart: Locator;
  readonly costByModelChart: Locator;
  readonly topConversations: Locator;
  readonly topConversationRows: Locator;

  constructor(page: Page) {
    this.page = page;
    this.usageContent = page.getByTestId(TEST_IDS.usageContent);
    this.filters = page.getByTestId(TEST_IDS.usageFilters);
    this.dateRangeButtons = page.getByTestId(TEST_IDS.dateRangeButtons);
    this.modelFilter = page.getByTestId(TEST_IDS.modelFilter);
    this.summary = page.getByTestId(TEST_IDS.usageSummary);
    this.totalSpent = page.getByTestId(TEST_IDS.usageTotalSpent);
    // The facts line's message count: the figure and its word, and nothing else.
    this.messagesFact = this.summary.getByText(/^\d+ messages?$/);
    this.spendingChart = page.getByTestId(TEST_IDS.spendingOverTimeChart);
    this.costByModelChart = page.getByTestId(TEST_IDS.costByModelChart);
    this.topConversations = page.getByTestId(TEST_IDS.topConversations);
    this.topConversationRows = this.topConversations.getByRole('listitem');
  }

  async goto(): Promise<void> {
    await this.page.goto('/usage', { waitUntil: 'domcontentloaded' });
    await expect(this.usageContent).toBeVisible();
  }

  async selectDateRange(range: '7d' | '30d' | '90d' | 'all'): Promise<void> {
    await this.page.getByTestId(TEST_ID_BUILDERS.range(range)).click();
  }

  /** Picks a model by its display name, whole: one name can be the start of another's. */
  async selectModel(model: string): Promise<void> {
    await this.modelFilter.click();
    await this.page.getByRole('option', { name: model, exact: true }).click();
  }

  async clearModelFilter(): Promise<void> {
    await this.modelFilter.click();
    await this.page.getByRole('option', { name: 'All Models' }).click();
  }

  async expectAllChartsVisible(): Promise<void> {
    await expect(this.summary).toBeVisible();
    await expect(this.spendingChart).toBeVisible();
    await expect(this.costByModelChart).toBeVisible();
    await expect(this.topConversations).toBeVisible();
  }

  /** A Cost by Model row whose name reads exactly `name`: the model's display name, or its id. */
  async expectCostByModelRow(name: string): Promise<void> {
    await expect(
      this.costByModelChart.getByRole('listitem').filter({
        has: this.page.getByText(name, { exact: true }),
      })
    ).toHaveCount(1);
  }

  async expectChartHasData(chart: Locator): Promise<void> {
    // Recharts renders SVG with class "recharts-surface" when data is present
    await expect(chart.locator('.recharts-surface')).toBeVisible();
  }

  /**
   * The summary's message count as the loaded summary renders it.
   *
   * Read off the facts line, which the summary renders only once its query has
   * resolved: the loading branch draws placeholder marks carrying no text, so a
   * figure compared against a read taken then would be comparing a loading
   * state. The count is an integer the line prints unformatted, so it survives
   * the round trip exactly — which a spend figure, rendered to the cent, does
   * not.
   */
  async readSummaryMessages(): Promise<number> {
    const rendered = (await this.messagesFact.textContent()) ?? '';
    const count = Number.parseInt(rendered, 10);
    if (!Number.isInteger(count)) {
      throw new TypeError(
        `readSummaryMessages: the summary's message count rendered "${rendered}"`
      );
    }
    return count;
  }
}
