import * as React from 'react';
import { ResponsiveContainer } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle, ChartContainer } from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';
import type { ChartConfig } from '@hushbox/ui';

export const CHART_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
];

export function ChartSkeleton(): React.JSX.Element {
  return (
    <div className="flex h-[300px] items-center justify-center">
      <div
        className="bg-muted h-full w-full animate-pulse rounded"
        data-testid={TEST_IDS.skeletonBlock}
      />
    </div>
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

export const DEFAULT_AXIS_PROPS = {
  tick: { fontSize: 12 },
  tickLine: false,
  axisLine: false,
} as const;

export function formatDollarTick(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function formatDollarTooltip(value: number | string): string {
  return `$${Number(value).toFixed(4)}`;
}

interface UsageChartCardProps {
  title: string;
  testId: string;
  isLoading: boolean;
  isEmpty: boolean;
  emptyMessage?: string;
  chartConfig: ChartConfig;
  // One-sentence summary read by screen readers as the chart region's accessible name.
  ariaLabel?: string;
  // Visually-hidden text alternative (typically a <table>) so chart data is perceivable to AT.
  dataTable?: React.ReactNode;
  children: React.ReactNode;
}

export function UsageChartCard({
  title,
  testId,
  isLoading,
  isEmpty,
  emptyMessage = 'No usage data for this period',
  chartConfig,
  ariaLabel,
  dataTable,
  children,
}: Readonly<UsageChartCardProps>): React.JSX.Element {
  const titleId = React.useId();
  const summaryId = React.useId();
  // aria-labelledby overrides aria-label, so the chart's accessible name is built
  // by referencing the visible title plus a visually-hidden summary in order.
  const labelledBy = ariaLabel ? `${titleId} ${summaryId}` : titleId;
  return (
    <Card data-testid={testId}>
      <CardHeader className="pb-2">
        <CardTitle id={titleId} className="text-sm font-medium">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && <ChartSkeleton />}
        {!isLoading && isEmpty && (
          <div className="text-muted-foreground flex h-[300px] items-center justify-center text-sm">
            {emptyMessage}
          </div>
        )}
        {!isLoading && !isEmpty && (
          <>
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
          </>
        )}
      </CardContent>
    </Card>
  );
}
