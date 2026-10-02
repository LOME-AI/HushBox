import { describe, it, expect } from 'vitest';
import { render, within } from '@testing-library/react';
import { TEST_IDS } from '@hushbox/shared';
import { ContextGauge } from '@/components/chat/input/context-gauge';
import type { ContextFillBand } from '@hushbox/shared';

function renderGauge(used: number, capacity: number, band: ContextFillBand): HTMLElement {
  const { container } = render(<ContextGauge used={used} capacity={capacity} band={band} />);
  return within(container).getByRole('meter', { name: 'Context used' });
}

function fills(gauge: HTMLElement): string[] {
  return [...gauge.querySelectorAll<HTMLElement>('[data-slot="context-gauge-fill"]')].map(
    (fill) => fill.style.width
  );
}

describe('ContextGauge', () => {
  it('is a meter named "Context used"', () => {
    const gauge = renderGauge(120, 1000, 'room_to_spare');

    expect(gauge).toBeInTheDocument();
  });

  it('shows the label "Context"', () => {
    const gauge = renderGauge(120, 1000, 'room_to_spare');

    expect(gauge.querySelector('[data-slot="context-gauge-label"]')?.textContent).toBe('Context');
  });

  it('shows the share of the context used as a whole percent', () => {
    const gauge = renderGauge(126, 1000, 'room_to_spare');

    expect(gauge.querySelector('[data-slot="context-gauge-value"]')?.textContent).toBe('13%');
  });

  it('reads its value out as the percent and the band', () => {
    const gauge = renderGauge(126, 1000, 'room_to_spare');

    expect(gauge).toHaveAttribute('aria-valuetext', '13%, room to spare');
  });

  it('names each band in its value text', () => {
    expect(renderGauge(500, 1000, 'filling_up')).toHaveAttribute(
      'aria-valuetext',
      '50%, filling up'
    );
    expect(renderGauge(800, 1000, 'nearly_full')).toHaveAttribute(
      'aria-valuetext',
      '80%, nearly full'
    );
  });

  it('reports the percent as its value, out of 100', () => {
    const gauge = renderGauge(126, 1000, 'room_to_spare');

    expect(gauge).toHaveAttribute('aria-valuenow', '13');
    expect(gauge).toHaveAttribute('aria-valuemin', '0');
    expect(gauge).toHaveAttribute('aria-valuemax', '100');
  });

  it('raises its maximum to a reading past 100, so the value never exceeds it', () => {
    const gauge = renderGauge(1160, 1000, 'nearly_full');

    expect(gauge).toHaveAttribute('aria-valuenow', '116');
    expect(gauge).toHaveAttribute('aria-valuemax', '116');
  });

  // 66.6% rounds to 67%, past the red line on the rounded figure only. The band
  // handed in is the money layer's verdict on the unrounded one.
  it('takes its band from the verdict it is given, not from the percent it shows', () => {
    const gauge = renderGauge(666, 1000, 'filling_up');

    expect(gauge).toHaveAttribute('data-band', 'filling');
    expect(gauge).toHaveAttribute('aria-valuetext', '67%, filling up');
  });

  it('marks each band for its fill colour', () => {
    expect(renderGauge(10, 1000, 'room_to_spare')).toHaveAttribute('data-band', 'room');
    expect(renderGauge(500, 1000, 'filling_up')).toHaveAttribute('data-band', 'filling');
    expect(renderGauge(800, 1000, 'nearly_full')).toHaveAttribute('data-band', 'full');
  });

  it('fills the first third three times as fast as the whole', () => {
    const gauge = renderGauge(180, 1000, 'room_to_spare');

    expect(fills(gauge)).toEqual(['54%', '0%', '0%']);
  });

  it('fills the thirds in order, each full before the next starts', () => {
    const gauge = renderGauge(750, 1000, 'nearly_full');

    expect(fills(gauge)).toEqual(['100%', '100%', '25%']);
  });

  it('fills every third, and no further, past the whole window', () => {
    const gauge = renderGauge(1160, 1000, 'nearly_full');

    expect(fills(gauge)).toEqual(['100%', '100%', '100%']);
  });

  it('hides its bar from assistive technology, which reads the value text instead', () => {
    const gauge = renderGauge(120, 1000, 'room_to_spare');

    expect(gauge.querySelector('[data-slot="context-gauge-bar"]')).toHaveAttribute(
      'aria-hidden',
      'true'
    );
  });

  it('lays a solid system canvas under its words in forced colours, so the border never runs through them', () => {
    const gauge = renderGauge(120, 1000, 'room_to_spare');

    expect(gauge).toHaveClass('forced-colors:bg-[Canvas]');
  });

  it('draws its bar in system colours in forced colours, where its tints would vanish', () => {
    const gauge = renderGauge(120, 1000, 'room_to_spare');

    const bar = gauge.querySelector('[data-slot="context-gauge-bar"]');
    expect(bar).toHaveClass('forced-colors:forced-color-adjust-none');
    for (const third of bar?.children ?? []) {
      expect(third).toHaveClass('forced-colors:bg-[GrayText]');
    }
    for (const fill of gauge.querySelectorAll('[data-slot="context-gauge-fill"]')) {
      expect(fill).toHaveClass('forced-colors:bg-[CanvasText]');
    }
  });

  it('clears its two-tone fill on hover, so the accent tints the whole pill', () => {
    const gauge = renderGauge(120, 1000, 'room_to_spare');

    expect(gauge).toHaveClass('hover:bg-accent', 'hover:bg-none');
  });

  it('carries the capacity bar test id', () => {
    const gauge = renderGauge(120, 1000, 'room_to_spare');

    expect(gauge).toHaveAttribute('data-testid', TEST_IDS.capacityBar);
  });
});
