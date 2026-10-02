import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DAY_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { Sparkline, sparklinePath } from './sparkline.js';
import type { HeadlinePoint } from './headline-figures.js';

/** The reference day is a Thursday, so its own week began three days earlier. */
const WEEK_START = TEST_DAY_START - 3 * DAY_MS;

const POINTS: readonly HeadlinePoint[] = [
  { week: isoAt(WEEK_START - 14 * DAY_MS), value: 0, overflow: null },
  { week: isoAt(WEEK_START - 7 * DAY_MS), value: 5, overflow: null },
  { week: isoAt(WEEK_START), value: 10, overflow: null },
];

describe('sparklinePath', () => {
  it('draws nothing for a single point, which has no trend', () => {
    expect(sparklinePath([POINTS[0]!])).toBeNull();
  });

  it('draws nothing when there are no points at all', () => {
    expect(sparklinePath([])).toBeNull();
  });

  it('starts at the left edge and ends at the right', () => {
    const path = sparklinePath(POINTS);
    expect(path).toMatch(/^M0\.0,/);
    expect(path).toContain('L120.0,');
  });

  it('puts the largest value at the top of the box', () => {
    expect(sparklinePath(POINTS)).toContain('L120.0,0.0');
  });

  it('puts the smallest value at the bottom of the box', () => {
    expect(sparklinePath(POINTS)).toMatch(/^M0\.0,24\.0/);
  });

  it('rests a flat series on the baseline rather than dividing by an empty range', () => {
    const path = sparklinePath([
      { week: 'a', value: 4, overflow: null },
      { week: 'b', value: 4, overflow: null },
    ]);
    expect(path).toBe('M0.0,24.0 L120.0,24.0');
  });
});

describe('Sparkline', () => {
  it('renders nothing when there is no trend to draw', () => {
    const { container } = render(<Sparkline points={[]} />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('hides the drawing from assistive technology, which reads the figure instead', () => {
    const { container } = render(<Sparkline points={POINTS} />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});
