import * as React from 'react';
import { TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';

import { COST_CATEGORY_COLORS } from './cost-category-colors';
import { costCategoryShares, type CostCategoryId, type CostItemId } from './cost-category-shares';

interface FeeBreakdownProps {
  /** The deposit amount in USD */
  depositAmount: number;
  /** Estimated characters used (for storage fee calculation) */
  estimatedCharacters?: number | undefined;
  /** The level of the "Where does my money go?" heading within its page. */
  headingLevel?: 2 | 3;
}

interface RowTestIds {
  readonly row: string;
  readonly pct: string;
}

const CATEGORY_TEST_IDS: Record<CostCategoryId, RowTestIds> = {
  serviceValue: { row: TEST_IDS.categoryServiceValue, pct: TEST_IDS.categoryServiceValuePct },
  transactionCosts: {
    row: TEST_IDS.categoryTransactionCosts,
    pct: TEST_IDS.categoryTransactionCostsPct,
  },
  platformFee: { row: TEST_IDS.categoryPlatformFee, pct: TEST_IDS.categoryPlatformFeePct },
};

function itemTestIds(id: CostItemId): RowTestIds {
  switch (id) {
    case 'model-usage': {
      return { row: TEST_IDS.itemModelUsage, pct: TEST_IDS.itemModelUsagePct };
    }
    case 'storage': {
      return { row: TEST_IDS.itemStorage, pct: TEST_IDS.itemStoragePct };
    }
    default: {
      return { row: TEST_ID_BUILDERS.feeItem(id), pct: TEST_ID_BUILDERS.feeItemPct(id) };
    }
  }
}

export function FeeBreakdown({
  depositAmount,
  estimatedCharacters,
  headingLevel = 3,
}: Readonly<FeeBreakdownProps>): React.JSX.Element {
  const { categories } = costCategoryShares(depositAmount, estimatedCharacters);
  const Heading = headingLevel === 2 ? 'h2' : 'h3';

  return (
    <div data-testid={TEST_IDS.feeBreakdown} className="flex min-w-0 flex-col gap-4 wrap-anywhere">
      <Heading className="text-title-2">Where does my money go?</Heading>
      <div className="flex flex-col gap-4">
        {categories.map((category) => {
          const testIds = CATEGORY_TEST_IDS[category.id];
          const colors = COST_CATEGORY_COLORS[category.id];
          return (
            <div key={category.id}>
              <div
                data-testid={testIds.row}
                className="border-border flex items-center justify-between gap-4 border-b pb-1 text-sm"
              >
                <span
                  className={`inline-flex items-center gap-2 font-semibold ${colors.colorClass}`}
                >
                  <span
                    aria-hidden="true"
                    className={`size-2.5 flex-none rounded-xs forced-color-adjust-none ${colors.swatchClass}`}
                  />
                  {category.name}
                </span>
                <span
                  data-testid={testIds.pct}
                  className="text-muted-foreground shrink-0 whitespace-nowrap tabular-nums"
                >
                  {category.approximateLabel}
                </span>
              </div>
              <div className="flex flex-col gap-1 pt-1.5 pl-4.5">
                {category.items.map((item) => {
                  const itemIds = itemTestIds(item.id);
                  return (
                    <div
                      key={item.id}
                      data-testid={itemIds.row}
                      className="text-muted-foreground flex justify-between gap-4 text-sm tabular-nums"
                    >
                      <span>{item.label}</span>
                      <span data-testid={itemIds.pct} className="shrink-0 whitespace-nowrap">
                        {item.percentage.toFixed(1)}%
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
