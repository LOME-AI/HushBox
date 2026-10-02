import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DAY_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { CohortGrid } from './cohort-grid.js';
import { identifiedLadderColumns } from './funnel-math.js';
import { dayOf } from './growth-window.js';
import type { GrowthFunnelWeekWire } from '@hushbox/shared';

/** The reference day is a Thursday, so its own week began three days earlier. */
const WEEK_START = TEST_DAY_START - 3 * DAY_MS;

function week(over: Partial<GrowthFunnelWeekWire>): GrowthFunnelWeekWire {
  return {
    week: isoAt(WEEK_START),
    campaign: 'hn-launch',
    visitorsDailySummed: 0,
    visitorsOverflow: false,
    productEntryClicksHourlySummed: 0,
    productEntryClicksOverflow: false,
    started: 0,
    startedOverflow: false,
    finished: 40,
    verified: 30,
    activated: 20,
    returnedWeek1: 10,
    firstPaid: 5,
    revenueNanoUsd: '0',
    ...over,
  };
}

const WEEKS = [
  week({
    week: isoAt(WEEK_START - 7 * DAY_MS),
    finished: 20,
    verified: 15,
    activated: 10,
    returnedWeek1: 5,
    firstPaid: 2,
  }),
  week({ week: isoAt(WEEK_START) }),
];

/** The first cell of the first cohort row, which every cohort fills to 100%. */
function fullestCell(): HTMLElement {
  const cell = screen.getAllByRole('cell')[0];
  if (cell === undefined) throw new Error('the grid drew no cells');
  return cell;
}

