import * as React from 'react';
import { Card, CardContent, CardHeader, CardTitle, ChartContainer } from '@hushbox/ui';
import type { ChartConfig } from '@hushbox/ui';
import { ResponsiveContainer } from 'recharts';

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
      <div className="bg-muted h-full w-full animate-pulse rounded" data-testid="skeleton-block" />
    </div>
  );
}

export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;
  return String(value);
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
  children: React.ReactNode;
}

export function UsageChartCard({
  title,
  testId,
  isLoading,
  isEmpty,
  emptyMessage = 'No usage data for this period',
  chartConfig,
  children,
}: Readonly<UsageChartCardProps>): React.JSX.Element {
  return (
    <Card data-testid={testId}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && <ChartSkeleton />}
        {!isLoading && isEmpty && (
          <div className="text-foreground-muted flex h-[300px] items-center justify-center text-sm">
            {emptyMessage}
          </div>
        )}
        {!isLoading && !isEmpty && (
          <ChartContainer config={chartConfig} className="h-[300px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              {children}
            </ResponsiveContainer>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
