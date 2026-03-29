import * as React from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ChartContainer,
  ChartTooltipContent,
  ChartLegendContent,
} from '@hushbox/ui';
import type { ChartConfig } from '@hushbox/ui';
import type { TokenUsageOverTimeResponse } from '@hushbox/shared';
import { ChartSkeleton, formatTokenCount } from './chart-utilities';

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
    <Card data-testid="token-usage-chart">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Token Usage</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && <ChartSkeleton />}
        {!isLoading && chartData.length === 0 && (
          <div className="text-foreground-muted flex h-[300px] items-center justify-center text-sm">
            No usage data for this period
          </div>
        )}
        {!isLoading && chartData.length > 0 && (
          <ChartContainer config={chartConfig} className="h-[300px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <XAxis dataKey="period" tick={{ fontSize: 12 }} tickLine={false} axisLine={false} />
                <YAxis
                  tick={{ fontSize: 12 }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={formatTokenCount}
                />
                <Tooltip
                  content={
                    <ChartTooltipContent valueFormatter={(v) => formatTokenCount(Number(v))} />
                  }
                />
                <Legend content={<ChartLegendContent />} />
                <Bar dataKey="inputTokens" fill="var(--chart-2)" radius={[4, 4, 0, 0]} />
                <Bar dataKey="outputTokens" fill="var(--chart-3)" radius={[4, 4, 0, 0]} />
                <Bar dataKey="cachedTokens" fill="var(--chart-4)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
