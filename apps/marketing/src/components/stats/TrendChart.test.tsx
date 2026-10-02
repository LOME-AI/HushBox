import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { A11Y_FONT_OVERRIDE_CLASS } from '@hushbox/ui/accessibility';
import { TrendChart } from './TrendChart';
import {
  tickThresholds,
  WIDGET_FACE_TICK_CHARACTER_EM,
  type TrendBand,
  type XAxisTick,
} from './compute-stats';

const BANDS: readonly TrendBand[] = [
  {
    id: 'a/one',
    label: 'One',
    color: 'var(--chart-1)',
    path: 'M 0 100 L 100 100 L 100 60 L 0 60 Z',
    topPath: 'M 0 60 L 100 60',
    segments: 'M 50 60 L 100 60',
  },
  {
    id: 'others',
    label: 'Others',
    color: 'var(--border)',
    path: 'M 0 60 L 100 60 L 100 0 L 0 0 Z',
    topPath: 'M 0 0 L 100 0',
    segments: 'M 0 0 L 100 0',
  },
];

const TICKS: readonly XAxisTick[] = [
  { label: 'Aug 25', position: 0, tier: 'edge' },
  { label: 'Sep 1', position: 24.14, tier: 'dense' },
  { label: 'Sep 8', position: 48.28, tier: 'alternate' },
  { label: 'Sep 23', position: 100, tier: 'edge' },
];

function renderChart(bands: readonly TrendBand[] = BANDS): ReturnType<typeof render> {
  return render(<TrendChart bands={bands} ticks={TICKS} ariaLabel="chart" />);
}

