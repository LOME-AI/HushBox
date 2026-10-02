import * as React from 'react';
import { act, render, renderHook, screen, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChartContainer } from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';
import { DAY_MS, OLD_RELEASE_SECONDS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { SpendingOverTimeChart } from './spending-over-time-chart';
import { formatPeriodLabel } from './chart-utilities';
import { UsageModelSet, useUsageModelLabels } from './use-usage-model-labels';
import type { ChartConfig } from '@hushbox/ui';
import type { Model, SpendingOverTimeResponse } from '@hushbox/shared';
import type { UseModelsStub } from '@/test-utils/models-hook-stub';

vi.mock('./chart-utilities', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chart-utilities')>();
  return { ...actual, formatPeriodLabel: vi.fn(actual.formatPeriodLabel) };
});

interface Captured {
  chart: Record<string, unknown>[];
  areas: Record<string, unknown>[];
  lines: Record<string, unknown>[];
  yAxes: Record<string, unknown>[];
  xAxes: Record<string, unknown>[];
  xAxisMounts: number[];
  tooltips: Record<string, unknown>[];
  configs: ChartConfig[];
}

const { captured, catalogRef, motionRef } = vi.hoisted(() => {
  const capturedProps: Captured = {
    chart: [],
    areas: [],
    lines: [],
    yAxes: [],
    xAxes: [],
    xAxisMounts: [],
    tooltips: [],
    configs: [],
  };
  const catalog: { current: Model[] | undefined } = { current: undefined };
  const motion = { reduced: false };
  return { captured: capturedProps, catalogRef: catalog, motionRef: motion };
});

vi.mock('@/hooks/models/models', () => ({
  useModels: (): UseModelsStub => ({
    data:
      catalogRef.current === undefined
        ? undefined
        : { models: catalogRef.current, premiumIds: new Set<string>() },
  }),
}));

// The chart container is kept as it is and its config recorded, so the tooltip's names can be
// read back through the container's own context.
vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  function RecordingChartContainer(
    props: React.ComponentProps<typeof actual.ChartContainer>
  ): React.JSX.Element {
    captured.configs.push(props.config);
    return <actual.ChartContainer {...props} />;
  }
  return {
    ...actual,
    ChartContainer: RecordingChartContainer,
    useReducedMotion: (): boolean => motionRef.reduced,
  };
});

// The test DOM lays nothing out, so the responsive wrapper hands the chart a fixed size, and
// each plotted part records the props it was drawn with before drawing as Recharts does.
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  function recording<P extends object>(
    Component: React.ComponentType<P>,
    into: Record<string, unknown>[]
  ): React.ComponentType<P> {
    function Recorded(props: P): React.JSX.Element {
      into.push(props as Record<string, unknown>);
      return <Component {...props} />;
    }
    return Recorded;
  }
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactElement }) =>
      React.cloneElement(children as React.ReactElement<{ width: number; height: number }>, {
        width: 800,
        height: 300,
      }),
    ComposedChart: recording(actual.ComposedChart, captured.chart),
    Area: recording(actual.Area, captured.areas),
    Line: recording(actual.Line, captured.lines),
    YAxis: recording(actual.YAxis, captured.yAxes),
    XAxis: function RecordedXAxis(
      props: React.ComponentProps<typeof actual.XAxis>
    ): React.JSX.Element {
      captured.xAxes.push(props as Record<string, unknown>);
      React.useEffect(() => {
        captured.xAxisMounts.push(1);
      }, []);
      return <actual.XAxis {...props} />;
    },
    Tooltip: recording(actual.Tooltip, captured.tooltips),
  };
});

function catalogModel(id: string, name: string): Model {
  return {
    id,
    name,
    provider: 'Fictional',
    description: 'Text generation model.',
    modality: 'text',
    supportedParameters: [],
    contextLength: 128_000,
    created: OLD_RELEASE_SECONDS,
    maxOutputTokens: 4096,
    pricing: { inputPerToken: '10000', outputPerToken: '30000' },
  };
}

function makeData(
  points: { period: string; model: string; totalCost: string; count: number }[]
): SpendingOverTimeResponse {
  return { data: points };
}

