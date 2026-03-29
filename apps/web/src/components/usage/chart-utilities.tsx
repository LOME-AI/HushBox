import * as React from 'react';

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