describe('TrendChart', () => {
  it('renders an svg image with the given accessible label', () => {
    render(
      <TrendChart
        bands={BANDS}
        ticks={TICKS}
        ariaLabel="Model share for Text, 30 days, as a stacked area chart from Aug 25 to Sep 23. The ranking below carries the same data."
      />
    );
    expect(
      screen.getByRole('img', {
        name: 'Model share for Text, 30 days, as a stacked area chart from Aug 25 to Sep 23. The ranking below carries the same data.',
      })
    ).toBeInTheDocument();
  });

  it('renders one gradient-filled area path per band', () => {
    const { container } = renderChart();
    const areas = container.querySelectorAll('path[fill^="url(#"]');
    expect(areas).toHaveLength(2);
    const gradients = container.querySelectorAll('linearGradient');
    expect(gradients).toHaveLength(2);
    for (const [index, band] of BANDS.entries()) {
      const area = areas[index]!;
      expect(area.getAttribute('d')).toBe(band.path);
      expect(area.getAttribute('fill')).toBe(`url(#${gradients[index]!.id})`);
    }
  });

  it('fades each band gradient from 85% under its top line to 40% at its bottom', () => {
    const { container } = renderChart();
    const gradients = container.querySelectorAll('linearGradient');
    for (const [index, band] of BANDS.entries()) {
      const gradient = gradients[index]!;
      const stops = gradient.querySelectorAll('stop');
      expect(stops).toHaveLength(2);
      expect(stops[0]!.getAttribute('stop-color')).toBe(band.color);
      expect(stops[0]!.getAttribute('stop-opacity')).toBe('0.85');
      expect(stops[1]!.getAttribute('stop-color')).toBe(band.color);
      expect(stops[1]!.getAttribute('stop-opacity')).toBe('0.4');
      // Vertical fade over the band's own extent (objectBoundingBox units).
      expect(gradient.getAttribute('x1')).toBe('0');
      expect(gradient.getAttribute('y1')).toBe('0');
      expect(gradient.getAttribute('x2')).toBe('0');
      expect(gradient.getAttribute('y2')).toBe('1');
    }
  });

  it('strokes each band top line along its share segments in its series colour', () => {
    const { container } = renderChart();
    const lines = container.querySelectorAll('path[fill="none"]');
    expect(lines).toHaveLength(2);
    for (const [index, band] of BANDS.entries()) {
      const line = lines[index]!;
      expect(line.getAttribute('d')).toBe(band.segments);
      expect(line.getAttribute('stroke')).toBe(band.color);
      expect(line.getAttribute('stroke-width')).toBe('2');
      expect(line.getAttribute('stroke-linejoin')).toBe('round');
      // The viewBox is stretched non-uniformly; without this the 2px line would distort.
      expect(line.getAttribute('vector-effect')).toBe('non-scaling-stroke');
    }
  });

  it('skips the top line of a band with no share segment', () => {
    const { container } = renderChart([{ ...BANDS[0]!, segments: '' }, BANDS[1]!]);
    const lines = container.querySelectorAll('path[fill="none"]');
    expect([...lines].map((line) => line.getAttribute('d'))).toEqual([BANDS[1]!.segments]);
  });

  it('labels the percent axis from 100% down to 0%', () => {
    renderChart();
    for (const label of ['100%', '75%', '50%', '25%', '0%']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('draws dashed gridlines at 25, 50 and 75 percent', () => {
    const { container } = renderChart();
    const gridlines = container.querySelectorAll('[data-gridline]');
    expect([...gridlines].map((line) => line.getAttribute('style'))).toEqual([
      'top: 25%;',
      'top: 50%;',
      'top: 75%;',
    ]);
    for (const line of gridlines) expect(line).toHaveClass('border-dashed');
  });

  it('renders a dated tick label per tick at its position', () => {
    renderChart();
    for (const tick of TICKS) {
      expect(screen.getByText(tick.label)).toHaveStyle({ left: `${String(tick.position)}%` });
    }
  });

  it('marks each tick with its visibility tier', () => {
    renderChart();
    expect(TICKS.map((tick) => screen.getByText(tick.label).dataset['tickTier'])).toEqual([
      'edge',
      'dense',
      'alternate',
      'edge',
    ]);
  });

  it('makes the tick row a size container', () => {
    const { container } = renderChart();
    expect(container.querySelector('[data-tick-scope]')).toHaveClass('@container');
  });

  it('holds the tick labels on a line box inside the container', () => {
    renderChart();
    const lines = screen.getByText('Aug 25').parentElement;
    expect(lines).toHaveAttribute('data-tick-lines');
    expect(lines?.parentElement).toHaveAttribute('data-tick-scope');
  });

  /** The chart's tick rules, and the selector prefix that scopes them to its row. */
  function renderedRules(): { css: string; row: string } {
    const { container } = renderChart();
    const scope = container.querySelector<HTMLElement>('[data-tick-scope]')?.dataset['tickScope'];
    return {
      css: container.querySelector('style')?.textContent ?? '',
      row: `[data-tick-scope="${String(scope)}"]`,
    };
  }

  function hideRule(prefix: string, row: string, width: number, tier: string): string {
    return `@container not (min-width: ${String(width)}rem) { ${prefix}${row} [data-tick-tier="${tier}"] { display: none; } }`;
  }

  function stackRule(prefix: string, row: string, width: number): string {
    return `@container not (min-width: ${String(width)}rem) { ${prefix}${row} [data-tick-lines] { height: 2.25rem; } ${prefix}${row} [data-tick-tier="edge"]:last-child { top: 1.25rem; } }`;
  }

  it('hides each tier below the width its labels need in the mono tick face', () => {
    const { css, row } = renderedRules();
    const { alternate, dense } = tickThresholds(TICKS);
    expect(css).toContain(hideRule('', row, alternate, 'alternate'));
    expect(css).toContain(hideRule('', row, dense, 'dense'));
  });

  it('hides each tier below the width its labels need in a widget face', () => {
    const { css, row } = renderedRules();
    const { alternate, dense } = tickThresholds(TICKS, WIDGET_FACE_TICK_CHARACTER_EM);
    expect(css).toContain(
      hideRule(`html.${A11Y_FONT_OVERRIDE_CLASS} `, row, alternate, 'alternate')
    );
    expect(css).toContain(hideRule(`html.${A11Y_FONT_OVERRIDE_CLASS} `, row, dense, 'dense'));
  });

  it('drops the last label to a second line when the edge labels cannot sit side by side', () => {
    const { css, row } = renderedRules();
    expect(css).toContain(stackRule('', row, tickThresholds(TICKS).edges));
  });

  it('drops the last label to a second line at the widget face width too', () => {
    const { css, row } = renderedRules();
    const { edges } = tickThresholds(TICKS, WIDGET_FACE_TICK_CHARACTER_EM);
    expect(css).toContain(stackRule(`html.${A11Y_FONT_OVERRIDE_CLASS} `, row, edges));
  });

  it('never hides the edge ticks', () => {
    const { css } = renderedRules();
    expect(css).not.toMatch(/"edge"\]\S*\s*\{\s*display: none/);
  });

  it('scopes each chart tick rule to its own tick row', () => {
    const { container } = render(
      <>
        <TrendChart bands={BANDS} ticks={TICKS} ariaLabel="first" />
        <TrendChart bands={BANDS} ticks={TICKS} ariaLabel="second" />
      </>
    );
    const scopes = [...container.querySelectorAll<HTMLElement>('[data-tick-scope]')].map(
      (row) => row.dataset['tickScope']
    );
    expect(new Set(scopes).size).toBe(2);
  });

  it('anchors the first tick at its start and the last at its end', () => {
    renderChart();
    expect(screen.getByText('Aug 25')).not.toHaveClass('-translate-x-1/2');
    expect(screen.getByText('Sep 23')).toHaveClass('-translate-x-full');
    expect(screen.getByText('Sep 8')).toHaveClass('-translate-x-1/2');
  });

  it('keeps both axes out of the accessibility tree', () => {
    renderChart();
    expect(screen.getByText('100%').closest('[aria-hidden="true"]')).not.toBeNull();
    expect(screen.getByText('Aug 25').closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('keys each legend entry to its band colour', () => {
    const { container } = renderChart();
    const swatches = container.querySelectorAll('ul rect');
    expect(swatches).toHaveLength(2);
    for (const [index, band] of BANDS.entries()) {
      expect(swatches[index]!.getAttribute('fill')).toBe(band.color);
    }
  });

  it('lists the band names in the legend with Others last', () => {
    renderChart();
    const legend = screen.getByRole('list', { name: 'Legend' });
    expect([...legend.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
      'One',
      'Others',
    ]);
  });

  it('renders a quiet placeholder instead of an empty chart when there are no bands', () => {
    render(<TrendChart bands={[]} ticks={[]} ariaLabel="chart" />);
    expect(screen.getByText('Not enough data yet')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Legend' })).not.toBeInTheDocument();
  });
});
