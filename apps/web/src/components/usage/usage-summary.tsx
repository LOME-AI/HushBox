import * as React from 'react';
import { AsyncRegion } from '@hushbox/ui/surface';
import { Text } from '@hushbox/ui/type';
import { NANO_USD_PER_CENT, parseNanoUSD, TEST_IDS } from '@hushbox/shared';
import {
  nanoUsdToFourPlaceDollarString,
  nanoUsdToTwoPlaceDollarString,
} from '@hushbox/shared/affordability';
import { applyDollarSign } from '@/lib/billing/format';
import { formatTokenCount, UsageErrorState } from './chart-utilities';
import type { UsageSummaryResponse } from '@hushbox/shared';

interface UsageSummaryProps {
  data: UsageSummaryResponse | undefined;
  isLoading: boolean;
  isError?: boolean | undefined;
  onRetry?: (() => void) | undefined;
}

const LABEL = 'Summary';

/**
 * A usage figure for display, from its canonical nano-USD wire string. Settled
 * costs are routinely sub-cent, so an amount under a cent keeps four decimals
 * rather than collapsing to `$0.00`.
 */
function formatCost(wireNanoUsd: string): string {
  const nanoUsd = BigInt(parseNanoUSD(wireNanoUsd));
  if (nanoUsd === 0n) return '$0.00';
  const magnitude = nanoUsd < 0n ? -nanoUsd : nanoUsd;
  return applyDollarSign(
    magnitude < NANO_USD_PER_CENT
      ? nanoUsdToFourPlaceDollarString(nanoUsd)
      : nanoUsdToTwoPlaceDollarString(nanoUsd)
  );
}

function Fact({ figure, words }: Readonly<{ figure: string; words: string }>): React.JSX.Element {
  return (
    <span>
      <b className="text-foreground font-mono font-medium tabular-nums">{figure}</b> {words}
    </span>
  );
}

/** The period's total spend in large mono, over one line of facts about it. */
export function UsageSummary({
  data,
  isLoading,
  isError = false,
  onRetry,
}: Readonly<UsageSummaryProps>): React.JSX.Element {
  if (isError) {
    return (
      <section aria-label={LABEL} data-testid={TEST_IDS.usageSummary}>
        <UsageErrorState message="Couldn't load your usage totals" onRetry={onRetry} />
      </section>
    );
  }

  if (isLoading) {
    return (
      <section aria-label={LABEL} data-testid={TEST_IDS.usageSummary}>
        <AsyncRegion
          status="pending"
          label={LABEL}
          placeholder={[
            { kind: 'line', width: '15%' },
            { kind: 'block', height: 'sm' },
            { kind: 'line', width: '50%' },
          ]}
        >
          {null}
        </AsyncRegion>
      </section>
    );
  }

  return <SummaryFigures data={data} />;
}

function SummaryFigures({
  data,
}: Readonly<{ data: UsageSummaryResponse | undefined }>): React.JSX.Element {
  const messageCount = data?.messageCount ?? 0;
  const totalTokens = data
    ? data.totalInputTokens + data.totalOutputTokens + data.totalCachedTokens
    : 0;
  // The per-message average is divided in the billing unit itself: exact
  // integer nano-USD, so the figure reaching the formatter is a wire amount
  // like any other and no money value is coerced to a float on the way.
  const avgCostNanoUsd =
    data && messageCount > 0
      ? (BigInt(parseNanoUSD(data.totalSpent)) / BigInt(messageCount)).toString()
      : '0';

  return (
    <section aria-label={LABEL} data-testid={TEST_IDS.usageSummary} className="flex flex-col gap-1">
      <Text variant="caption">Total Spent</Text>
      <p
        data-testid={TEST_IDS.usageTotalSpent}
        className="font-mono text-4xl leading-[1.15] font-medium tracking-[-0.02em] tabular-nums"
      >
        {formatCost(data?.totalSpent ?? '0')}
      </p>
      <p className="text-muted-foreground flex flex-wrap gap-x-5 gap-y-1 text-sm">
        <Fact figure={String(messageCount)} words={messageCount === 1 ? 'message' : 'messages'} />
        <Fact figure={formatTokenCount(totalTokens)} words="tokens used" />
        <Fact figure={formatCost(avgCostNanoUsd)} words="per message" />
      </p>
    </section>
  );
}
