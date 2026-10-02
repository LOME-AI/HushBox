import * as React from 'react';
import { ResponsiveContainer } from 'recharts';
import { ChartContainer } from '@hushbox/ui';
import { Button } from '@hushbox/ui/button';
import { CircleAlert } from '@hushbox/ui/icons';
import { Notice } from '@hushbox/ui/notice';
import { AsyncRegion } from '@hushbox/ui/surface';
import { Heading, Text } from '@hushbox/ui/type';
import { TEST_IDS } from '@hushbox/shared';
import { NANO_USD_PER_DOLLAR, nanoUsdToFourPlaceDollarString } from '@hushbox/shared/affordability';
import { applyDollarSign } from '@/lib/billing/format';
import type { ChartConfig } from '@hushbox/ui';

export const CHART_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
];

/**
 * The one error surface for the usage page. A failed query must never fall
 * through to the zero figures or the "no data" message: the whole point is that
 * a backend failure is distinguishable on screen from an idle account.
 */
export function UsageErrorState({
  message,
  onRetry,
}: Readonly<{ message: string; onRetry?: (() => void) | undefined }>): React.JSX.Element {
  return (
    <Notice
      tone="error"
      icon={CircleAlert}
      destructive
      emphasis="subtle"
      actions={
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      }
    >
      {message}
    </Notice>
  );
}

const DEFAULT_EMPTY_MESSAGE = 'No usage data for this period';

interface UsageSectionProps {
  title: string;
  testId: string;
  isLoading: boolean;
  isError: boolean;
  onRetry?: (() => void) | undefined;
  isEmpty: boolean;
  emptyMessage?: string | undefined;
  /** The heading's id, for a caller whose content names itself by the heading. */
  headingId?: string | undefined;
  children: React.ReactNode;
}

// The four states are exclusive and ordered: a failed query outranks the empty
// message, which is what makes an outage distinguishable from an idle account.
function UsageSectionBody({
  title,
  isLoading,
  isError,
  onRetry,
  isEmpty,
  emptyMessage,
  children,
}: Readonly<
  Omit<UsageSectionProps, 'testId' | 'headingId'> & { emptyMessage: string }
>): React.JSX.Element {
  if (isLoading) {
    return (
      <div data-testid={TEST_IDS.skeletonBlock}>
        <AsyncRegion status="pending" label={title} placeholder={[{ kind: 'block', height: 'lg' }]}>
          {null}
        </AsyncRegion>
      </div>
    );
  }
  if (isError) return <UsageErrorState message="Couldn't load this chart" onRetry={onRetry} />;
  if (isEmpty) {
    return (
      <div className="flex min-h-48 items-center justify-center">
        <Text variant="ui" tone="muted">
          {emptyMessage}
        </Text>
      </div>
    );
  }
  return <>{children}</>;
}

/** One block of the usage page: a heading over its content, placeholder, error or empty message. */
export function UsageSection({
  title,
  testId,
  isLoading,
  isError,
  onRetry,
  isEmpty,
  emptyMessage = DEFAULT_EMPTY_MESSAGE,
  headingId,
  children,
}: Readonly<UsageSectionProps>): React.JSX.Element {
  const ownHeadingId = React.useId();
  const titleId = headingId ?? ownHeadingId;

  return (
    <section aria-labelledby={titleId} data-testid={testId} className="flex min-w-0 flex-col gap-3">
      <Heading level={2} variant="title-2" id={titleId}>
        {title}
      </Heading>
      <UsageSectionBody
        title={title}
        isLoading={isLoading}
        isError={isError}
        onRetry={onRetry}
        isEmpty={isEmpty}
        emptyMessage={emptyMessage}
      >
        {children}
      </UsageSectionBody>
    </section>
  );
}

export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;
  return String(value);
}

