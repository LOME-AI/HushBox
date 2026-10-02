import * as React from 'react';
import { Swatch } from '@hushbox/ui/marks';
import { TEST_IDS, type CostByModelResponse } from '@hushbox/shared';
import { formatNanoUsdAmount, UsageSection } from './chart-utilities';
import { useUsageModelLabels } from './use-usage-model-labels';
import type { ModelSwatch } from '@hushbox/shared/design-tokens';

interface CostByModelChartProps {
  data: CostByModelResponse | undefined;
  isLoading: boolean;
  isError?: boolean | undefined;
  onRetry?: (() => void) | undefined;
}

interface Bar {
  key: string;
  name: string;
  swatch: ModelSwatch;
  width: string;
  amount: string;
}

/** A bar's inline style: its fill width and the swatch its fill class reads. */
type BarFillStyle = React.CSSProperties & Record<'--bar-swatch', string>;

/**
 * A cost's share of the largest, as a CSS width rounded to a tenth of a percent.
 * Worked in bigint tenths so no nano-USD amount becomes a float.
 */
function shareOfLargest(cost: bigint, largest: bigint): string {
  if (largest <= 0n || cost <= 0n) return '0%';
  const tenths = (cost * 2000n + largest) / (largest * 2n);
  return `${String(Number(tenths) / 10)}%`;
}

function useBars(data: CostByModelResponse | undefined): Bar[] {
  const labels = useUsageModelLabels();

  return React.useMemo(() => {
    const rows = data?.data ?? [];
    let largest = 0n;
    const seen = new Set<string>();
    const billedTwice = new Set<string>();
    for (const row of rows) {
      const cost = BigInt(row.totalCost);
      if (cost > largest) largest = cost;
      if (seen.has(row.model)) billedTwice.add(row.model);
      seen.add(row.model);
    }

    return rows.map((row) => {
      const name = labels.name(row.model);
      return {
        key: `${row.model}\n${row.provider}`,
        // Two rows sharing a model id are told apart by their provider. The
        // cost-by-model read returns one row per model, so served data never has two.
        name: billedTwice.has(row.model) ? `${name} (${row.provider})` : name,
        swatch: labels.swatch(row.model),
        width: shareOfLargest(BigInt(row.totalCost), largest),
        amount: formatNanoUsdAmount(row.totalCost),
      };
    });
  }, [data, labels]);
}

function BarRow({ bar }: Readonly<{ bar: Bar }>): React.JSX.Element {
  const fillStyle: BarFillStyle = {
    width: bar.width,
    '--bar-swatch': `var(--model-${String(bar.swatch)})`,
  };

  return (
    <li className="col-span-full grid grid-cols-subgrid items-center gap-y-1.5">
      <span
        data-slot="bar-name"
        className="col-start-1 row-start-1 flex min-w-0 items-center gap-2"
      >
        <Swatch swatch={bar.swatch} />
        <span className="min-w-0 wrap-anywhere">{bar.name}</span>
      </span>
      <span
        aria-hidden="true"
        data-slot="bar-track"
        className="bg-meter-track col-span-full row-start-2 h-3 overflow-hidden rounded-xs @min-[24rem]:col-span-1 @min-[24rem]:col-start-2 @min-[24rem]:row-start-1"
      >
        <span
          data-slot="bar-fill"
          className="block h-full rounded-xs bg-(--bar-swatch)"
          style={fillStyle}
        />
      </span>
      <span
        data-slot="bar-amount"
        className="col-start-2 row-start-1 text-right font-mono tabular-nums @min-[24rem]:col-start-3"
      >
        {bar.amount}
      </span>
    </li>
  );
}

/** Each model's cost as a named bar, filled in proportion to the largest. */
export function CostByModelChart({
  data,
  isLoading,
  isError = false,
  onRetry,
}: Readonly<CostByModelChartProps>): React.JSX.Element {
  const bars = useBars(data);

  return (
    <UsageSection
      title="Cost by Model"
      testId={TEST_IDS.costByModelChart}
      isLoading={isLoading}
      isError={isError}
      onRetry={onRetry}
      isEmpty={bars.length === 0}
    >
      {/* The rows follow the block's own width: one line once it holds the 11rem name
          column, the widest amount and a readable bar, the bar under the name below that. */}
      <div className="@container">
        {/* eslint-disable-next-line jsx-a11y/no-redundant-roles -- WebKit's VoiceOver drops list semantics from a list with list-style none, and the app ships in WKWebView */}
        <ul
          role="list"
          className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-3.5 text-sm @min-[24rem]:grid-cols-[minmax(0,11rem)_minmax(0,1fr)_auto]"
        >
          {bars.map((bar) => (
            <BarRow key={bar.key} bar={bar} />
          ))}
        </ul>
      </div>
    </UsageSection>
  );
}
