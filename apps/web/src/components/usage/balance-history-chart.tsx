import * as React from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ChartContainer,
  ChartTooltipContent,
} from '@hushbox/ui';
import type { ChartConfig } from '@hushbox/ui';
import type { BalanceHistoryResponse } from '@hushbox/shared';
import { ChartSkeleton } from './chart-utilities';

interface BalanceHistoryChartProps {
  data: BalanceHistoryResponse | undefined;
  isLoading: boolean;
}

const chartConfig: ChartConfig = {
  balanceAfter: {
    label: 'Balance',
    color: 'var(--chart-2)',
  },
};

export function BalanceHistoryChart({
  data,
  isLoading,
}: Readonly<BalanceHistoryChartProps>): React.JSX.Element {
  const chartData = React.useMemo(() => {
    if (!data?.data.length) return [];
    return data.data.map((point) => ({
      date: new Date(point.createdAt).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      }),
      balanceAfter: Number.parseFloat(point.balanceAfter),
    }));
  }, [data]);

  return (
    <Card data-testid="balance-history-chart">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Balance History</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && <ChartSkeleton />}
        {!isLoading && chartData.length === 0 && (
          <div className="text-foreground-muted flex h-[300px] items-center justify-center text-sm">
            No balance history
          </div>
        )}
        {!isLoading && chartData.length > 0 && (
          <ChartContainer config={chartConfig} className="h-[300px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <XAxis dataKey="date" tick={{ fontSize: 12 }} tickLine={false} axisLine={false} />
                <YAxis
                  tick={{ fontSize: 12 }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v: number) => `$${v.toFixed(2)}`}
                />
                <Tooltip
                  content={
                    <ChartTooltipContent valueFormatter={(v) => `$${Number(v).toFixed(4)}`} />
                  }
                />
                <Area
                  type="monotone"
                  dataKey="balanceAfter"
                  stroke="var(--chart-2)"
                  fill="var(--chart-2)"
                  fillOpacity={0.3}
                />
              </AreaChart>
            </ResponsiveContainer>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