/** A period as the usage read sends it: the UTC calendar date alone. */
function periodAt(instantMs: number): string {
  return isoAt(instantMs).slice(0, 'YYYY-MM-DD'.length);
}

const DAY_ONE = periodAt(TEST_DAY_START);
const DAY_TWO = periodAt(TEST_DAY_START + DAY_MS);

const SMALL = 'fictional/small-2.5';
const LARGE = 'fictional/large-4.1';
const UNLISTED = 'fictional/unlisted';

// Money crosses the wire as canonical nano-USD integer strings
// (`serializeNanoUSD`), never as dollars: 1500000000 nano is $1.50. The small
// model arrives first so the stack order cannot be arrival order.
const SAMPLE_DATA = makeData([
  { period: DAY_ONE, model: SMALL, totalCost: '1500000000', count: 10 },
  { period: DAY_ONE, model: LARGE, totalCost: '2000000000', count: 5 },
  { period: DAY_TWO, model: SMALL, totalCost: '750000000', count: 3 },
  { period: DAY_TWO, model: LARGE, totalCost: '3000000000', count: 4 },
]);

const PAGE_MODELS = [SMALL, LARGE, UNLISTED];

function pageWrapper({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <UsageModelSet value={PAGE_MODELS}>{children}</UsageModelSet>;
}

function renderChart(
  props: Partial<React.ComponentProps<typeof SpendingOverTimeChart>> = {}
): ReturnType<typeof render> {
  return render(<SpendingOverTimeChart data={SAMPLE_DATA} isLoading={false} {...props} />, {
    wrapper: pageWrapper,
  });
}

/** The labels the page gives each model, read through the same hook the chart uses. */
function pageLabels(): ReturnType<typeof useUsageModelLabels> {
  return renderHook(() => useUsageModelLabels(), { wrapper: pageWrapper }).result.current;
}

function lastRender<T>(calls: T[]): T {
  const last = calls.at(-1);
  if (last === undefined) throw new Error('nothing was drawn');
  return last;
}

/** The model areas of the latest draw, in the order they were drawn. */
function drawnAreas(): Record<string, unknown>[] {
  const keys = new Set<unknown>();
  const areas: Record<string, unknown>[] = [];
  for (const props of captured.areas.toReversed()) {
    if (keys.has(props['dataKey'])) break;
    keys.add(props['dataKey']);
    areas.unshift(props);
  }
  return areas;
}

/**
 * Makes a change the chart observes and lets its observer deliver inside `act`: a mutation
 * observer reports on a microtask, after the change itself has returned.
 */
async function changeInAct(change: () => void): Promise<void> {
  await act(async () => {
    change();
    await Promise.resolve();
  });
}

/** The classes the latest draw of an axis gives its figures. */
function tickClasses(axes: Record<string, unknown>[]): string[] {
  const tick = lastRender(axes)['tick'];
  const className =
    typeof tick === 'object' && tick !== null && 'className' in tick ? tick.className : '';
  return String(className).split(' ');
}

function legend(): HTMLElement {
  return screen.getByRole('list', { name: 'Legend' });
}

beforeEach(() => {
  for (const calls of Object.values(captured)) (calls as unknown[]).length = 0;
  catalogRef.current = [
    catalogModel(SMALL, 'Small Model 2.5'),
    catalogModel(LARGE, 'Large Model 4.1'),
  ];
  motionRef.reduced = false;
});

describe('SpendingOverTimeChart', () => {
  describe('loading state', () => {
    it('renders skeleton when loading', () => {
      render(<SpendingOverTimeChart data={undefined} isLoading={true} />);
      expect(screen.getByTestId(TEST_IDS.skeletonBlock)).toBeInTheDocument();
    });

    it('does not render empty message when loading', () => {
      render(<SpendingOverTimeChart data={undefined} isLoading={true} />);
      expect(screen.queryByText('No usage data for this period')).not.toBeInTheDocument();
    });
  });

  describe('empty state', () => {
    it('renders empty message when data is undefined', () => {
      render(<SpendingOverTimeChart data={undefined} isLoading={false} />);
      expect(screen.getByText('No usage data for this period')).toBeInTheDocument();
    });

    it('renders empty message when data array is empty', () => {
      render(<SpendingOverTimeChart data={makeData([])} isLoading={false} />);
      expect(screen.getByText('No usage data for this period')).toBeInTheDocument();
    });

    it('does not render skeleton when not loading', () => {
      render(<SpendingOverTimeChart data={undefined} isLoading={false} />);
      expect(screen.queryByTestId(TEST_IDS.skeletonBlock)).not.toBeInTheDocument();
    });
  });

  describe('error state', () => {
    it('replaces the empty message with a retryable error', () => {
      render(
        <SpendingOverTimeChart
          data={undefined}
          isLoading={false}
          isError={true}
          onRetry={vi.fn()}
        />
      );

      expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load this chart");
      expect(screen.queryByText('No usage data for this period')).not.toBeInTheDocument();
    });
  });

  describe('chart rendering', () => {
    it('renders chart card with correct testid', () => {
      render(<SpendingOverTimeChart data={SAMPLE_DATA} isLoading={false} />);
      expect(screen.getByTestId(TEST_IDS.spendingOverTimeChart)).toBeInTheDocument();
    });

    it('renders title', () => {
      render(<SpendingOverTimeChart data={SAMPLE_DATA} isLoading={false} />);
      expect(screen.getByText('Spending Over Time')).toBeInTheDocument();
    });

    it('does not render empty message when data exists', () => {
      render(<SpendingOverTimeChart data={SAMPLE_DATA} isLoading={false} />);
      expect(screen.queryByText('No usage data for this period')).not.toBeInTheDocument();
    });

    it('does not render skeleton when data is loaded', () => {
      render(<SpendingOverTimeChart data={SAMPLE_DATA} isLoading={false} />);
      expect(screen.queryByTestId(TEST_IDS.skeletonBlock)).not.toBeInTheDocument();
    });
  });

  describe('data transformation', () => {
    it('sorts periods chronologically', () => {
      const reversed = makeData([
        { period: '2025-01-02', model: 'GPT-4', totalCost: '750000000', count: 3 },
        { period: '2025-01-01', model: 'GPT-4', totalCost: '1500000000', count: 10 },
      ]);
      const { container } = render(<SpendingOverTimeChart data={reversed} isLoading={false} />);
      expect(container.querySelector('[data-chart]')).toBeInTheDocument();
    });

    it('handles single data point', () => {
      const single = makeData([
        { period: '2025-01-01', model: 'GPT-4', totalCost: '1500000000', count: 10 },
      ]);
      render(<SpendingOverTimeChart data={single} isLoading={false} />);
      expect(screen.getByTestId(TEST_IDS.spendingOverTimeChart)).toBeInTheDocument();
    });

    it('formats period labels via the shared UTC-aware formatter', () => {
      render(<SpendingOverTimeChart data={SAMPLE_DATA} isLoading={false} />);
      expect(formatPeriodLabel).toHaveBeenCalledWith(DAY_ONE);
      expect(formatPeriodLabel).toHaveBeenCalledWith(DAY_TWO);
    });

    it('handles multiple models across periods', () => {
      const multi = makeData([
        { period: '2025-01-01', model: 'GPT-4', totalCost: '1000000000', count: 1 },
        { period: '2025-01-01', model: 'Claude', totalCost: '2000000000', count: 2 },
        { period: '2025-01-01', model: 'Gemini', totalCost: '3000000000', count: 3 },
      ]);
      render(<SpendingOverTimeChart data={multi} isLoading={false} />);
      expect(screen.getByTestId(TEST_IDS.spendingOverTimeChart)).toBeInTheDocument();
    });

    it('fills zero for a model absent from a period', () => {
      // GPT-4 only appears in the first period and Claude only in the second, so
      // each period is missing one model, exercising the `values[model] ?? 0` fill.
      const disjoint = makeData([
        { period: '2025-01-01', model: 'GPT-4', totalCost: '1000000000', count: 1 },
        { period: '2025-01-02', model: 'Claude', totalCost: '2000000000', count: 2 },
      ]);
      render(<SpendingOverTimeChart data={disjoint} isLoading={false} />);
      expect(screen.getByTestId(TEST_IDS.spendingOverTimeChart)).toBeInTheDocument();
    });
  });

  describe('accessibility', () => {
    it('exposes the chart as an image region with an accessible name', () => {
      render(<SpendingOverTimeChart data={SAMPLE_DATA} isLoading={false} />);
      expect(screen.getByRole('img', { name: /Spending Over Time/i })).toBeInTheDocument();
    });

    it('renders a data-table alternative listing each period and model cost', () => {
      render(<SpendingOverTimeChart data={SAMPLE_DATA} isLoading={false} />);
      const table = screen.getByRole('table', { hidden: true });
      expect(table.closest('.sr-only')).not.toBeNull();
      const headers = screen
        .getAllByRole('columnheader', { hidden: true })
        .map((h) => h.textContent);
      expect(headers).toContain('Large Model 4.1');
      expect(headers).toContain('Small Model 2.5');
      expect(screen.getByRole('cell', { name: '$1.5000', hidden: true })).toBeInTheDocument();
    });

    it('renders every nano-USD cost as its dollar value', () => {
      render(<SpendingOverTimeChart data={SAMPLE_DATA} isLoading={false} />);
      expect(screen.getByRole('cell', { name: '$1.5000', hidden: true })).toBeInTheDocument();
      expect(screen.getByRole('cell', { name: '$2.0000', hidden: true })).toBeInTheDocument();
      expect(screen.getByRole('cell', { name: '$0.7500', hidden: true })).toBeInTheDocument();
    });

    it('keeps a sub-cent cost rather than collapsing it to zero', () => {
      render(
        <SpendingOverTimeChart
          data={makeData([
            { period: '2025-01-01', model: 'GPT-4', totalCost: '1360000', count: 1 },
          ])}
          isLoading={false}
        />
      );

      expect(screen.getByRole('cell', { name: '$0.0014', hidden: true })).toBeInTheDocument();
    });

    it('enables the recharts accessibility layer for keyboard reachability', () => {
      renderChart();
      expect(lastRender(captured.chart)).toMatchObject({ accessibilityLayer: true });
    });

    it('heads the data table with the period, then each model by display name', () => {
      renderChart();
      const headers = screen
        .getAllByRole('columnheader', { hidden: true })
        .map((header) => header.textContent);
      expect(headers).toEqual(['Period', 'Large Model 4.1', 'Small Model 2.5']);
    });

    it('heads a model the catalog lacks with its id', () => {
      renderChart({
        data: makeData([{ period: DAY_ONE, model: UNLISTED, totalCost: '1000000000', count: 1 }]),
      });
      expect(screen.getByRole('columnheader', { name: UNLISTED, hidden: true })).toBeVisible();
    });
  });

  describe('stack', () => {
    it('stacks every model area on one stack', () => {
      renderChart();
      const stackIds = drawnAreas().map((area) => area['stackId']);
      expect(stackIds).toHaveLength(2);
      expect(new Set(stackIds).size).toBe(1);
      expect(stackIds[0]).toBeDefined();
    });

    it('stacks the largest spender first, whatever order the data arrives in', () => {
      renderChart();
      const config = lastRender(captured.configs);
      const names = drawnAreas().map((area) => config[String(area['dataKey'])]?.label);
      expect(names).toEqual(['Large Model 4.1', 'Small Model 2.5']);
    });

    it('stacks three models from the largest spend down', () => {
      renderChart({
        data: makeData([
          { period: DAY_ONE, model: 'fictional/a', totalCost: '1000000000', count: 1 },
          { period: DAY_ONE, model: 'fictional/c', totalCost: '3000000000', count: 1 },
          { period: DAY_ONE, model: 'fictional/b', totalCost: '2000000000', count: 1 },
        ]),
      });
      const entries = within(legend())
        .getAllByRole('listitem')
        .map((item) => item.textContent);
      expect(entries).toEqual(['fictional/c', 'fictional/b', 'fictional/a', 'Total']);
    });

    it('stacks models of equal spend in id order', () => {
      renderChart({
        data: makeData([
          { period: DAY_ONE, model: 'fictional/b', totalCost: '1000000000', count: 1 },
          { period: DAY_ONE, model: 'fictional/a', totalCost: '1000000000', count: 1 },
        ]),
      });
      const entries = within(legend())
        .getAllByRole('listitem')
        .map((item) => item.textContent);
      expect(entries).toEqual(['fictional/a', 'fictional/b', 'Total']);
    });

    it('draws each model area in its page swatch', () => {
      renderChart();
      const labels = pageLabels();
      const config = lastRender(captured.configs);
      for (const area of drawnAreas()) {
        const modelId = [SMALL, LARGE].find(
          (id) => labels.name(id) === config[String(area['dataKey'])]?.label
        );
        const colour = `var(--model-${String(labels.swatch(modelId ?? ''))})`;
        expect(area).toMatchObject({ fill: colour, stroke: colour });
      }
    });

    it('fills each model area at half opacity', () => {
      renderChart();
      for (const area of drawnAreas()) expect(area['fillOpacity']).toBe(0.5);
    });

    it('edges each model area with a 1.5px line', () => {
      renderChart();
      for (const area of drawnAreas()) expect(area['strokeWidth']).toBe(1.5);
    });

    it('sums each period total from the values stacked under it', () => {
      renderChart();
      const rows = lastRender(captured.chart)['data'] as Record<string, number>[];
      const keys = drawnAreas().map((area) => String(area['dataKey']));
      for (const row of rows) {
        const stacked = keys.reduce((sum, key) => sum + (row[key] ?? 0), 0);
        expect(row['total']).toBe(stacked);
      }
      expect(rows.map((row) => row['total'])).toEqual([3.5, 3.75]);
    });
  });

  describe('total', () => {
    it('draws the daily total as a line, not an area', () => {
      renderChart();
      expect(lastRender(captured.lines)['dataKey']).toBe('total');
      expect(drawnAreas().map((area) => area['dataKey'])).not.toContain('total');
    });

    it('dashes the total line in the foreground colour', () => {
      renderChart();
      const line = lastRender(captured.lines);
      expect(line['stroke']).toBe('var(--foreground)');
      expect(line['strokeDasharray']).toEqual(expect.any(String));
    });

    it('draws the total over the stack', () => {
      renderChart();
      const chart = lastRender(captured.chart);
      const children = React.Children.toArray(chart['children'] as React.ReactNode);
      const types = children.map((child) =>
        React.isValidElement(child) && child.props !== null && typeof child.props === 'object'
          ? 'dataKey' in child.props && child.props.dataKey === 'total'
          : false
      );
      expect(types.at(-1)).toBe(true);
    });
  });

  describe('y-axis', () => {
    it('reads the y-axis in dollars', () => {
      renderChart();
      const format = lastRender(captured.yAxes)['tickFormatter'] as (value: number) => string;
      expect(format(0.2)).toBe('$0.20');
    });

    it('sets the y-axis figures in mono', () => {
      renderChart();
      expect(tickClasses(captured.yAxes)).toContain('font-mono');
    });

    it('draws the y-axis figures on the muted foreground token', () => {
      renderChart();
      expect(tickClasses(captured.yAxes)).toContain('fill-muted-foreground');
    });
  });

  describe('x-axis', () => {
    it('draws the dates on the muted foreground token', () => {
      renderChart();
      expect(tickClasses(captured.xAxes)).toContain('fill-muted-foreground');
    });

    it('keeps the first and last dates, dropping dates between them where they would meet', () => {
      renderChart();
      expect(lastRender(captured.xAxes)['interval']).toBe('preserveStartEnd');
    });

    it('lays the dates out again when the text size changes with the chart on screen', async () => {
      await changeInAct(() => {
        document.documentElement.style.fontSize = '16px';
      });
      try {
        renderChart();
        const mountsBefore = captured.xAxisMounts.length;
        await changeInAct(() => {
          document.documentElement.style.fontSize = '24px';
        });
        expect(captured.xAxisMounts.length).toBeGreaterThan(mountsBefore);
      } finally {
        await changeInAct(() => {
          document.documentElement.style.removeProperty('font-size');
        });
      }
    });

    it('keeps the dates laid out while the text size stays put', async () => {
      renderChart();
      const mountsBefore = captured.xAxisMounts.length;
      try {
        await changeInAct(() => {
          document.documentElement.dataset['probe'] = 'unrelated';
        });
        expect(captured.xAxisMounts.length).toBe(mountsBefore);
      } finally {
        await changeInAct(() => {
          delete document.documentElement.dataset['probe'];
        });
      }
    });

    it('lays the dates out again when the window resizes across a text-size band', async () => {
      renderChart();
      const mountsBefore = captured.xAxisMounts.length;
      // The root size follows the width band through a stylesheet rule, which moves no
      // attribute on the root.
      const band = document.createElement('style');
      band.textContent = 'html { font-size: 17px; }';
      try {
        await changeInAct(() => {
          document.head.append(band);
          globalThis.dispatchEvent(new Event('resize'));
        });
        expect(captured.xAxisMounts.length).toBeGreaterThan(mountsBefore);
      } finally {
        await changeInAct(() => {
          band.remove();
          globalThis.dispatchEvent(new Event('resize'));
        });
      }
    });
  });

  describe('legend', () => {
    it('lists each model by display name, largest spender first, then the total', () => {
      renderChart();
      const entries = within(legend())
        .getAllByRole('listitem')
        .map((item) => item.textContent);
      expect(entries).toEqual(['Large Model 4.1', 'Small Model 2.5', 'Total']);
    });

    it("marks each model's entry with its page swatch", () => {
      renderChart();
      const labels = pageLabels();
      const [large, small] = within(legend()).getAllByRole('listitem');
      expect(large?.querySelector('[data-slot="swatch"]')).toHaveClass(
        `bg-model-${String(labels.swatch(LARGE))}`
      );
      expect(small?.querySelector('[data-slot="swatch"]')).toHaveClass(
        `bg-model-${String(labels.swatch(SMALL))}`
      );
    });

    it("marks the total's entry with a dashed rule", () => {
      renderChart();
      const total = within(legend()).getAllByRole('listitem').at(-1);
      expect(total?.querySelector('[data-slot="legend-dash"]')).toHaveClass('border-dashed');
    });

    it('keeps the legend out of the plot', () => {
      const { container } = renderChart();
      expect(container.querySelector('[data-chart]')).not.toContainElement(legend());
    });

    it('draws no legend while loading', () => {
      renderChart({ data: undefined, isLoading: true });
      expect(screen.queryByRole('list', { name: 'Legend' })).not.toBeInTheDocument();
    });
  });

  describe('tooltip', () => {
    it('names each model by its display name', () => {
      renderChart();
      const content = lastRender(captured.tooltips)['content'] as React.ReactElement<
        Record<string, unknown>
      >;
      const key = String(drawnAreas()[0]?.['dataKey']);
      const { container: tooltip } = render(
        <ChartContainer config={lastRender(captured.configs)}>
          {React.cloneElement(content, {
            active: true,
            label: formatPeriodLabel(DAY_ONE),
            payload: [{ dataKey: key, value: 2 }],
          })}
        </ChartContainer>
      );
      expect(within(tooltip).getByText('Large Model 4.1')).toBeInTheDocument();
    });

    it('names the total "Total"', () => {
      renderChart();
      expect(lastRender(captured.configs)['total']?.label).toBe('Total');
    });
  });

  describe('motion', () => {
    it('animates the plot by default', () => {
      renderChart();
      expect(drawnAreas()[0]?.['isAnimationActive']).toBe(true);
      expect(lastRender(captured.lines)['isAnimationActive']).toBe(true);
    });

    it('holds the plot still when motion is reduced', () => {
      motionRef.reduced = true;
      renderChart();
      expect(drawnAreas()[0]?.['isAnimationActive']).toBe(false);
      expect(lastRender(captured.lines)['isAnimationActive']).toBe(false);
    });
  });
});
