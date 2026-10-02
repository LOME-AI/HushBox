import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DAY_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { VisitorsPanel } from './visitors-panel.js';

// Its own file because the panel's other tests stub recharts' responsive
// container, and the container's first render is what this one is about.

/** The console line recharts prints when a plot renders before it has a size. */
const UNSIZED_PLOT_WARNING = 'should be greater than 0';

/** The box a laid-out screen gives the plot, which the test DOM cannot compute. */
const LAID_OUT_BOX = new DOMRect(0, 0, 800, 220);

const POINTS = [
  { bucket: isoAt(TEST_DAY_START), visitors: 100, overflow: false },
  { bucket: isoAt(TEST_DAY_START + DAY_MS), visitors: 140, overflow: false },
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('VisitorsPanel before its plot is measured', () => {
  it('draws its first frame without the console warning of an unsized plot', () => {
    // Every later render reads this box, so any warning left is the one only a
    // render before the first measurement can print.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(LAID_OUT_BOX);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<VisitorsPanel points={POINTS} grain="day" />);
    const unsized = warn.mock.calls.filter(([message]) =>
      String(message).includes(UNSIZED_PLOT_WARNING)
    );
    expect(unsized).toEqual([]);
  });
});
