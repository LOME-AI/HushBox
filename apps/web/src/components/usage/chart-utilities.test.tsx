// Set a timezone west of UTC so a UTC-midnight date string formatted in local
// time would render the previous day. Must run before any Date/Intl usage.
process.env['TZ'] = 'America/New_York';

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { nanoUsdToFullDollarString, TEST_IDS } from '@hushbox/shared';
import { HOUR_MS, TEST_DAY_START } from '@hushbox/shared/test-time';
import {
  formatTokenCount,
  formatDollarTick,
  formatDollarTooltip,
  formatNanoUsdAmount,
  formatPeriodLabel,
  DEFAULT_CHART_MARGIN,
  DEFAULT_AXIS_PROPS,
  UsageChartCard,
  UsageErrorState,
  UsageSection,
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

describe('UsageErrorState', () => {
  it('draws the destructive, subtle inline notice', () => {
    render(<UsageErrorState message="Couldn't load this chart" />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('data-slot', 'notice');
    expect(alert).toHaveAttribute('data-tone', 'error');
    expect(alert).toHaveClass('text-destructive');
  });

  it("draws the subtle pair, without the strong pair's tinted fill", () => {
    render(<UsageErrorState message="Couldn't load this chart" />);
    expect(screen.getByRole('alert')).not.toHaveClass('bg-destructive/10');
  });

  it('shows its message', () => {
    render(<UsageErrorState message="Couldn't load this chart" />);
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load this chart");
  });

  it('retries from its Retry button', async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    render(<UsageErrorState message="Couldn't load this chart" onRetry={onRetry} />);
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('UsageSection', () => {
  function renderSection(
    overrides: Partial<React.ComponentProps<typeof UsageSection>> = {}
  ): ReturnType<typeof render> {
    const props: React.ComponentProps<typeof UsageSection> = {
      title: 'Cost by Model',
      testId: 'section-under-test',
      isLoading: false,
      isError: false,
      isEmpty: false,
      children: <p>section content</p>,
      ...overrides,
    };
    return render(<UsageSection {...props} />);
  }

  it('names the block by its heading', () => {
    renderSection();
    expect(screen.getByRole('region', { name: 'Cost by Model' })).toBeInTheDocument();
  });

  it('draws the title as a second-level heading', () => {
    renderSection();
    expect(screen.getByRole('heading', { level: 2, name: 'Cost by Model' })).toBeInTheDocument();
  });

  it('sets the heading in the serif title role', () => {
    renderSection();
    expect(screen.getByRole('heading', { level: 2 })).toHaveClass('text-title-2');
  });

  it('carries its test id on the block', () => {
    renderSection();
    expect(screen.getByTestId('section-under-test')).toBe(
      screen.getByRole('region', { name: 'Cost by Model' })
    );
  });

  it('draws no card around the block', () => {
    const { container } = renderSection();
    expect(container.querySelector('[data-slot="card"]')).toBeNull();
  });

  it('renders its content once loaded', () => {
    renderSection();
    expect(screen.getByText('section content')).toBeInTheDocument();
  });

  it('shows the placeholder while loading', () => {
    renderSection({ isLoading: true });
    expect(screen.getByRole('group', { name: 'Cost by Model' })).toHaveAttribute(
      'aria-busy',
      'true'
    );
    expect(screen.getByTestId(TEST_IDS.skeletonBlock)).toBeInTheDocument();
  });

  it('holds its content back while loading', () => {
    renderSection({ isLoading: true });
    expect(screen.queryByText('section content')).not.toBeInTheDocument();
  });

  it('shows the retryable error in place of the content', async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    renderSection({ isError: true, onRetry });
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load this chart");
    expect(screen.queryByText('section content')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('ranks the error above the empty message', () => {
    renderSection({ isError: true, isEmpty: true });
    expect(screen.queryByText('No usage data for this period')).not.toBeInTheDocument();
  });

  it('ranks loading above the error', () => {
    renderSection({ isLoading: true, isError: true });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it("shows today's empty message when there is nothing to draw", () => {
    renderSection({ isEmpty: true });
    expect(screen.getByText('No usage data for this period')).toBeInTheDocument();
    expect(screen.queryByText('section content')).not.toBeInTheDocument();
  });

  it('shows a custom empty message', () => {
    renderSection({ isEmpty: true, emptyMessage: 'No conversations yet' });
    expect(screen.getByText('No conversations yet')).toBeInTheDocument();
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

  it('puts a negative sign ahead of the currency symbol', () => {
    expect(formatDollarTick(-1.5)).toBe('-$1.50');
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

  it('puts a negative sign ahead of the currency symbol', () => {
    expect(formatDollarTooltip(-1.5)).toBe('-$1.5000');
  });

  it('puts a negative sign ahead of the currency symbol for string input', () => {
    expect(formatDollarTooltip('-0.5')).toBe('-$0.5000');
  });

  it('renders a negative nano-USD wire amount converted to dollars sign-first', () => {
    // The two halves of the usage-figure fix meet here: the shared converter
    // turns the wire amount into dollars, and this formatter places the sign.
    expect(formatDollarTooltip(Number(nanoUsdToFullDollarString('-1500000000')))).toBe('-$1.5000');
  });

  it('rounds an exact half of the last place up from a converted wire string', () => {
    expect(formatDollarTooltip(nanoUsdToFullDollarString('150000'))).toBe('$0.0002');
  });

  it('rounds an exact half of the last place up from a plotted number', () => {
    expect(formatDollarTooltip(0.000_15)).toBe('$0.0002');
  });

  it('refuses a dollar string finer than one nano-USD', () => {
    expect(() => formatDollarTooltip('0.0000000001')).toThrow();
  });
});

describe('formatNanoUsdAmount', () => {
  it('formats a nano-USD wire amount to four places with the currency symbol', () => {
    expect(formatNanoUsdAmount('1234560000')).toBe('$1.2346');
  });

  it('rounds an exact half of the last place up', () => {
    expect(formatNanoUsdAmount('150000')).toBe('$0.0002');
  });

  it('puts a negative sign ahead of the currency symbol', () => {
    expect(formatNanoUsdAmount('-1500000000')).toBe('-$1.5000');
  });
});

describe('formatPeriodLabel', () => {
  it('renders a YYYY-MM-DD period in UTC, not the previous day in local time', () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('America/New_York');
    expect(formatPeriodLabel('2025-01-01')).toBe('Jan 1');
  });

  it('formats a full ISO timestamp in UTC', () => {
    const justAfterUtcMidnight = new Date(TEST_DAY_START + 2 * HOUR_MS);

    expect(formatPeriodLabel(justAfterUtcMidnight.toISOString())).toBe('Jan 15');
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
      tick: { fontSize: '0.75rem' },
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

  it('renders a retryable error state instead of the empty message when the query failed', async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    render(
      <UsageChartCard
        title="Test Chart"
        testId="test-chart"
        isLoading={false}
        isEmpty={true}
        isError={true}
        onRetry={onRetry}
        chartConfig={defaultConfig}
      >
        <div>chart content</div>
      </UsageChartCard>
    );

    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load this chart");
    expect(screen.queryByText('No usage data for this period')).not.toBeInTheDocument();
    expect(screen.queryByText('chart content')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('builds its error state on the shared notice rather than a hand-rolled live region', () => {
    render(
      <UsageChartCard
        title="Test Chart"
        testId="test-chart"
        isLoading={false}
        isEmpty={true}
        isError={true}
        chartConfig={defaultConfig}
      >
        <div>chart content</div>
      </UsageChartCard>
    );

    expect(screen.getByRole('alert')).toHaveAttribute('data-slot', 'notice');
  });

  it('does not render the error state while loading', () => {
    render(
      <UsageChartCard
        title="Test Chart"
        testId="test-chart"
        isLoading={true}
        isEmpty={true}
        isError={true}
        chartConfig={defaultConfig}
      >
        <div>chart content</div>
      </UsageChartCard>
    );

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.skeletonBlock)).toBeInTheDocument();
  });

  it('draws the chart as a usage section named by its title', () => {
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
    expect(screen.getByRole('region', { name: 'My Title' })).toBe(screen.getByTestId('my-chart'));
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

  it("draws its legend after the plot, outside the plot's fixed-height box", () => {
    const { container } = render(
      <UsageChartCard
        title="Test Chart"
        testId="test-chart"
        isLoading={false}
        isEmpty={false}
        chartConfig={defaultConfig}
        legend={<ul data-testid="legend-probe" />}
      >
        <div>chart content</div>
      </UsageChartCard>
    );
    const plot = container.querySelector('[data-chart]');
    const legend = screen.getByTestId('legend-probe');
    expect(plot?.contains(legend)).toBe(false);
    expect(plot?.compareDocumentPosition(legend)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('keeps the legend inside its block', () => {
    render(
      <UsageChartCard
        title="Test Chart"
        testId="test-chart"
        isLoading={false}
        isEmpty={false}
        chartConfig={defaultConfig}
        legend={<ul data-testid="legend-probe" />}
      >
        <div>chart content</div>
      </UsageChartCard>
    );
    expect(screen.getByTestId('test-chart')).toContainElement(screen.getByTestId('legend-probe'));
  });
});
