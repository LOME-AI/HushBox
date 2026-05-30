import * as React from 'react';
import {
  STORAGE_COST_PER_CHARACTER,
  FEE_BUCKET_BY_ID,
  FEE_CATEGORIES,
  roundPreservingSum,
  type FeeBucketId,
} from '@hushbox/shared';

export interface FeeBreakdownProps {
  /** The deposit amount in USD */
  depositAmount: number;
  /** Estimated characters used (for storage fee calculation) */
  estimatedCharacters?: number;
}

interface FeeItem {
  label: string;
  percentage: number;
  testId: string;
  pctTestId: string;
}

interface FeeCategoryGroup {
  name: string;
  testId: string;
  pctTestId: string;
  approximateLabel: string;
  colorClass: string;
  items: FeeItem[];
}

function buildFeeItems(bucket: FeeBucketId): FeeItem[] {
  return FEE_CATEGORIES.filter((c) => FEE_BUCKET_BY_ID[c.id] === bucket).map((c) => ({
    label: c.label,
    percentage: c.rate * 100,
    testId: `item-fee-${c.id}`,
    pctTestId: `item-fee-${c.id}-pct`,
  }));
}

export function FeeBreakdown({
  depositAmount,
  estimatedCharacters = 1_000_000,
}: Readonly<FeeBreakdownProps>): React.JSX.Element {
  const totalFeesRate = FEE_CATEGORIES.reduce((sum, c) => sum + c.rate, 0);
  const totalFees = depositAmount * totalFeesRate;
  const storageFee = estimatedCharacters * STORAGE_COST_PER_CHARACTER;
  const modelUsage = depositAmount - totalFees - storageFee;

  const modelUsagePct = (modelUsage / depositAmount) * 100;
  const storagePct = (storageFee / depositAmount) * 100;
  const serviceValuePct = modelUsagePct + storagePct;

  const transactionCostsItems = buildFeeItems('transaction-costs');
  const platformFeeItems = buildFeeItems('platform-fee');
  const transactionCostsPct = transactionCostsItems.reduce((sum, item) => sum + item.percentage, 0);
  const platformFeePct = platformFeeItems.reduce((sum, item) => sum + item.percentage, 0);

  // Largest-remainder rounding so the three top-level approximate labels add to 100%.
  const [serviceValueRounded, transactionCostsRounded, platformFeeRounded] = roundPreservingSum([
    serviceValuePct,
    transactionCostsPct,
    platformFeePct,
  ]);

  const categories: FeeCategoryGroup[] = [
    {
      name: 'Service Value',
      testId: 'category-service-value',
      pctTestId: 'category-service-value-pct',
      approximateLabel: `~${String(serviceValueRounded)}%`,
      colorClass: 'text-blue-500',
      items: [
        {
          label: 'Model usage',
          percentage: modelUsagePct,
          testId: 'item-model-usage',
          pctTestId: 'item-model-usage-pct',
        },
        {
          label: 'Storage',
          percentage: storagePct,
          testId: 'item-storage',
          pctTestId: 'item-storage-pct',
        },
      ],
    },
  ];

  if (transactionCostsItems.length > 0) {
    categories.push({
      name: 'Transaction Costs',
      testId: 'category-transaction-costs',
      pctTestId: 'category-transaction-costs-pct',
      approximateLabel: `~${String(transactionCostsRounded)}%`,
      colorClass: 'text-amber-500',
      items: transactionCostsItems,
    });
  }

  if (platformFeeItems.length > 0) {
    categories.push({
      name: 'Platform Fee',
      testId: 'category-platform-fee',
      pctTestId: 'category-platform-fee-pct',
      approximateLabel: `~${String(platformFeeRounded)}%`,
      colorClass: 'text-[#ec4755]',
      items: platformFeeItems,
    });
  }

  return (
    <div data-testid="fee-breakdown" className="space-y-4">
      <h3 className="text-lg font-semibold">Where does my money go?</h3>
      <div className="space-y-4">
        {categories.map((category) => (
          <div key={category.testId} className="space-y-2">
            <div
              data-testid={category.testId}
              className="border-border flex items-center justify-between border-b pb-1"
            >
              <span className={`text-sm font-medium ${category.colorClass}`}>{category.name}</span>
              <span data-testid={category.pctTestId} className="text-muted-foreground text-sm">
                {category.approximateLabel}
              </span>
            </div>
            <div className="space-y-1 pl-3">
              {category.items.map((item) => (
                <div
                  key={item.testId}
                  data-testid={item.testId}
                  className="flex items-center justify-between"
                >
                  <span className="text-muted-foreground text-sm">{item.label}</span>
                  <span data-testid={item.pctTestId} className="text-muted-foreground text-sm">
                    {item.percentage.toFixed(1)}%
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
