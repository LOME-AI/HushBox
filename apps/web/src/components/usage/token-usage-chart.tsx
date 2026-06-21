import * as React from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend } from 'recharts';
import { ChartTooltipContent, ChartLegendContent } from '@hushbox/ui';
import { TEST_IDS, type TokenUsageOverTimeResponse } from '@hushbox/shared';
import {
  UsageChartCard,
  formatTokenCount,
  DEFAULT_CHART_MARGIN,
  DEFAULT_AXIS_PROPS,
  formatPeriodLabel,
} from './chart-utilities';
import type { ChartConfig } from '@hushbox/ui';

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
      period: formatPeriodLabel(point.period),
      inputTokens: point.inputTokens,
      outputTokens: point.outputTokens,
      cachedTokens: point.cachedTokens,
    }));
  }, [data]);

  const dataTable = (
    <table>
      <caption>Token usage by period</caption>
      <thead>
        <tr>
          <th scope="col">Period</th>
          <th scope="col">Input</th>
          <th scope="col">Output</th>
          <th scope="col">Cached</th>
        </tr>
      </thead>
      <tbody>
        {chartData.map((row) => (
          <tr key={row.period}>
            <th scope="row">{row.period}</th>
            <td>{formatTokenCount(row.inputTokens)}</td>
            <td>{formatTokenCount(row.outputTokens)}</td>
            <td>{formatTokenCount(row.cachedTokens)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <UsageChartCard
      title="Token Usage"
      testId={TEST_IDS.tokenUsageChart}
      isLoading={isLoading}
      isEmpty={chartData.length === 0}
      chartConfig={chartConfig}
      ariaLabel={`Input, output, and cached token counts across ${String(chartData.length)} period${chartData.length === 1 ? '' : 's'}.`}
      dataTable={dataTable}
    >
      <BarChart data={chartData} margin={DEFAULT_CHART_MARGIN} accessibilityLayer>
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
