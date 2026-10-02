import { describe, it, expect } from 'vitest';
import { FEE_CATEGORIES } from '@hushbox/shared';
import {
  costCategoryShares,
  type CostCategoryShares,
  type CostItemId,
} from './cost-category-shares';

function roundedLabels(shares: CostCategoryShares): number[] {
  return shares.categories.map((category) => category.roundedPercentage);
}

function itemPercentages(shares: CostCategoryShares): Partial<Record<CostItemId, number>> {
  const percentages: Partial<Record<CostItemId, number>> = {};
  for (const item of shares.categories.flatMap((category) => category.items)) {
    percentages[item.id] = item.percentage;
  }
  return percentages;
}

describe('costCategoryShares', () => {
  it('names the three categories in list order', () => {
    expect(costCategoryShares(100).categories.map((category) => category.name)).toEqual([
      'Service Value',
      'Transaction Costs',
      'Platform Fee',
    ]);
  });

  it('rounds the three category labels to a sum of 100', () => {
    const labels = roundedLabels(costCategoryShares(100));
    expect(labels.reduce((sum, label) => sum + label, 0)).toBe(100);
  });

  it('writes each rounded label as an approximate percent', () => {
    for (const category of costCategoryShares(10).categories) {
      expect(category.approximateLabel).toBe(`~${String(category.roundedPercentage)}%`);
    }
  });

  it('exposes Service Value as the first category', () => {
    const shares = costCategoryShares(10);
    expect(shares.serviceValue).toBe(shares.categories[0]);
  });

  it('gives the category labels of a $10 deposit as the breakdown shows them today', () => {
    expect(roundedLabels(costCategoryShares(10))).toEqual([85, 10, 5]);
  });

  it('gives the category labels of a $100 deposit as the breakdown shows them today', () => {
    expect(roundedLabels(costCategoryShares(100))).toEqual([85, 10, 5]);
  });

  it('gives the item percentages of a $10 deposit as the breakdown shows them today', () => {
    const items = itemPercentages(costCategoryShares(10));
    expect(items['model-usage']).toBeCloseTo(82, 10);
    expect(items.storage).toBeCloseTo(3, 10);
    expect(items['card-processing']).toBeCloseTo(4.5, 10);
    expect(items.provider).toBeCloseTo(5.5, 10);
    expect(items.hushbox).toBeCloseTo(5, 10);
  });

  it('gives the item percentages of a $100 deposit as the breakdown shows them today', () => {
    const items = itemPercentages(costCategoryShares(100));
    expect(items['model-usage']).toBeCloseTo(84.7, 10);
    expect(items.storage).toBeCloseTo(0.3, 10);
  });

  it('prices storage for the characters it is given', () => {
    // 35,000 characters cost exactly $0.0105, 1.05% of a $1 deposit.
    expect(itemPercentages(costCategoryShares(1, 35_000)).storage).toBeCloseTo(1.05, 10);
  });

  it('keeps Service Value whole when storage alone exceeds the deposit', () => {
    const shares = costCategoryShares(1, 10_000_000);
    expect(shares.serviceValue.roundedPercentage).toBe(85);
  });

  it('lists one fee item per fee category with a rate, in its bucket', () => {
    const shares = costCategoryShares(100);
    const feeItemIds = shares.categories
      .filter((category) => category.id !== 'serviceValue')
      .flatMap((category) => category.items.map((item) => item.id));
    const byId = (a: string, b: string): number => a.localeCompare(b);
    expect(feeItemIds.toSorted(byId)).toEqual(FEE_CATEGORIES.map((c) => c.id).toSorted(byId));
  });

  it('capitalises the fee item labels', () => {
    const labels = costCategoryShares(100).categories.flatMap((category) =>
      category.items.map((item) => item.label)
    );
    expect(labels).toContain('Credit card processing');
    expect(labels).toContain('AI provider overhead');
    expect(labels).toContain('HushBox margin');
  });

  it('adds each category share up from its items', () => {
    for (const category of costCategoryShares(10).categories) {
      const itemSum = category.items.reduce((sum, item) => sum + item.percentage, 0);
      expect(category.percentage).toBeCloseTo(itemSum, 10);
    }
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses a deposit of %s, which has no shares',
    (deposit) => {
      expect(() => costCategoryShares(deposit)).toThrow(RangeError);
    }
  );
});
