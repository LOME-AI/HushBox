import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import {
  ChartSkeleton,
  formatTokenCount,
  formatDollarTick,
  formatDollarTooltip,
  DEFAULT_CHART_MARGIN,
  DEFAULT_AXIS_PROPS,
  UsageChartCard,
} from './chart-utilities';

vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div style={{ width: 800, height: 300 }}>{children}</div>
    ),
  };
});

describe('ChartSkeleton', () => {
  it('renders skeleton block', () => {
    render(<ChartSkeleton />);
    expect(screen.getByTestId('skeleton-block')).toBeInTheDocument();
  });
});

describe('formatTokenCount', () => {
  it('formats millions', () => {
    expect(formatTokenCount(1_500_000)).toBe('1.5M');
  });

  it('formats thousands', () => {
    expect(formatTokenCount(2500)).toBe('2.5K');
  });

  it('returns raw number below 1000', () => {
    expect(formatTokenCount(42)).toBe('42');
  });

  it('formats exactly 1 million', () => {
    expect(formatTokenCount(1_000_000)).toBe('1.0M');
  });

  it('formats exactly 1000', () => {
    expect(formatTokenCount(1000)).toBe('1.0K');
  });
});

describe('formatDollarTick', () => {
  it('formats with 2 decimal places', () => {
    expect(formatDollarTick(1.5)).toBe('$1.50');
  });

  it('formats zero', () => {
    expect(formatDollarTick(0)).toBe('$0.00');
  });

  it('formats large values', () => {
    expect(formatDollarTick(1234.5)).toBe('$1234.50');
  });
});

describe('formatDollarTooltip', () => {
  it('formats number with 4 decimal places', () => {
    expect(formatDollarTooltip(1.234_56)).toBe('$1.2346');
  });

  it('accepts string input', () => {
    expect(formatDollarTooltip('0.5')).toBe('$0.5000');
  });

  it('formats zero', () => {
    expect(formatDollarTooltip(0)).toBe('$0.0000');
  });
});

describe('DEFAULT_CHART_MARGIN', () => {
  it('has expected values', () => {
    expect(DEFAULT_CHART_MARGIN).toEqual({ top: 4, right: 4, left: 0, bottom: 0 });
  });
});

describe('DEFAULT_AXIS_PROPS', () => {
  it('has expected values', () => {
    expect(DEFAULT_AXIS_PROPS).toEqual({
      tick: { fontSize: 12 },
      tickLine: false,
      axisLine: false,
    });
  });
});

describe('UsageChartCard', () => {
  const defaultConfig = { value: { label: 'Value', color: 'var(--chart-1)' } };

  it('renders loading skeleton when isLoading is true', () => {
    render(
      <UsageChartCard
        title="Test Chart"
        testId="test-chart"
        isLoading={true}
        isEmpty={false}
        chartConfig={defaultConfig}
      >
        <div>chart content</div>
      </UsageChartCard>
    );
    expect(screen.getByTestId('skeleton-block')).toBeInTheDocument();
    expect(screen.queryByText('chart content')).not.toBeInTheDocument();
  });

  it('renders empty message when isEmpty is true and not loading', () => {
    render(
      <UsageChartCard
        title="Test Chart"
        testId="test-chart"
        isLoading={false}
        isEmpty={true}
        chartConfig={defaultConfig}
      >
        <div>chart content</div>
      </UsageChartCard>
    );
    expect(screen.getByText('No usage data for this period')).toBeInTheDocument();
    expect(screen.queryByText('chart content')).not.toBeInTheDocument();
  });

  it('renders custom empty message', () => {
    render(
      <UsageChartCard
        title="Test Chart"
        testId="test-chart"
        isLoading={false}
        isEmpty={true}
        emptyMessage="No balance history"
        chartConfig={defaultConfig}
      >
        <div>chart content</div>
      </UsageChartCard>
    );
    expect(screen.getByText('No balance history')).toBeInTheDocument();
  });

  it('renders title and testId', () => {
    render(
      <UsageChartCard
        title="My Title"
        testId="my-chart"
        isLoading={false}
        isEmpty={false}
        chartConfig={defaultConfig}
      >
        <div>chart content</div>
      </UsageChartCard>
    );
    expect(screen.getByText('My Title')).toBeInTheDocument();
    expect(screen.getByTestId('my-chart')).toBeInTheDocument();
  });

  it('renders children when not loading and not empty', () => {
    render(
      <UsageChartCard
        title="Test Chart"
        testId="test-chart"
        isLoading={false}
        isEmpty={false}
        chartConfig={defaultConfig}
      >
        <div>chart content</div>
      </UsageChartCard>
    );
    expect(screen.getByText('chart content')).toBeInTheDocument();
    expect(screen.queryByTestId('skeleton-block')).not.toBeInTheDocument();
    expect(screen.queryByText('No usage data for this period')).not.toBeInTheDocument();
  });

  it('does not render empty message while loading', () => {
    render(
      <UsageChartCard
        title="Test Chart"
        testId="test-chart"
        isLoading={true}
        isEmpty={true}
        chartConfig={defaultConfig}
      >
        <div>chart content</div>
      </UsageChartCard>
    );
    expect(screen.getByTestId('skeleton-block')).toBeInTheDocument();
    expect(screen.queryByText('No usage data for this period')).not.toBeInTheDocument();
  });
});
