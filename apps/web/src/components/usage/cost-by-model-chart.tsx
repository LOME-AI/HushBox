import * as React from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ChartContainer,
  ChartTooltipContent,
} from '@hushbox/ui';
import type { ChartConfig } from '@hushbox/ui';
import type { CostByModelResponse } from '@hushbox/shared';
import { ChartSkeleton } from './chart-utilities';

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
    <Card data-testid="cost-by-model-chart">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Cost by Model</CardTitle>
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
              <BarChart
                data={chartData}
                layout="vertical"
                margin={{ top: 4, right: 4, left: 0, bottom: 0 }}
              >
                <XAxis
                  type="number"
                  tick={{ fontSize: 12 }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v: number) => `$${v.toFixed(2)}`}
                />
                <YAxis
                  type="category"
                  dataKey="model"
                  tick={{ fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  width={120}
                />
                <Tooltip
                  content={
                    <ChartTooltipContent valueFormatter={(v) => `$${Number(v).toFixed(4)}`} />
                  }
                />
                <Bar dataKey="totalCost" fill="var(--chart-1)" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
