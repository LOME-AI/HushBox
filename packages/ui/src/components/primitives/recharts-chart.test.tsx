import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach } from 'vitest';
import { useA11yStore } from '../accessibility/store';
import { RechartsChart } from './recharts-chart';

const DATA_TABLE = (
  <table>
    <caption>Visitors per day</caption>
    <tbody>
      <tr>
        <th scope="row">2026-09-01</th>
        <td>1,284</td>
      </tr>
    </tbody>
  </table>
);

function renderChart(
  props: Partial<React.ComponentProps<typeof RechartsChart>> = {}
): ReturnType<typeof render> {
  return render(
    <RechartsChart
      title="Visitors"
      caption="Visitors rose through the week."
      config={{ visitors: { label: 'Visitors', color: 'var(--chart-1)' } }}
      dataTable={DATA_TABLE}
      {...props}
    >
      {() => <svg aria-hidden="true" />}
    </RechartsChart>
  );
}

beforeEach(() => {
  useA11yStore.setState({ stopAnimations: false, forcedReducedMotion: false });
});

describe('RechartsChart', () => {
  it('tells the plot the height it reserved, so the plot can start at a real size', () => {
    const { container } = render(
      <RechartsChart
        title="Visitors"
        caption="Visitors rose through the week."
        config={{}}
        dataTable={DATA_TABLE}
      >
        {({ plotHeight }) => <svg aria-hidden="true" data-height={plotHeight} />}
      </RechartsChart>
    );
    const box = container.querySelector('[data-slot="chart-plot-box"]');
    const plot = container.querySelector('svg[data-height]');
    const told = Number((plot as HTMLElement | null)?.dataset['height']);
    expect(told).toBeGreaterThan(0);
    expect(box).toHaveStyle({ height: `${String(told)}px` });
  });

  it('groups the chart and its caption in one figure', () => {
    renderChart();
    expect(screen.getByRole('figure', { name: /Visitors/ })).toBeInTheDocument();
  });

  it('draws its title one level below the panel heading when the caller names that level', () => {
    renderChart({ headingLevel: 4 });
    expect(screen.getByRole('heading', { level: 4, name: 'Visitors' })).toBeInTheDocument();
  });

  // The default is what keeps every other screen's outline still, so it is
  // pinned rather than left to the prop. It passes against the code as it was,
  // which is the point of it.
  it('draws its title at level three when the caller names no level', () => {
    renderChart();
    expect(screen.getByRole('heading', { level: 3, name: 'Visitors' })).toBeInTheDocument();
  });

  it('states the insight line as the caption', () => {
    renderChart();
    expect(screen.getByText('Visitors rose through the week.')).toBeInTheDocument();
  });

  it('renders the data table as a real table from the first render', () => {
    renderChart();
    expect(screen.getByRole('table', { name: 'Visitors per day' })).toBeInTheDocument();
  });

  it('keeps the data table out of sight until it is asked for', () => {
    const { container } = renderChart();
    expect(container.querySelector('[data-slot="chart-data-table"]')).toHaveClass('sr-only');
  });

  it('offers a control to show the data table', () => {
    renderChart();
    expect(screen.getByRole('button', { name: 'Show data' })).toBeInTheDocument();
  });

  it('reveals the data table when the control is pressed', async () => {
    const { container } = renderChart();
    await userEvent.click(screen.getByRole('button', { name: 'Show data' }));
    expect(container.querySelector('[data-slot="chart-data-table"]')).not.toHaveClass('sr-only');
  });

  // An attribute cannot decide this: Chromium makes a box whose content
  // overflows it keyboard-focusable whatever its tabindex, and `sr-only` is a
  // 1px box its table overflows, so an overflow class there is a hidden tab stop.
  it('keeps every overflow class off the hidden data table, because Chromium makes an overflowing hidden box focusable', () => {
    const { container } = renderChart();
    const hidden = container.querySelector('[data-slot="chart-data-table"]');
    const overflowClasses = [...(hidden?.classList ?? [])].filter((name) =>
      name.startsWith('overflow-')
    );
    expect(overflowClasses).toEqual([]);
  });

  it('makes the shown data table a tab stop', async () => {
    const { container } = renderChart();
    await userEvent.click(screen.getByRole('button', { name: 'Show data' }));
    expect(container.querySelector('[data-slot="chart-data-table"]')).toHaveAttribute(
      'tabindex',
      '0'
    );
  });

  it('names the shown data table for the chart it belongs to', async () => {
    const { container } = renderChart();
    await userEvent.click(screen.getByRole('button', { name: 'Show data' }));
    expect(screen.getByRole('group', { name: 'Visitors data' })).toBe(
      container.querySelector('[data-slot="chart-data-table"]')
    );
  });

  it('draws the shown data table’s box rounded, its own shape rather than the scroll region’s', async () => {
    renderChart();
    await userEvent.click(screen.getByRole('button', { name: 'Show data' }));
    expect(screen.getByRole('group', { name: 'Visitors data' })).toHaveClass('rounded-sm');
  });

  it('offers to hide the table again once it is shown', async () => {
    renderChart();
    await userEvent.click(screen.getByRole('button', { name: 'Show data' }));
    expect(screen.getByRole('button', { name: 'Hide data' })).toBeInTheDocument();
  });

  it('animates when no reduced-motion source is set', () => {
    let seen: boolean | null = null;
    render(
      <RechartsChart title="Visitors" caption="c" config={{}} dataTable={DATA_TABLE}>
        {({ isAnimationActive }) => {
          seen = isAnimationActive;
          return <svg aria-hidden="true" />;
        }}
      </RechartsChart>
    );
    expect(seen).toBe(true);
  });

  it('stops animating when the accessibility widget asks it to', () => {
    useA11yStore.setState({ stopAnimations: true });
    let seen: boolean | null = null;
    render(
      <RechartsChart title="Visitors" caption="c" config={{}} dataTable={DATA_TABLE}>
        {({ isAnimationActive }) => {
          seen = isAnimationActive;
          return <svg aria-hidden="true" />;
        }}
      </RechartsChart>
    );
    expect(seen).toBe(false);
  });

  it('names the chart region for a screen reader with the summary it was given', () => {
    renderChart({ ariaLabel: 'Visitors across seven days.' });
    expect(screen.getByRole('img', { name: /Visitors across seven days\./ })).toBeInTheDocument();
  });

  it('shows the empty message instead of the chart when there is nothing to plot', () => {
    renderChart({ isEmpty: true, emptyMessage: 'No visitors in this range' });
    expect(screen.getByText('No visitors in this range')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('keeps the data table reachable when the chart is empty', () => {
    renderChart({ isEmpty: true });
    expect(screen.getByRole('table', { name: 'Visitors per day' })).toBeInTheDocument();
  });
});
