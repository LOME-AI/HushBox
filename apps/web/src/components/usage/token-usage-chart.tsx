import * as React from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend } from 'recharts';
import { ChartTooltipContent, ChartLegendContent } from '@hushbox/ui';
import type { ChartConfig } from '@hushbox/ui';
import type { TokenUsageOverTimeResponse } from '@hushbox/shared';
import {
  UsageChartCard,
  formatTokenCount,
  DEFAULT_CHART_MARGIN,
  DEFAULT_AXIS_PROPS,
} from './chart-utilities';

interface TokenUsageChartProps {
  data: TokenUsageOverTimeResponse | undefined;
  isLoading: boolean;
}

const chartConfig: ChartConfig = {
  inputTokens: { label: 'Input', color: 'var(--chart-2)' },
  outputTokens: { label: 'Output', color: 'var(--chart-3)' },
  cachedTokens: { label: 'Cached', color: 'var(--chart-4)' },
};

export function TokenUsageChart({
  data,
  isLoading,
}: Readonly<TokenUsageChartProps>): React.JSX.Element {
  const chartData = React.useMemo(() => {
    if (!data?.data.length) return [];
    return data.data.map((point) => ({
      period: new Date(point.period).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      }),
      inputTokens: point.inputTokens,
      outputTokens: point.outputTokens,
      cachedTokens: point.cachedTokens,
    }));
  }, [data]);

  return (
    <UsageChartCard
      title="Token Usage"
      testId="token-usage-chart"
      isLoading={isLoading}
      isEmpty={chartData.length === 0}
      chartConfig={chartConfig}
    >
      <BarChart data={chartData} margin={DEFAULT_CHART_MARGIN}>
        <XAxis dataKey="period" {...DEFAULT_AXIS_PROPS} />
        <YAxis {...DEFAULT_AXIS_PROPS} tickFormatter={formatTokenCount} />
        <Tooltip
          content={<ChartTooltipContent valueFormatter={(v) => formatTokenCount(Number(v))} />}
        />
        <Legend content={<ChartLegendContent />} />
        <Bar dataKey="inputTokens" fill="var(--chart-2)" radius={[4, 4, 0, 0]} />
        <Bar dataKey="outputTokens" fill="var(--chart-3)" radius={[4, 4, 0, 0]} />
        <Bar dataKey="cachedTokens" fill="var(--chart-4)" radius={[4, 4, 0, 0]} />
      </BarChart>
    </UsageChartCard>
  );
}
