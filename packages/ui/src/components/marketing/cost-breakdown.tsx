import * as React from 'react';

import { CostPieChart } from './cost-pie-chart';
import { FeeBreakdown } from './fee-breakdown';

interface CostBreakdownProps {
  /** The deposit amount in USD */
  depositAmount: number;
  /** Estimated characters used (for storage fee calculation) */
  estimatedCharacters?: number;
  /** The level of the "Where does my money go?" heading within its page. */
  headingLevel: 2 | 3;
}

/** "Where does my money go?": the fee list beside the ring, stacked when narrow. */
export function CostBreakdown({
  depositAmount,
  estimatedCharacters,
  headingLevel,
}: Readonly<CostBreakdownProps>): React.JSX.Element {
  return (
    <div className="@container">
      <div className="@cost-split:grid-cols-2 grid items-center gap-x-10 gap-y-6">
        <FeeBreakdown
          depositAmount={depositAmount}
          estimatedCharacters={estimatedCharacters}
          headingLevel={headingLevel}
        />
        <CostPieChart depositAmount={depositAmount} estimatedCharacters={estimatedCharacters} />
      </div>
    </div>
  );
}
