import * as React from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from 'recharts';
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
import type { SpendingOverTimeResponse } from '@hushbox/shared';
import { CHART_COLORS, ChartSkeleton } from './chart-utilities';

interface SpendingOverTimeChartProps {
  data: SpendingOverTimeResponse | undefined;
  isLoading: boolean;
}

export function SpendingOverTimeChart({
  data,
  isLoading,
}: Readonly<SpendingOverTimeChartProps>): React.JSX.Element {
  const { chartData, models, chartConfig } = React.useMemo(() => {
    if (!data?.data.length)
      return { chartData: [], models: [] as string[], chartConfig: {} as ChartConfig };

    const modelsSet = new Set<string>();
    const periodMap = new Map<string, Record<string, number>>();

    for (const point of data.data) {
      modelsSet.add(point.model);
      const existing = periodMap.get(point.period) ?? {};
      existing[point.model] = Number.parseFloat(point.totalCost);
      periodMap.set(point.period, existing);
    }

    const modelsList = [...modelsSet];
    const config: ChartConfig = {
      total: { label: 'Total', color: 'var(--foreground)' },
    };
    for (const [index, model] of modelsList.entries()) {
      config[model] = {
        label: model,
        color: CHART_COLORS[index % CHART_COLORS.length] ?? 'var(--chart-1)',
      };
    }

    // Fill missing models with 0 so lines smoothly rise from / fall to zero
    const rows = [...periodMap.entries()]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([period, values]) => {
        const row: Record<string, number | string> = {
          period: new Date(period).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
          }),
        };
        let total = 0;
        for (const model of modelsList) {
          const val = values[model] ?? 0;
          row[model] = val;
          total += val;
        }
        row['total'] = total;
        return row;
      });

    return { chartData: rows, models: modelsList, chartConfig: config };
  }, [data]);

  return (
    <Card data-testid="spending-over-time-chart">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Spending Over Time</CardTitle>
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
              <AreaChart data={chartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <XAxis dataKey="period" tick={{ fontSize: 12 }} tickLine={false} axisLine={false} />
                <YAxis
                  tick={{ fontSize: 12 }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v: number) => `$${v.toFixed(2)}`}
                />
                <Tooltip
                  content={
                    <ChartTooltipContent
                      valueFormatter={(v) => `$${Number(v).toFixed(4)}`}
                      hideZeroValues
                    />
                  }
                />
                <Legend content={<ChartLegendContent />} />
                {models.map((model, index) => {
                  const color = CHART_COLORS[index % CHART_COLORS.length] ?? 'var(--chart-1)';
                  return (
                    <Area
                      key={model}
                      type="monotone"
                      dataKey={model}
                      stroke={color}
                      fill={color}
                      fillOpacity={0.4}
                      connectNulls={false}
                    />
                  );
                })}
                <Area
                  type="monotone"
                  dataKey="total"
                  stroke="var(--foreground)"
                  fill="none"
                  strokeWidth={2}
                  strokeDasharray="4 2"
                  dot={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
