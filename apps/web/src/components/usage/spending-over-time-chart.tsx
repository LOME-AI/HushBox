import * as React from 'react';
import { ComposedChart, Area, Line, XAxis, YAxis, Tooltip } from 'recharts';
import { ChartTooltipContent, useReducedMotion } from '@hushbox/ui';
import { Swatch } from '@hushbox/ui/marks';
import {
  nanoUsdToFullDollarString,
  TEST_IDS,
  type SpendingOverTimeResponse,
} from '@hushbox/shared';
import {
  UsageChartCard,
  DEFAULT_CHART_MARGIN,
  DEFAULT_AXIS_PROPS,
  formatDollarTick,
  formatDollarTooltip,
  formatPeriodLabel,
} from './chart-utilities';
import { useUsageModelLabels } from './use-usage-model-labels';
import type { ChartConfig } from '@hushbox/ui';
import type { ModelSwatch } from '@hushbox/shared/design-tokens';

interface SpendingOverTimeChartProps {
  data: SpendingOverTimeResponse | undefined;
  isLoading: boolean;
  isError?: boolean | undefined;
  onRetry?: (() => void) | undefined;
}

interface Series {
  /** The row key the series is plotted from; a model id is no safe key or CSS name. */
  key: string;
  name: string;
  swatch: ModelSwatch;
}

const STACK_ID = 'spend';

// A class, not a fill prop: Recharts' own grey fill falls under text contrast on the dark
// page, and a token class follows the theme and the widget's contrast steps.
const AXIS_FIGURE_CLASS = 'fill-muted-foreground';

function swatchColour(swatch: ModelSwatch): string {
  return `var(--model-${String(swatch)})`;
}

/** The models in stack order: the largest spend over the range at the bottom. */
function modelsBySpend(points: SpendingOverTimeResponse['data']): string[] {
  const spend = new Map<string, bigint>();
  for (const point of points) {
    spend.set(point.model, (spend.get(point.model) ?? 0n) + BigInt(point.totalCost));
  }
  return [...spend.entries()]
    .toSorted(([modelA, spendA], [modelB, spendB]) => {
      if (spendA === spendB) return modelA.localeCompare(modelB);
      return spendA > spendB ? -1 : 1;
    })
    .map(([model]) => model);
}

function rootFontSize(): string {
  return getComputedStyle(document.documentElement).fontSize;
}

function subscribeToRootFontSize(onChange: () => void): () => void {
  // The accessibility widget sets the text size by a class on the root; the width band
  // moves it through a media query, which changes no attribute, hence the resize.
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true });
  globalThis.addEventListener('resize', onChange);
  return () => {
    observer.disconnect();
    globalThis.removeEventListener('resize', onChange);
  };
}

/**
 * The root's rendered font size. Recharts measures the axis dates once, when the axis
 * mounts, so text that grows under a chart of unchanged box would keep the old spacing
 * and draw the dates over each other; the axis is remounted on this value.
 */
function useRootFontSize(): string {
  return React.useSyncExternalStore(subscribeToRootFontSize, rootFontSize);
}

function SpendingLegend({ series }: Readonly<{ series: readonly Series[] }>): React.JSX.Element {
  return (
    <ul
      aria-label="Legend"
      className="text-muted-foreground mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs"
    >
      {series.map((entry) => (
        <li key={entry.key} className="inline-flex min-w-0 items-center gap-1.5">
          <Swatch swatch={entry.swatch} />
          <span className="min-w-0 wrap-anywhere">{entry.name}</span>
        </li>
      ))}
      <li className="inline-flex items-center gap-1.5">
        <span
          aria-hidden="true"
          data-slot="legend-dash"
          className="border-foreground w-4 shrink-0 border-t-2 border-dashed"
        />
        Total
      </li>
    </ul>
  );
}

