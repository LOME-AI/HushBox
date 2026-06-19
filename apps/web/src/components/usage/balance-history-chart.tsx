import * as React from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip } from 'recharts';
import { ChartTooltipContent } from '@hushbox/ui';
import { TEST_IDS, type BalanceHistoryResponse } from '@hushbox/shared';
import {
  UsageChartCard,
  DEFAULT_CHART_MARGIN,
  DEFAULT_AXIS_PROPS,
  formatDollarTick,
  formatDollarTooltip,
  formatPeriodLabel,
} from './chart-utilities';
import type { ChartConfig } from '@hushbox/ui';

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
      date: formatPeriodLabel(point.createdAt),
      balanceAfter: Number.parseFloat(point.balanceAfter),
    }));
  }, [data]);

  const dataTable = (
    <table>
      <caption>Account balance over time, in US dollars</caption>
      <thead>
        <tr>
          <th scope="col">Date</th>
          <th scope="col">Balance</th>
        </tr>
      </thead>
      <tbody>
        {chartData.map((row) => (
          <tr key={row.date}>
            <th scope="row">{row.date}</th>
            <td>{formatDollarTooltip(row.balanceAfter)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <UsageChartCard
      title="Balance History"
      testId={TEST_IDS.balanceHistoryChart}
      isLoading={isLoading}
      isEmpty={chartData.length === 0}
      emptyMessage="No balance history"
      chartConfig={chartConfig}
      ariaLabel={`Account balance across ${String(chartData.length)} point${chartData.length === 1 ? '' : 's'}.`}
      dataTable={dataTable}
    >
      <AreaChart data={chartData} margin={DEFAULT_CHART_MARGIN} accessibilityLayer>
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
