import * as React from 'react';
// eslint-disable-next-line sonarjs/deprecation -- recharts v3 still uses Cell for Pie coloring
import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from 'recharts';
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
import type { SpendingByConversationResponse } from '@hushbox/shared';
import { CHART_COLORS, ChartSkeleton } from './chart-utilities';

interface ConversationTitle {
  id: string;
  title: string;
}

interface SpendingByConversationChartProps {
  data: SpendingByConversationResponse | undefined;
  isLoading: boolean;
  conversationTitles?: ConversationTitle[];
}

function resolveConversationLabel(title: string | undefined, conversationId: string): string {
  if (!title || title === 'Decrypting...' || title === 'Encrypted conversation') {
    return `conv-${conversationId.slice(-6)}`;
  }
  return title.length > 24 ? `${title.slice(0, 24)}...` : title;
}

export function SpendingByConversationChart({
  data,
  isLoading,
  conversationTitles,
}: Readonly<SpendingByConversationChartProps>): React.JSX.Element {
  const { chartData, chartConfig } = React.useMemo(() => {
    if (!data?.data.length) return { chartData: [], chartConfig: {} as ChartConfig };

    const titleMap = new Map<string, string>();
    if (conversationTitles) {
      for (const c of conversationTitles) {
        titleMap.set(c.id, c.title);
      }
    }

    const config: ChartConfig = {};
    const rows = data.data.map((row, index) => {
      const title = titleMap.get(row.conversationId);
      const label = resolveConversationLabel(title, row.conversationId);
      config[label] = {
        label,
        color: CHART_COLORS[index % CHART_COLORS.length] ?? 'var(--chart-1)',
      };
      return {
        name: label,
        value: Number.parseFloat(row.totalSpent),
        conversationId: row.conversationId,
      };
    });

    return { chartData: rows, chartConfig: config };
  }, [data, conversationTitles]);

  return (
    <Card data-testid="spending-by-conversation-chart">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Top Conversations</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && <ChartSkeleton />}
        {!isLoading && chartData.length === 0 && (
          <div className="text-foreground-muted flex h-[300px] items-center justify-center text-sm">
            No conversation data
          </div>
        )}
        {!isLoading && chartData.length > 0 && (
          <ChartContainer config={chartConfig} className="h-[300px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={chartData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={100}
                  paddingAngle={2}
                  dataKey="value"
                >
                  {chartData.map((_, index) => (
                    // eslint-disable-next-line @typescript-eslint/no-deprecated, sonarjs/deprecation -- recharts v3 Cell API
                    <Cell
                      key={index}
                      fill={CHART_COLORS[index % CHART_COLORS.length] ?? 'var(--chart-1)'}
                    />
                  ))}
                </Pie>
                <Tooltip
                  content={
                    <ChartTooltipContent valueFormatter={(v) => `$${Number(v).toFixed(4)}`} />
                  }
                />
                <Legend content={<ChartLegendContent />} />
              </PieChart>
            </ResponsiveContainer>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
