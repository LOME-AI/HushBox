import * as React from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip } from 'recharts';
import { ChartTooltipContent } from '@hushbox/ui';
import { TEST_IDS, type CostByModelResponse } from '@hushbox/shared';
import {
  UsageChartCard,
  DEFAULT_CHART_MARGIN,
  DEFAULT_AXIS_PROPS,
  formatDollarTick,
  formatDollarTooltip,
} from './chart-utilities';
import type { ChartConfig } from '@hushbox/ui';

interface CostByModelChartProps {
  data: CostByModelResponse | undefined;
  isLoading: boolean;
}

const chartConfig: ChartConfig = {
  totalCost: {
    label: 'Cost',
    color: 'var(--chart-1)',
  },
};

export function CostByModelChart({
  data,
  isLoading,
}: Readonly<CostByModelChartProps>): React.JSX.Element {
  const chartData = React.useMemo(() => {
    if (!data?.data.length) return [];
    return data.data.map((row) => ({
      model: row.model,
      totalCost: Number.parseFloat(row.totalCost),
      messageCount: row.messageCount,
    }));
  }, [data]);

  return (
    <UsageChartCard
      title="Cost by Model"
      testId={TEST_IDS.costByModelChart}
      isLoading={isLoading}
      isEmpty={chartData.length === 0}
      chartConfig={chartConfig}
    >
      <BarChart data={chartData} layout="vertical" margin={DEFAULT_CHART_MARGIN}>
        <XAxis type="number" {...DEFAULT_AXIS_PROPS} tickFormatter={formatDollarTick} />
        <YAxis
          type="category"
          dataKey="model"
          {...DEFAULT_AXIS_PROPS}
          tick={{ fontSize: 11 }}
          width={120}
        />
        <Tooltip content={<ChartTooltipContent valueFormatter={formatDollarTooltip} />} />
        <Bar dataKey="totalCost" fill="var(--chart-1)" radius={[0, 4, 4, 0]} />
      </BarChart>
    </UsageChartCard>
  );
}