describe('CohortGrid', () => {
  it('prints a shaded cell\u2019s share in the same foreground its count is printed in', () => {
    render(<CohortGrid weeks={WEEKS} />);
    const cell = fullestCell();
    const share = cell.querySelector('span');
    expect(cell.className).toContain('bg-seq-5');
    expect(cell.className).toContain('text-seq-foreground');
    expect(share?.className).not.toMatch(/text-(muted-)?foreground/);
  });

  it('separates one cell from the next, so a shade reads as its own cell', () => {
    render(<CohortGrid weeks={WEEKS} />);
    expect(screen.getByRole('table').className).toContain('border-separate');
    expect(screen.getByRole('table').className).toContain('border-spacing-0.5');
  });

  it('keys the ramp it shades with, without asking for a press', () => {
    const { container } = render(<CohortGrid weeks={WEEKS} />);
    const legend = container.querySelector('[data-slot="cohort-legend"]');
    expect(legend).toHaveTextContent(/Share of the cohort/);
    expect(legend).toHaveTextContent(/0% to 100%/);
  });

  it('keys the outline it draws where a cohort has no share, in the same legend', () => {
    const { container } = render(<CohortGrid weeks={WEEKS} />);
    expect(container.querySelector('[data-slot="cohort-legend"]')).toHaveTextContent(
      /No share to take/
    );
  });

  it('renders the cohorts as a real table', () => {
    render(<CohortGrid weeks={WEEKS} />);
    expect(screen.getByRole('table')).toBeInTheDocument();
  });

  it('gives each creation week its own row', () => {
    render(<CohortGrid weeks={WEEKS} />);
    expect(
      screen.getByRole('rowheader', { name: dayOf(new Date(isoAt(WEEK_START - 7 * DAY_MS))) })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('rowheader', { name: dayOf(new Date(isoAt(WEEK_START))) })
    ).toBeInTheDocument();
  });

  it('orders the cohorts oldest first', () => {
    render(<CohortGrid weeks={WEEKS} />);
    const headers = screen.getAllByRole('rowheader').map((cell) => cell.textContent);
    expect(headers).toEqual([
      dayOf(new Date(isoAt(WEEK_START - 7 * DAY_MS))),
      dayOf(new Date(isoAt(WEEK_START))),
    ]);
  });

  it('names the account steps as its columns', () => {
    render(<CohortGrid weeks={WEEKS} />);
    expect(screen.getByRole('columnheader', { name: 'Account created' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Returned week 1' })).toBeInTheDocument();
  });

  it('states each cell as a count, never only as a shade', () => {
    render(<CohortGrid weeks={WEEKS} />);
    expect(screen.getByRole('cell', { name: /^40/ })).toBeInTheDocument();
  });

  it('states each cell as a share of its own cohort', () => {
    render(<CohortGrid weeks={WEEKS} />);
    expect(screen.getByRole('cell', { name: /12\.5%/ })).toBeInTheDocument();
  });

  it('adds a cohort week that only some campaigns have rows for', () => {
    render(
      <CohortGrid
        weeks={[week({ campaign: 'a', finished: 10 }), week({ campaign: 'b', finished: 5 })]}
      />
    );
    expect(screen.getByRole('cell', { name: /^15/ })).toBeInTheDocument();
  });

  it('marks no cell a floor, because every column it names counts accounts', () => {
    render(
      <CohortGrid
        weeks={[week({ visitorsOverflow: true, productEntryClicksOverflow: true, finished: 40 })]}
      />
    );
    expect(screen.getByRole('cell', { name: /^40/ })).toBeInTheDocument();
    expect(screen.queryByText(/\d\+/)).not.toBeInTheDocument();
  });

  it('says nothing was counted when there are no cohorts', () => {
    render(<CohortGrid weeks={[]} />);
    expect(screen.getByText(/No cohorts/i)).toBeInTheDocument();
  });
});

describe('CohortGrid with an empty cohort', () => {
  it('says there is no rate rather than dividing by a cohort of nobody', () => {
    render(
      <CohortGrid
        weeks={[
          week({
            finished: 0,
            verified: 0,
            activated: 0,
            returnedWeek1: 0,
            firstPaid: 0,
          }),
        ]}
      />
    );
    expect(screen.getAllByText('No rate')).toHaveLength(5);
  });

  it('outlines the cell rather than shading it, absence being no step of the ramp', () => {
    render(
      <CohortGrid
        weeks={[
          week({
            finished: 0,
            verified: 0,
            activated: 0,
            returnedWeek1: 0,
            firstPaid: 0,
          }),
        ]}
      />
    );
    for (const cell of screen.getAllByRole('cell')) {
      expect(cell.className).toContain('border-dashed');
      expect(cell.className).not.toMatch(/bg-seq-/);
    }
  });

  it('keeps both words of an absent rate on one line in a column this narrow', () => {
    render(
      <CohortGrid
        weeks={[
          week({
            finished: 0,
            verified: 0,
            activated: 0,
            returnedWeek1: 0,
            firstPaid: 0,
          }),
        ]}
      />
    );
    for (const said of screen.getAllByText('No rate')) {
      expect(said).toHaveClass('whitespace-nowrap');
    }
  });
});

describe('CohortGrid column names', () => {
  it('names its columns as the ladder names its account-counting steps', () => {
    render(<CohortGrid weeks={[week({})]} />);
    const headers = screen
      .getAllByRole('columnheader')
      .map((header) => header.textContent)
      .slice(1);
    expect(headers).toEqual(identifiedLadderColumns().map((column) => column.label));
  });
});

describe('CohortGrid scrollport', () => {
  /** The box the table scrolls inside, which is the table's own parent. */
  function scrollport(): HTMLElement {
    const port = screen.getByRole('table').parentElement;
    if (port === null) throw new Error('the table has no scrollport');
    return port;
  }

  it('makes the box the table scrolls inside a tab stop, there being nothing else in it to focus', () => {
    render(<CohortGrid weeks={WEEKS} />);
    expect(scrollport()).toHaveAttribute('tabindex', '0');
  });

  it('names that tab stop with the same sentence the table is captioned by', () => {
    render(<CohortGrid weeks={WEEKS} />);
    const caption = screen.getByRole('table').querySelector('caption');
    expect(scrollport()).toHaveAttribute('aria-label', caption?.textContent);
  });

  it('shows the keyboard where the focus went', () => {
    render(<CohortGrid weeks={WEEKS} />);
    expect(scrollport().className).toContain('focus-visible:ring-2');
  });

  // The grid's spaced cells stop short of the box's corners, so the rounding
  // clips nothing.
  it('draws the box rounded, its own shape rather than the scroll region’s', () => {
    render(<CohortGrid weeks={WEEKS} />);
    expect(scrollport()).toHaveClass('rounded-sm');
  });

  // The cells' visually hidden separators are absolutely positioned; a box that
  // is not their containing block cannot clip them, and they widen the page.
  it('is the containing block of the hidden text inside it', () => {
    render(<CohortGrid weeks={WEEKS} />);
    expect(scrollport()).toHaveClass('relative');
  });
});

describe('CohortGrid column sizing', () => {
  it('offers a line break between every cell’s count and its share', () => {
    render(<CohortGrid weeks={WEEKS} />);
    const cells = screen.getAllByRole('cell');
    expect(cells).toHaveLength(10);
    for (const cell of cells) {
      const wbr = cell.querySelector('wbr');
      expect(wbr?.previousSibling?.nodeType).toBe(Node.TEXT_NODE);
      expect(wbr?.nextElementSibling).toBe(cell.querySelector('span'));
    }
  });

  it('sizes every step’s heading to its longest word', () => {
    render(<CohortGrid weeks={WEEKS} />);
    const steps = screen.getAllByRole('columnheader').slice(1);
    expect(steps).toHaveLength(identifiedLadderColumns().length);
    for (const heading of steps) {
      const label = heading.firstElementChild;
      expect(label).toHaveClass('inline-block', 'w-min');
      expect(label?.textContent).toBe(heading.textContent);
    }
  });
});

describe('CohortGrid spoken cells', () => {
  // Name computation pads the separator with a space before its comma, as a
  // browser does for a visually hidden element, so the figures are matched
  // across the comma rather than against one spacing of it.
  it('names a cell by its count and its share as two figures', () => {
    render(<CohortGrid weeks={WEEKS} />);
    expect(fullestCell()).toHaveAccessibleName(/^20\s*,\s*100\.0%$/);
  });

  it('names an empty cohort’s cell by its count and the absent rate as two statements', () => {
    render(
      <CohortGrid
        weeks={[
          week({
            finished: 0,
            verified: 0,
            activated: 0,
            returnedWeek1: 0,
            firstPaid: 0,
          }),
        ]}
      />
    );
    expect(fullestCell()).toHaveAccessibleName(/^0\s*,\s*No rate$/);
  });

  it('keeps the separator out of what the cell shows', () => {
    render(<CohortGrid weeks={WEEKS} />);
    const share = fullestCell().querySelector('span');
    expect(share?.firstElementChild).toHaveClass('sr-only');
  });
});