export function SpendingOverTimeChart({
  data,
  isLoading,
  isError,
  onRetry,
}: Readonly<SpendingOverTimeChartProps>): React.JSX.Element {
  const labels = useUsageModelLabels();
  const isAnimationActive = !useReducedMotion();
  const textSize = useRootFontSize();

  const { chartData, series, chartConfig } = React.useMemo(() => {
    const points = data?.data ?? [];
    const models = modelsBySpend(points);
    const keyOf = new Map(models.map((model, index) => [model, `series-${String(index)}`]));
    const seriesList: Series[] = models.map((model, index) => ({
      key: `series-${String(index)}`,
      name: labels.name(model),
      swatch: labels.swatch(model),
    }));

    const config: ChartConfig = {
      total: { label: 'Total', color: 'var(--foreground)' },
    };
    for (const entry of seriesList) {
      config[entry.key] = { label: entry.name, color: swatchColour(entry.swatch) };
    }

    const periodMap = new Map<string, Record<string, number>>();
    for (const point of points) {
      const existing = periodMap.get(point.period) ?? {};
      // Costs arrive as integer nano-USD wire strings; the axis is dollars.
      // The nano→dollar math stays in the shared converter and the plotted
      // float is read off its output, never off the nano string.
      /* v8 ignore next -- every point's model is in the key map built from these points; the ?? only satisfies the Map's optional read */
      existing[keyOf.get(point.model) ?? point.model] = Number(
        nanoUsdToFullDollarString(point.totalCost)
      );
      periodMap.set(point.period, existing);
    }

    // A model absent from a period is 0 so its band closes to nothing. The total
    // is summed in stack order, so the dashed line lands on the stack's top edge.
    const rows = [...periodMap.entries()]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([period, values]) => {
        const row: Record<string, number | string> = {
          period: formatPeriodLabel(period),
        };
        let total = 0;
        for (const entry of seriesList) {
          const value = values[entry.key] ?? 0;
          row[entry.key] = value;
          total += value;
        }
        row['total'] = total;
        return row;
      });

    return { chartData: rows, series: seriesList, chartConfig: config };
  }, [data, labels]);

  const dataTable = (
    <table>
      <caption>Spending over time by model, in US dollars</caption>
      <thead>
        <tr>
          <th scope="col">Period</th>
          {series.map((entry) => (
            <th scope="col" key={entry.key}>
              {entry.name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {chartData.map((row) => (
          <tr key={String(row['period'])}>
            <th scope="row">{String(row['period'])}</th>
            {series.map((entry) => (
              <td key={entry.key}>{formatDollarTooltip(Number(row[entry.key]))}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <UsageChartCard
      title="Spending Over Time"
      testId={TEST_IDS.spendingOverTimeChart}
      isLoading={isLoading}
      isError={isError}
      onRetry={onRetry}
      isEmpty={chartData.length === 0}
      chartConfig={chartConfig}
      ariaLabel={`Spending over time across ${String(series.length)} model${series.length === 1 ? '' : 's'} over ${String(chartData.length)} period${chartData.length === 1 ? '' : 's'}.`}
      dataTable={dataTable}
      legend={<SpendingLegend series={series} />}
    >
      <ComposedChart data={chartData} margin={DEFAULT_CHART_MARGIN} accessibilityLayer>
        <XAxis
          key={textSize}
          dataKey="period"
          interval="preserveStartEnd"
          {...DEFAULT_AXIS_PROPS}
          tick={{ ...DEFAULT_AXIS_PROPS.tick, className: AXIS_FIGURE_CLASS }}
        />
        <YAxis
          {...DEFAULT_AXIS_PROPS}
          tick={{ ...DEFAULT_AXIS_PROPS.tick, className: `${AXIS_FIGURE_CLASS} font-mono` }}
          tickFormatter={formatDollarTick}
        />
        <Tooltip
          content={<ChartTooltipContent valueFormatter={formatDollarTooltip} hideZeroValues />}
        />
        {series.map((entry) => (
          <Area
            key={entry.key}
            type="monotone"
            dataKey={entry.key}
            stackId={STACK_ID}
            stroke={swatchColour(entry.swatch)}
            strokeWidth={1.5}
            fill={swatchColour(entry.swatch)}
            fillOpacity={0.5}
            connectNulls={false}
            isAnimationActive={isAnimationActive}
          />
        ))}
        <Line
          type="monotone"
          dataKey="total"
          stroke="var(--foreground)"
          strokeWidth={1.75}
          strokeDasharray="5 4"
          dot={false}
          isAnimationActive={isAnimationActive}
        />
      </ComposedChart>
    </UsageChartCard>
  );
}
