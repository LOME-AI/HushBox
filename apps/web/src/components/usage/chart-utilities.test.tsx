// Set a timezone west of UTC so a UTC-midnight date string formatted in local
// time would render the previous day. Must run before any Date/Intl usage.
process.env['TZ'] = 'America/New_York';

import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TEST_IDS } from '@hushbox/shared';
import {
  ChartSkeleton,
  formatTokenCount,
  formatDollarTick,
  formatDollarTooltip,
  formatPeriodLabel,
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
    expect(screen.getByTestId(TEST_IDS.skeletonBlock)).toBeInTheDocument();
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

describe('formatPeriodLabel', () => {
  it('renders a YYYY-MM-DD period in UTC, not the previous day in local time', () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('America/New_York');
    expect(formatPeriodLabel('2025-01-01')).toBe('Jan 1');
  });

  it('formats a full ISO timestamp in UTC', () => {
    expect(formatPeriodLabel('2025-03-15T02:00:00.000Z')).toBe('Mar 15');
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
    expect(screen.getByTestId(TEST_IDS.skeletonBlock)).toBeInTheDocument();
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
    expect(screen.queryByTestId(TEST_IDS.skeletonBlock)).not.toBeInTheDocument();
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
    expect(screen.getByTestId(TEST_IDS.skeletonBlock)).toBeInTheDocument();
    expect(screen.queryByText('No usage data for this period')).not.toBeInTheDocument();
  });

  it('exposes the chart region as an image whose accessible name includes the summary', () => {
    render(
      <UsageChartCard
        title="Test Chart"
        testId="test-chart"
        isLoading={false}
        isEmpty={false}
        chartConfig={defaultConfig}
        ariaLabel="A summary of the chart"
      >
        <div>chart content</div>
      </UsageChartCard>
    );
    expect(
      screen.getByRole('img', { name: 'Test Chart A summary of the chart' })
    ).toBeInTheDocument();
  });

  it('ties the chart region to its title via aria-labelledby', () => {
    render(
      <UsageChartCard
        title="My Title"
        testId="test-chart"
        isLoading={false}
        isEmpty={false}
        chartConfig={defaultConfig}
        ariaLabel="A summary of the chart"
      >
        <div>chart content</div>
      </UsageChartCard>
    );
    const region = screen.getByRole('img', { name: 'My Title A summary of the chart' });
    const labelledBy = region.getAttribute('aria-labelledby') ?? '';
    const titleRef = labelledBy.split(' ')[0] ?? '';
    expect(document.querySelector(`#${titleRef}`)).toHaveTextContent('My Title');
  });

  it('renders a visually-hidden data-table alternative for assistive tech', () => {
    render(
      <UsageChartCard
        title="Test Chart"
        testId="test-chart"
        isLoading={false}
        isEmpty={false}
        chartConfig={defaultConfig}
        ariaLabel="A summary of the chart"
        dataTable={
          <table>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Amount</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Jan 1</td>
                <td>$1.00</td>
              </tr>
            </tbody>
          </table>
        }
      >
        <div>chart content</div>
      </UsageChartCard>
    );
    const table = screen.getByRole('table', { hidden: true });
    expect(table).toBeInTheDocument();
    expect(table.closest('.sr-only')).not.toBeNull();
  });

  it('does not render the data-table alternative while loading', () => {
    render(
      <UsageChartCard
        title="Test Chart"
        testId="test-chart"
        isLoading={true}
        isEmpty={false}
        chartConfig={defaultConfig}
        ariaLabel="A summary of the chart"
        dataTable={
          <table data-testid="dt">
            <thead>
              <tr>
                <th scope="col">Header</th>
              </tr>
            </thead>
          </table>
        }
      >
        <div>chart content</div>
      </UsageChartCard>
    );
    expect(screen.queryByTestId('dt')).not.toBeInTheDocument();
  });
});
