import * as React from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip } from 'recharts';
import { ChartTooltipContent } from '@hushbox/ui';
import type { ChartConfig } from '@hushbox/ui';
import type { BalanceHistoryResponse } from '@hushbox/shared';
import {
  UsageChartCard,
  DEFAULT_CHART_MARGIN,
  DEFAULT_AXIS_PROPS,
  formatDollarTick,
  formatDollarTooltip,
} from './chart-utilities';

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
    <UsageChartCard
      title="Balance History"
      testId="balance-history-chart"
      isLoading={isLoading}
      isEmpty={chartData.length === 0}
      emptyMessage="No balance history"
      chartConfig={chartConfig}
    >
      <AreaChart data={chartData} margin={DEFAULT_CHART_MARGIN}>
        <XAxis dataKey="date" {...DEFAULT_AXIS_PROPS} />
        <YAxis {...DEFAULT_AXIS_PROPS} tickFormatter={formatDollarTick} />
        <Tooltip content={<ChartTooltipContent valueFormatter={formatDollarTooltip} />} />
        <Area
          type="monotone"
          dataKey="balanceAfter"
          stroke="var(--chart-2)"
          fill="var(--chart-2)"
          fillOpacity={0.3}
        />
      </AreaChart>
    </UsageChartCard>
  );
}