// Formats a chart period/date string as a short "Mon D" axis label.
// Forces UTC so a date-only string ('YYYY-MM-DD'), which Date parses as UTC
// midnight, is not shifted to the previous day for users west of UTC.
export function formatPeriodLabel(value: string): string {
  return new Date(value).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export const DEFAULT_CHART_MARGIN = { top: 4, right: 4, left: 0, bottom: 0 } as const;

// rem, never px: the accessibility text-size control works by scaling the root
// font size, so a numeric pixel tick size is text the control cannot reach.
export const DEFAULT_AXIS_PROPS = {
  tick: { fontSize: '0.75rem' },
  tickLine: false,
  axisLine: false,
} as const;

export function formatDollarTick(value: number): string {
  return applyDollarSign(value.toFixed(2));
}

const NANO_DOLLAR_AMOUNT = /^(?<sign>-?)(?<whole>\d+)(?:\.(?<fraction>\d{1,9}))?$/;

/**
 * Nano-USD from a dollar amount the charts hold. A plotted number is read at
 * nine places, which puts a float sum back on the nano-USD grid it stands for;
 * a string finer than one nano-USD names no amount and is refused.
 */
function dollarAmountToNanoUsd(value: number | string): bigint {
  const text = typeof value === 'number' ? value.toFixed(9) : value;
  const groups = NANO_DOLLAR_AMOUNT.exec(text)?.groups;
  if (groups === undefined) throw new RangeError('Dollar amount is not a nano-USD amount');
  const { sign = '', whole = '0', fraction = '' } = groups;
  const magnitude = BigInt(whole) * NANO_USD_PER_DOLLAR + BigInt(fraction.padEnd(9, '0'));
  return sign === '-' ? -magnitude : magnitude;
}

/** A usage amount for display, from its canonical nano-USD wire string: `$X.XXXX`. */
export function formatNanoUsdAmount(wireNanoUsd: string): string {
  return applyDollarSign(nanoUsdToFourPlaceDollarString(wireNanoUsd));
}

/**
 * The same display for a plotted dollar value: recharts hands a tooltip's
 * `valueFormatter` the plotted number rather than the wire string it came from.
 */
export function formatDollarTooltip(value: number | string): string {
  return applyDollarSign(nanoUsdToFourPlaceDollarString(dollarAmountToNanoUsd(value)));
}

interface UsageChartCardProps {
  title: string;
  testId: string;
  isLoading: boolean;
  isEmpty: boolean;
  isError?: boolean | undefined;
  onRetry?: (() => void) | undefined;
  emptyMessage?: string;
  chartConfig: ChartConfig;
  // One-sentence summary read by screen readers as the chart region's accessible name.
  ariaLabel?: string;
  // Visually-hidden text alternative (typically a <table>) so chart data is perceivable to AT.
  dataTable?: React.ReactNode;
  // Drawn in the block's flow under the plot, so a long legend grows the block
  // instead of taking height from the plot or drawing over what follows.
  legend?: React.ReactNode;
  children: React.ReactNode;
}

export function UsageChartCard({
  title,
  testId,
  isLoading,
  isEmpty,
  isError = false,
  onRetry,
  emptyMessage,
  chartConfig,
  ariaLabel,
  dataTable,
  legend,
  children,
}: Readonly<UsageChartCardProps>): React.JSX.Element {
  const titleId = React.useId();
  const summaryId = React.useId();
  // aria-labelledby overrides aria-label, so the chart's accessible name is built
  // by referencing the visible title plus a visually-hidden summary in order.
  const labelledBy = ariaLabel ? `${titleId} ${summaryId}` : titleId;

  return (
    <UsageSection
      title={title}
      testId={testId}
      isLoading={isLoading}
      isError={isError}
      onRetry={onRetry}
      isEmpty={isEmpty}
      emptyMessage={emptyMessage}
      headingId={titleId}
    >
      {ariaLabel && (
        <span id={summaryId} className="sr-only">
          {ariaLabel}
        </span>
      )}
      {dataTable && <div className="sr-only">{dataTable}</div>}
      <ChartContainer
        config={chartConfig}
        className="h-[300px] w-full"
        role="img"
        aria-labelledby={labelledBy}
      >
        <ResponsiveContainer width="100%" height="100%">
          {children}
        </ResponsiveContainer>
      </ChartContainer>
      {legend}
    </UsageSection>
  );
}
