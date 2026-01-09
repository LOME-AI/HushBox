import * as React from 'react';
import {
  LOME_FEE_RATE,
  CREDIT_CARD_FEE_RATE,
  PROVIDER_FEE_RATE,
  STORAGE_COST_PER_CHARACTER,
} from '@lome-chat/shared';

interface FeeBreakdownProps {
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

interface FeeCategory {
  name: string;
  testId: string;
  pctTestId: string;
  totalPercentage: number;
  approximateLabel: string;
  colorClass: string;
  items: FeeItem[];
}

export function FeeBreakdown({
  depositAmount,
  estimatedCharacters = 1000000, // Default 1M characters
}: FeeBreakdownProps): React.JSX.Element {
  const lomeFee = depositAmount * LOME_FEE_RATE;
  const ccFee = depositAmount * CREDIT_CARD_FEE_RATE;
  const providerFee = depositAmount * PROVIDER_FEE_RATE;
  const storageFee = estimatedCharacters * STORAGE_COST_PER_CHARACTER;
  const modelUsage = depositAmount - lomeFee - ccFee - providerFee - storageFee;

  // Calculate percentages
  const modelUsagePct = (modelUsage / depositAmount) * 100;
  const storagePct = (storageFee / depositAmount) * 100;
  const serviceValuePct = modelUsagePct + storagePct;
  const transactionCostsPct = (CREDIT_CARD_FEE_RATE + PROVIDER_FEE_RATE) * 100;
  const platformFeePct = LOME_FEE_RATE * 100;

  const categories: FeeCategory[] = [
    {
      name: 'Service Value',
      testId: 'category-service-value',
      pctTestId: 'category-service-value-pct',
      totalPercentage: serviceValuePct,
      approximateLabel: '~85%',
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
    {
      name: 'Transaction Costs',
      testId: 'category-transaction-costs',
      pctTestId: 'category-transaction-costs-pct',
      totalPercentage: transactionCostsPct,
      approximateLabel: '~10%',
      colorClass: 'text-amber-500',
      items: [
        {
          label: 'Payment processing',
          percentage: CREDIT_CARD_FEE_RATE * 100,
          testId: 'item-payment-processing',
          pctTestId: 'item-payment-processing-pct',
        },
        {
          label: 'AI Provider fees',
          percentage: PROVIDER_FEE_RATE * 100,
          testId: 'item-provider-fees',
          pctTestId: 'item-provider-fees-pct',
        },
      ],
    },
    {
      name: 'Platform Fee',
      testId: 'category-platform-fee',
      pctTestId: 'category-platform-fee-pct',
      totalPercentage: platformFeePct,
      approximateLabel: '~5%',
      colorClass: 'text-[#ec4755]',
      items: [
        {
          label: 'LOME margin',
          percentage: LOME_FEE_RATE * 100,
          testId: 'item-lome-margin',
          pctTestId: 'item-lome-margin-pct',
        },
      ],
    },
  ];

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
