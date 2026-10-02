import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { DAY_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { HeadlineTiles, TREND_SPAN_NOTE } from './headline-tiles.js';
import { NO_MARGINAL_ROW_REASON } from './headline-figures.js';
import { dayOf } from './growth-window.js';
import type { HeadlineFigure } from './headline-figures.js';

/** The reference day is a Thursday, so its own week began three days earlier. */
const WEEK_START = TEST_DAY_START - 3 * DAY_MS;

const AVAILABLE: readonly HeadlineFigure[] = [
  {
    label: 'Accounts created',
    noun: 'Accounts created',
    bucketing: null,
    week: isoAt(WEEK_START),
    value: 41,
    unavailableReason: null,
    overflow: null,
    spark: [
      { week: isoAt(WEEK_START - 7 * DAY_MS), value: 10, overflow: null },
      { week: isoAt(WEEK_START), value: 41, overflow: null },
    ],
  },
];

const WITHHELD: readonly HeadlineFigure[] = [
  {
    label: 'Visitors (daily uniques, summed)',
    noun: 'Visitors',
    bucketing: 'daily',
    week: isoAt(WEEK_START),
    value: null,
    unavailableReason: NO_MARGINAL_ROW_REASON,
    overflow: null,
    spark: [],
  },
];

/** Carries a point no tile states, so {@link HeadlineTiles} writes it only in its table. */
const THREE_WEEKS: readonly HeadlineFigure[] = [
  {
    label: 'Visitors (daily uniques, summed)',
    noun: 'Visitors',
    bucketing: 'daily',
    week: isoAt(WEEK_START),
    value: 90,
    unavailableReason: null,
    overflow: false,
    spark: [
      { week: isoAt(WEEK_START - 14 * DAY_MS), value: 10, overflow: false },
      { week: isoAt(WEEK_START - 7 * DAY_MS), value: 55, overflow: false },
      { week: isoAt(WEEK_START), value: 90, overflow: false },
    ],
  },
];

/**
 * Two stated figures, one holding a point for a week the other has none for.
 * Built here rather than returned by `headlineFigures`: that producer binds its
 * in-scope rows once per call and maps every stated figure's trend from that one
 * binding, and {@link HeadlineTiles} draws a column only for a figure the page
 * stated, so the absence this case asserts appears in no table the page draws.
 * Every row of that table still gets a cell under every one of its columns, so
 * `valueAt` must return something for a week a figure holds no point in, and
 * what `valueAt` returns there is what this case pins.
 */
const UNEVEN_WEEKS: readonly HeadlineFigure[] = [
  ...THREE_WEEKS,
  {
    label: 'Accounts created',
    noun: 'Accounts created',
    bucketing: null,
    week: isoAt(WEEK_START),
    value: 41,
    unavailableReason: null,
    overflow: null,
    spark: [{ week: isoAt(WEEK_START), value: 41, overflow: null }],
  },
];

/** A figure read for the week on screen alone, which is one point and so no line. */
const ONE_WEEK: readonly HeadlineFigure[] = [
  {
    label: 'Visitors (daily uniques, summed)',
    noun: 'Visitors',
    bucketing: 'daily',
    week: isoAt(WEEK_START),
    value: 90,
    unavailableReason: null,
    overflow: false,
    spark: [{ week: isoAt(WEEK_START), value: 90, overflow: false }],
  },
];

describe('HeadlineTiles trend data', () => {
  it('states every point of a trend line in a real table', () => {
    render(<HeadlineTiles figures={THREE_WEEKS} />);
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(4);
  });

  it('states a point written nowhere else in the panel', () => {
    render(<HeadlineTiles figures={THREE_WEEKS} />);
    expect(within(screen.getByRole('table')).getByText('55')).toBeInTheDocument();
  });

  it('names the column with the figure its line trends', () => {
    render(<HeadlineTiles figures={THREE_WEEKS} />);
    expect(
      screen.getByRole('columnheader', { name: 'Visitors (daily uniques, summed)' })
    ).toBeInTheDocument();
  });

  it('names each row by the week it belongs to', () => {
    render(<HeadlineTiles figures={THREE_WEEKS} />);
    expect(
      screen.getByRole('rowheader', { name: dayOf(new Date(isoAt(WEEK_START - 7 * DAY_MS))) })
    ).toBeInTheDocument();
  });

  it('keeps the table out of sight until it is asked for', () => {
    const { container } = render(<HeadlineTiles figures={THREE_WEEKS} />);
    expect(container.querySelector('[data-slot="chart-data-table"]')).toHaveClass('sr-only');
  });

  it('shows the table when it is asked for', async () => {
    const { container } = render(<HeadlineTiles figures={THREE_WEEKS} />);
    await userEvent.click(screen.getByRole('button', { name: 'Show data' }));
    expect(container.querySelector('[data-slot="chart-data-table"]')).not.toHaveClass('sr-only');
  });

  it('names the shown table by what it holds, as its caption does', async () => {
    render(<HeadlineTiles figures={THREE_WEEKS} />);
    await userEvent.click(screen.getByRole('button', { name: 'Show data' }));
    expect(
      screen.getByRole('group', { name: 'Each figure week by week, as the lines above draw it' })
    ).toContainElement(screen.getByRole('table'));
  });

  it('says the tile figure is the week selected while the line covers more', () => {
    render(<HeadlineTiles figures={THREE_WEEKS} />);
    expect(screen.getByText(TREND_SPAN_NOTE)).toBeInTheDocument();
  });

  it('tells the reader that a figure counted for one week alone carries no line', () => {
    render(<HeadlineTiles figures={ONE_WEEK} />);
    expect(screen.getByText(TREND_SPAN_NOTE)).toHaveTextContent(
      'a figure counted for that one week alone carries none'
    );
  });

  it('renders no table when no tile has a trend to draw', () => {
    render(<HeadlineTiles figures={WITHHELD} />);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('states words, not a nought, for a week a figure it is handed holds no point in', () => {
    render(<HeadlineTiles figures={UNEVEN_WEEKS} />);
    const week = dayOf(new Date(isoAt(WEEK_START - 14 * DAY_MS)));
    const row = screen.getByRole('row', { name: new RegExp(week) });
    expect(within(row).getByText('No data')).toBeInTheDocument();
  });
});

describe('HeadlineTiles with a figure its ceiling cut off', () => {
  const CAPPED: readonly HeadlineFigure[] = [
    {
      label: 'Visitors (daily uniques, summed)',
      noun: 'Visitors',
      bucketing: 'daily',
      week: isoAt(WEEK_START),
      value: 100_000,
      unavailableReason: null,
      overflow: true,
      spark: [
        { week: isoAt(WEEK_START - 7 * DAY_MS), value: 90, overflow: false },
        { week: isoAt(WEEK_START), value: 100_000, overflow: true },
      ],
    },
  ];

  it('marks the tile figure as a floor', () => {
    const { container } = render(<HeadlineTiles figures={CAPPED} />);
    const tiles = container.querySelector('[data-slot="headline-tiles"]');
    if (tiles === null) throw new Error('no tile grid');
    expect(within(tiles as HTMLElement).getByText('100,000+')).toBeInTheDocument();
  });

  it('marks the same week as a floor in the table the lines are drawn from', () => {
    render(<HeadlineTiles figures={CAPPED} />);
    expect(within(screen.getByRole('table')).getByText('100,000+')).toBeInTheDocument();
  });

  it('leaves a week that counted inside its ceiling unmarked', () => {
    render(<HeadlineTiles figures={CAPPED} />);
    expect(within(screen.getByRole('table')).getByText('90')).toBeInTheDocument();
  });
});

/** The tile grid, which every tile shares a row height in. */
function tileGrid(container: HTMLElement): HTMLElement {
  const grid = container.querySelector<HTMLElement>('[data-slot="headline-tiles"]');
  if (grid === null) throw new Error('no tile grid');
  return grid;
}

describe('HeadlineTiles naming', () => {
  it('names a summed figure by its subject and states its bucketing beside it', () => {
    const { container } = render(<HeadlineTiles figures={THREE_WEEKS} />);
    const tiles = tileGrid(container);
    expect(within(tiles).getByText('Visitors')).toBeInTheDocument();
    expect(within(tiles).getByText('daily uniques, summed')).toBeInTheDocument();
  });

  it('gives an account figure no chip, there being no bucketing to state', () => {
    const { container } = render(<HeadlineTiles figures={AVAILABLE} />);
    expect(
      tileGrid(container).querySelector('[data-slot="headline-bucketing"]')
    ).not.toBeInTheDocument();
  });

  it('lets the bucketing chip shrink below the width of its own words', () => {
    const { container } = render(<HeadlineTiles figures={THREE_WEEKS} />);
    const chip = tileGrid(container).querySelector('[data-slot="headline-bucketing"]');
    expect(chip?.className).toContain('min-w-0');
  });

  it('breaks the longest word of the bucketing rather than drawing the chip past the tile', () => {
    const { container } = render(<HeadlineTiles figures={THREE_WEEKS} />);
    const chip = tileGrid(container).querySelector('[data-slot="headline-bucketing"]');
    expect(chip?.className).toContain('break-words');
  });

  it('keeps the chip one shape at every width, its shape being no part of what overflowed', () => {
    const { container } = render(<HeadlineTiles figures={THREE_WEEKS} />);
    const chip = tileGrid(container).querySelector('[data-slot="headline-bucketing"]');
    expect(chip?.className).toContain('rounded-full');
    expect(chip?.className).not.toContain('rounded-sm');
  });

  it('lets a figure’s noun shrink below the width of its own longest word', () => {
    const { container } = render(<HeadlineTiles figures={THREE_WEEKS} />);
    const noun = tileGrid(container).querySelector('[data-slot="headline-noun"]');
    expect(noun?.className).toContain('min-w-0');
  });

  it('breaks that word rather than drawing the noun past the line it sits on', () => {
    const { container } = render(<HeadlineTiles figures={THREE_WEEKS} />);
    const noun = tileGrid(container).querySelector('[data-slot="headline-noun"]');
    expect(noun?.className).toContain('break-words');
  });

  it('holds every tile to one height, so four figures are read off one baseline', () => {
    const { container } = render(<HeadlineTiles figures={UNEVEN_WEEKS} />);
    const grid = tileGrid(container);
    expect(grid.className).toContain('auto-rows-fr');
    // The shared row height reaches a tile only where the tile is the grid's
    // own item, one per figure.
    expect(
      [...grid.children].map((item) => (item instanceof HTMLElement ? item.dataset['slot'] : null))
    ).toEqual(UNEVEN_WEEKS.map(() => 'headline-tile'));
  });
});

describe('HeadlineTiles against the week before', () => {
  it('states the change and the day that week began', () => {
    const { container } = render(<HeadlineTiles figures={THREE_WEEKS} />);
    const said = `Up 35 from ${dayOf(new Date(isoAt(WEEK_START - 7 * DAY_MS)))}`;
    expect(within(tileGrid(container)).getByText(said)).toBeInTheDocument();
  });

  it('states a fall as a fall rather than as a signed number', () => {
    const fell: readonly HeadlineFigure[] = [
      {
        label: 'Accounts created',
        noun: 'Accounts created',
        bucketing: null,
        week: isoAt(WEEK_START),
        value: 30,
        unavailableReason: null,
        overflow: null,
        spark: [
          { week: isoAt(WEEK_START - 7 * DAY_MS), value: 41, overflow: null },
          { week: isoAt(WEEK_START), value: 30, overflow: null },
        ],
      },
    ];
    const { container } = render(<HeadlineTiles figures={fell} />);
    const said = `Down 11 from ${dayOf(new Date(isoAt(WEEK_START - 7 * DAY_MS)))}`;
    expect(within(tileGrid(container)).getByText(said)).toBeInTheDocument();
  });

  it('says so where the week before counted exactly as many', () => {
    const level: readonly HeadlineFigure[] = [
      {
        label: 'Accounts created',
        noun: 'Accounts created',
        bucketing: null,
        week: isoAt(WEEK_START),
        value: 41,
        unavailableReason: null,
        overflow: null,
        spark: [
          { week: isoAt(WEEK_START - 7 * DAY_MS), value: 41, overflow: null },
          { week: isoAt(WEEK_START), value: 41, overflow: null },
        ],
      },
    ];
    const { container } = render(<HeadlineTiles figures={level} />);
    const said = `No change from ${dayOf(new Date(isoAt(WEEK_START - 7 * DAY_MS)))}`;
    expect(within(tileGrid(container)).getByText(said)).toBeInTheDocument();
  });

  it('shows the figure alone where the week before holds no count', () => {
    const { container } = render(<HeadlineTiles figures={ONE_WEEK} />);
    expect(within(tileGrid(container)).queryByText(/^(Up|Down|No change)/)).not.toBeInTheDocument();
  });

  it('says in the panel when a change is stated, so its absence reads', () => {
    render(<HeadlineTiles figures={ONE_WEEK} />);
    expect(screen.getByText(TREND_SPAN_NOTE)).toHaveTextContent(
      'A change is stated where the week before holds a count of its own'
    );
  });
});

describe('HeadlineTiles', () => {
  it('states each figure with its label', () => {
    const { container } = render(<HeadlineTiles figures={AVAILABLE} />);
    const tiles = container.querySelector('[data-slot="headline-tiles"]');
    if (tiles === null) throw new Error('no tile grid');
    expect(within(tiles as HTMLElement).getByText('Accounts created')).toBeInTheDocument();
    expect(within(tiles as HTMLElement).getByText('41')).toBeInTheDocument();
  });

  it('groups thousands so a large figure stays readable', () => {
    const { container } = render(
      <HeadlineTiles
        figures={[
          {
            label: 'Visitors',
            noun: 'Visitors',
            bucketing: null,
            week: isoAt(WEEK_START),
            value: 1284,
            unavailableReason: null,
            overflow: false,
            spark: [{ week: isoAt(WEEK_START), value: 1284, overflow: false }],
          },
        ]}
      />
    );
    const tiles = container.querySelector<HTMLElement>('[data-slot="headline-tiles"]');
    if (tiles === null) throw new Error('no tile grid');
    expect(within(tiles).getByText('1,284')).toBeInTheDocument();
  });

  it('says a withheld figure is unavailable rather than showing a number', () => {
    render(<HeadlineTiles figures={WITHHELD} />);
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('gives the reason a withheld figure is not stated', () => {
    render(<HeadlineTiles figures={WITHHELD} />);
    expect(screen.getByText(NO_MARGINAL_ROW_REASON)).toBeInTheDocument();
  });

  it('draws a trend line beside a figure that has one', () => {
    const { container } = render(<HeadlineTiles figures={AVAILABLE} />);
    expect(container.querySelector('svg')).toBeInTheDocument();
  });
});
