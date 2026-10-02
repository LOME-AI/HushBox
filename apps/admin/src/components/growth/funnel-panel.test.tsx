import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { FunnelPanel } from './funnel-panel.js';
import type { GrowthFunnelWeekWire } from '@hushbox/shared';

/**
 * The bars alone. The panel draws a second list beside them — the legend keying
 * how a bar is filled — so a count of every list item on the panel is not a
 * count of the ladder's steps.
 */
function ladder(container: HTMLElement): HTMLElement {
  const found = container.querySelector<HTMLElement>('[data-slot="funnel-ladder"]');
  if (found === null) throw new Error('the panel drew no ladder');
  return found;
}

const WEEK: GrowthFunnelWeekWire = {
  week: isoAt(TEST_DAY_START),
  campaign: 'hn-launch',
  visitorsDailySummed: 1284,
  visitorsOverflow: false,
  productEntryClicksHourlySummed: 143,
  productEntryClicksOverflow: false,
  started: 97,
  startedOverflow: false,
  finished: 41,
  verified: 36,
  activated: 29,
  returnedWeek1: 17,
  firstPaid: 6,
  revenueNanoUsd: '184000000000',
};

describe('FunnelPanel', () => {
  it('names the campaign the ladder belongs to', () => {
    render(<FunnelPanel week={WEEK} />);
    expect(screen.getByText('Campaign: hn-launch')).toBeInTheDocument();
  });

  it('draws a bar for every step of the ladder', () => {
    const { container } = render(<FunnelPanel week={WEEK} />);
    expect(within(ladder(container)).getAllByRole('listitem')).toHaveLength(8);
  });

  it('states each step count beside its bar', () => {
    render(<FunnelPanel week={WEEK} />);
    const bar = screen.getByRole('listitem', { name: /Account created/ });
    expect(within(bar).getByText('41')).toBeInTheDocument();
  });

  it('states each step\u2019s cumulative rate beside its bar', () => {
    render(<FunnelPanel week={WEEK} />);
    const bar = screen.getByRole('listitem', { name: /Account created/ });
    expect(within(bar).getByText('3.2%')).toBeInTheDocument();
  });

  it('keeps a step\u2019s whole label on screen rather than cutting its qualifier', () => {
    render(<FunnelPanel week={WEEK} />);
    const bar = screen.getByRole('listitem', { name: /Visited/ });
    const label = within(bar).getByText('Visited (daily uniques, summed)');
    expect(label.className).not.toContain('truncate');
  });

  it('draws no bar at all for a step counted at zero', () => {
    render(<FunnelPanel week={{ ...WEEK, verified: 0 }} />);
    const bar = screen.getByRole('listitem', { name: /Email verified/ });
    const drawn = bar.querySelector('[data-slot="funnel-bar-fill"]');
    expect(drawn).toHaveStyle({ width: '0%' });
  });

  it('shows the ladder\u2019s own table when the control is pressed', async () => {
    const { container } = render(<FunnelPanel week={WEEK} />);
    expect(container.querySelector('[data-slot="chart-data-table"]')).toHaveClass('sr-only');
    await userEvent.click(screen.getByRole('button', { name: 'Show data' }));
    expect(container.querySelector('[data-slot="chart-data-table"]')).not.toHaveClass('sr-only');
  });

  it('names the shown ladder table by what it holds, as its caption does', async () => {
    render(<FunnelPanel week={WEEK} />);
    await userEvent.click(screen.getByRole('button', { name: 'Show data' }));
    expect(
      screen.getByRole('group', { name: 'Registration ladder for hn-launch' })
    ).toContainElement(screen.getByRole('table'));
  });

  it('gives every bar keyboard focus', () => {
    const { container } = render(<FunnelPanel week={WEEK} />);
    for (const bar of within(ladder(container)).getAllByRole('listitem')) {
      expect(bar).toHaveAttribute('tabindex', '0');
    }
  });

  it("hides each bar's browser outline only while it has keyboard focus", () => {
    const { container } = render(<FunnelPanel week={WEEK} />);
    const bars = within(ladder(container)).getAllByRole('listitem');
    expect(bars.length).toBeGreaterThan(0);
    expect(
      new Set(
        bars.map((bar) =>
          [...bar.classList].filter((token) => /(^|:)outline-(none|hidden)$/.test(token)).join(' ')
        )
      )
    ).toEqual(new Set(['focus-visible:outline-hidden']));
  });

  it('reads the step and cumulative rates into the bar name', () => {
    render(<FunnelPanel week={WEEK} />);
    const bar = screen.getByRole('listitem', { name: /Account created/ });
    expect(bar.getAttribute('aria-label')).toContain('42.3% of the step above');
    expect(bar.getAttribute('aria-label')).toContain('3.2% of the top');
  });

  it('states no rate for the top step, which has nothing above it', () => {
    render(<FunnelPanel week={WEEK} />);
    const bar = screen.getByRole('listitem', { name: /Visited/ });
    expect(bar.getAttribute('aria-label')).not.toContain('of the step above');
  });

  it('marks the anonymous steps so they are told apart by more than colour', () => {
    render(<FunnelPanel week={WEEK} />);
    const anonymous = screen.getByRole('listitem', { name: /Visited/ });
    const identified = screen.getByRole('listitem', { name: /Account created/ });
    expect(anonymous.getAttribute('aria-label')).toContain('summed');
    expect(identified.getAttribute('aria-label')).not.toContain('summed');
  });

  it('labels the visited step with the same wording the summed columns use', () => {
    render(<FunnelPanel week={WEEK} />);
    expect(screen.getAllByText('Visited (daily uniques, summed)').length).toBeGreaterThan(0);
  });

  it('labels the product-entry step for every destination it counts', () => {
    render(<FunnelPanel week={WEEK} />);
    expect(
      screen.getAllByText('Clicked into the product (hourly uniques, summed)').length
    ).toBeGreaterThan(0);
  });

  it('leaves the account steps unqualified, because they are not summed', () => {
    render(<FunnelPanel week={WEEK} />);
    expect(screen.getAllByText('Account created').length).toBeGreaterThan(0);
  });

  it('names the registration step with the bucketing that produced it', () => {
    render(<FunnelPanel week={WEEK} />);
    expect(
      screen.getAllByText('Started registration (hourly uniques, summed)').length
    ).toBeGreaterThan(0);
  });

  it('says in the caption what a bucket with several rows keeps', () => {
    render(<FunnelPanel week={WEEK} />);
    expect(screen.getByText(/largest/i)).toBeInTheDocument();
  });

  it('says in the caption that a bucket holds a row per event name as well as per page', () => {
    render(<FunnelPanel week={WEEK} />);
    expect(screen.getByText(/event name/i)).toBeInTheDocument();
  });

  it('says in the caption that the summed steps are a lower bound', () => {
    render(<FunnelPanel week={WEEK} />);
    expect(screen.getByRole('figure').querySelector('figcaption')).toHaveTextContent(
      /lower bound/i
    );
  });

  it('names the biggest drop in the caption', () => {
    render(<FunnelPanel week={WEEK} />);
    expect(
      screen.getByText(/Biggest drop: Visited . Clicked into the product/)
    ).toBeInTheDocument();
  });

  it('states the cohort revenue in the caption', () => {
    render(<FunnelPanel week={WEEK} />);
    expect(screen.getByText(/\$184\.00/)).toBeInTheDocument();
  });

  it('offers the ladder as a real table', () => {
    render(<FunnelPanel week={WEEK} />);
    expect(screen.getByRole('table')).toBeInTheDocument();
  });
});

/** A bar's own fill, which carries the encoding its step's kind is drawn in. */
function fillOf(name: RegExp): HTMLElement {
  const bar = screen.getByRole('listitem', { name });
  const fill = bar.querySelector<HTMLElement>('[data-slot="funnel-bar-fill"]');
  if (fill === null) throw new Error('the bar drew no fill');
  return fill;
}

describe('FunnelPanel bar encoding', () => {
  it('draws an account-identified step at the ramp\u2019s full strength', () => {
    render(<FunnelPanel week={WEEK} />);
    expect(fillOf(/Account created/).className).toContain('bg-seq-5');
  });

  it('hatches an anonymous step, whose count is a lower bound', () => {
    render(<FunnelPanel week={WEEK} />);
    expect(fillOf(/Visited/).className).toContain('repeating-linear-gradient');
  });

  it('draws the hatch out of the same ramp the solid bars come from', () => {
    render(<FunnelPanel week={WEEK} />);
    expect(fillOf(/Visited/).className).toContain('--seq-');
  });

  it('ticks a step counted at zero, so nobody reached it reads as a reading', () => {
    render(<FunnelPanel week={{ ...WEEK, verified: 0 }} />);
    const bar = screen.getByRole('listitem', { name: /Email verified/ });
    expect(bar.querySelector('[data-slot="funnel-bar-zero"]')).toBeInTheDocument();
  });

  it('ticks no step that counted somebody', () => {
    render(<FunnelPanel week={WEEK} />);
    const bar = screen.getByRole('listitem', { name: /Account created/ });
    expect(bar.querySelector('[data-slot="funnel-bar-zero"]')).not.toBeInTheDocument();
  });
});

describe('FunnelPanel biggest drop', () => {
  it('marks the rate of the step the most people fell out before', () => {
    render(<FunnelPanel week={WEEK} />);
    const bar = screen.getByRole('listitem', { name: /Clicked into the product/ });
    expect(bar.querySelector('[data-slot="funnel-biggest-drop"]')).toHaveTextContent('11.1%');
  });

  it('marks that one rate and no other on the ladder', () => {
    const { container } = render(<FunnelPanel week={WEEK} />);
    expect(container.querySelectorAll('[data-slot="funnel-biggest-drop"]')).toHaveLength(1);
  });

  it('marks nothing where no drop could be measured', () => {
    const empty = {
      ...WEEK,
      visitorsDailySummed: 0,
      productEntryClicksHourlySummed: 0,
      started: 0,
    };
    const { container } = render(
      <FunnelPanel
        week={{ ...empty, finished: 0, verified: 0, activated: 0, returnedWeek1: 0, firstPaid: 0 }}
      />
    );
    expect(container.querySelectorAll('[data-slot="funnel-biggest-drop"]')).toHaveLength(0);
  });
});

describe('FunnelPanel legend', () => {
  it('keys each of the three ways a bar is drawn, without asking for a press', () => {
    const { container } = render(<FunnelPanel week={WEEK} />);
    const legend = container.querySelector('[data-slot="funnel-legend"]');
    expect(legend).toHaveTextContent(/Account-identified step/);
    expect(legend).toHaveTextContent(/Anonymous step/);
    expect(legend).toHaveTextContent(/Counted zero/);
  });

  it('keys the mark the biggest drop wears, in the same legend', () => {
    const { container } = render(<FunnelPanel week={WEEK} />);
    expect(container.querySelector('[data-slot="funnel-legend"]')).toHaveTextContent(
      /Biggest drop/
    );
  });
});

describe('FunnelPanel row shape', () => {
  it('lets the step column shrink rather than holding the row wider than its panel', () => {
    render(<FunnelPanel week={WEEK} />);
    const bar = screen.getByRole('listitem', { name: /Visited/ });
    expect(bar.className).toContain('minmax(0,14rem)');
    expect(bar.className).not.toContain('minmax(8rem');
  });

  it('gives every cell a row of its own where the five columns will not fit', () => {
    render(<FunnelPanel week={WEEK} />);
    const bar = screen.getByRole('listitem', { name: /Visited/ });
    expect(bar.className).toContain('grid-cols-1');
    expect(bar.className).toContain('sm:grid-cols-[minmax(0,14rem)');
    expect(bar.className).not.toContain('1.4fr');
  });

  it('spans no cell across that shape, a spanned cell being what would share a line', () => {
    render(<FunnelPanel week={WEEK} />);
    const bar = screen.getByRole('listitem', { name: /Visited/ });
    for (const cell of bar.children) expect(cell.className).not.toContain('col-span');
  });

  it('keeps a floor under the bar, so the figures cannot take the whole row', () => {
    render(<FunnelPanel week={WEEK} />);
    const bar = screen.getByRole('listitem', { name: /Visited/ });
    expect(bar.className).toContain('minmax(2rem,1fr)');
  });

  it('gives each stacked figure the word naming it, no heading row sitting over it', () => {
    render(<FunnelPanel week={WEEK} />);
    const bar = screen.getByRole('listitem', { name: /Account created/ });
    /** The figure sharing a cell with the word, which is the figure that word names. */
    const figureNamed = (word: string): string | null | undefined =>
      within(bar).getByText(word).parentElement?.querySelector('[data-slot="funnel-figure"]')
        ?.textContent;
    expect(figureNamed('Count')).toBe('41');
    expect(figureNamed('Step rate')).toBe('42.3%');
    expect(figureNamed('Cumulative rate')).toBe('3.2%');
  });

  it('drops those words where the heading row carries them instead', () => {
    render(<FunnelPanel week={WEEK} />);
    const bar = screen.getByRole('listitem', { name: /Visited/ });
    expect(within(bar).getByText('Count').className).toContain('sm:hidden');
  });

  it('draws the heading row only where its words have figures to sit over', () => {
    const { container } = render(<FunnelPanel week={WEEK} />);
    const heading = container.querySelector('[data-slot="funnel-heading"]');
    expect(heading?.className).toContain('hidden');
    expect(heading?.className).toContain('sm:grid');
  });

  it('draws the words over the figures on the same tracks the figures sit in', () => {
    const { container } = render(<FunnelPanel week={WEEK} />);
    const heading = container.querySelector('[data-slot="funnel-heading"]');
    const bar = screen.getByRole('listitem', { name: /Visited/ });
    expect(heading?.className).toContain('sm:grid-cols-[minmax(0,14rem)');
    expect(bar.className).toContain('sm:grid-cols-[minmax(0,14rem)');
  });
});

describe('FunnelPanel with a step its ceiling cut off', () => {
  const CAPPED: GrowthFunnelWeekWire = { ...WEEK, visitorsOverflow: true };

  it('marks the figure beside the bar as a floor', () => {
    render(<FunnelPanel week={CAPPED} />);
    const bar = screen.getByRole('listitem', { name: /Visited/ });
    expect(within(bar).getByText('1,284+')).toBeInTheDocument();
  });

  it('says in the bar’s own name that the ceiling was reached', () => {
    render(<FunnelPanel week={CAPPED} />);
    const bar = screen.getByRole('listitem', { name: /Visited/ });
    expect(bar.getAttribute('aria-label')).toContain('Ceiling reached');
  });

  it('marks the same figure as a floor in the table a reader gets instead of the bars', () => {
    render(<FunnelPanel week={CAPPED} />);
    const table = screen.getByRole('table');
    expect(within(table).getByText('1,284+')).toBeInTheDocument();
  });

  it('leaves a step whose ceiling was not reached unmarked', () => {
    render(<FunnelPanel week={CAPPED} />);
    const bar = screen.getByRole('listitem', { name: /Clicked into the product/ });
    expect(within(bar).getByText('143')).toBeInTheDocument();
    expect(bar.getAttribute('aria-label')).not.toContain('Ceiling reached');
  });

  it('leaves a step with no flag to read unmarked, claiming nothing either way', () => {
    render(<FunnelPanel week={CAPPED} />);
    const bar = screen.getByRole('listitem', { name: /Account created/ });
    expect(within(bar).getByText('41')).toBeInTheDocument();
    expect(bar.getAttribute('aria-label')).not.toContain('Ceiling reached');
  });

  it('leaves the started step unmarked while its own flag is down', () => {
    render(<FunnelPanel week={CAPPED} />);
    const bar = screen.getByRole('listitem', { name: /Started registration/ });
    expect(within(bar).getByText('97')).toBeInTheDocument();
    expect(bar.getAttribute('aria-label')).not.toContain('Ceiling reached');
  });
});

describe('FunnelPanel with the registration-start ceiling reached', () => {
  const CAPPED_STARTS: GrowthFunnelWeekWire = { ...WEEK, startedOverflow: true };

  it('marks the figure beside the started bar as a floor', () => {
    render(<FunnelPanel week={CAPPED_STARTS} />);
    const bar = screen.getByRole('listitem', { name: /Started registration/ });
    expect(within(bar).getByText('97+')).toBeInTheDocument();
  });

  it('says in the started bar’s own name that the ceiling was reached', () => {
    render(<FunnelPanel week={CAPPED_STARTS} />);
    const bar = screen.getByRole('listitem', { name: /Started registration/ });
    expect(bar.getAttribute('aria-label')).toContain('Ceiling reached');
  });

  it('marks the started figure as a floor in the table a reader gets instead of the bars', () => {
    render(<FunnelPanel week={CAPPED_STARTS} />);
    const table = screen.getByRole('table');
    expect(within(table).getByText('97+')).toBeInTheDocument();
  });
});

/** What the panel says in words wherever a ceiling cut one of a rate's counts. */
const NOTE = 'a ceiling cut an input to this rate, so it may be high or low';

describe('FunnelPanel rates built from a count a ceiling cut', () => {
  const TOP_CAPPED: GrowthFunnelWeekWire = { ...WEEK, visitorsOverflow: true };

  it('marks the rate beside the bar whose counts a ceiling cut', () => {
    render(<FunnelPanel week={TOP_CAPPED} />);
    const bar = screen.getByRole('listitem', { name: /Clicked into the product/ });
    // The second step is one step below the top, so its step rate and its
    // cumulative rate are the same figure, and the mark is owed on both.
    expect(within(bar).getAllByText('11.1%*')).toHaveLength(2);
  });

  it('says in the bar\u2019s own name that the rate may be high or low', () => {
    render(<FunnelPanel week={TOP_CAPPED} />);
    const bar = screen.getByRole('listitem', { name: /Clicked into the product/ });
    expect(bar.getAttribute('aria-label')).toContain(`11.1% of the step above (${NOTE})`);
  });

  it('says in words in the table what a marked cumulative rate leaves open', () => {
    render(<FunnelPanel week={TOP_CAPPED} />);
    const row = within(screen.getByRole('table')).getByRole('row', { name: /Account created/ });
    expect(within(row).getByText(`3.2% (${NOTE})`)).toBeInTheDocument();
  });

  it('leaves a table rate whose own counts were whole saying only the number', () => {
    render(<FunnelPanel week={TOP_CAPPED} />);
    const row = within(screen.getByRole('table')).getByRole('row', { name: /Account created/ });
    expect(within(row).getByText('42.3%')).toBeInTheDocument();
  });

  it('marks the biggest-drop figure in the caption', () => {
    render(<FunnelPanel week={TOP_CAPPED} />);
    expect(
      screen.getByText(/Biggest drop: Visited . Clicked into the product \(11\.1%\*\)\./)
    ).toBeInTheDocument();
  });

  it('explains the marker exactly once on the panel', () => {
    render(<FunnelPanel week={TOP_CAPPED} />);
    expect(screen.getAllByText(/Rates marked \* had an input cut by a ceiling/)).toHaveLength(1);
  });

  it('leaves a reader able to suspect abuse rather than popularity behind a ceiling', () => {
    render(<FunnelPanel week={TOP_CAPPED} />);
    expect(screen.getByText(/under abuse sooner than under popularity/)).toBeInTheDocument();
  });
});

describe('FunnelPanel where a capped rate lost the biggest-drop comparison', () => {
  const MIDDLE_CAPPED: GrowthFunnelWeekWire = { ...WEEK, startedOverflow: true };

  it('marks the step rate beside the bar whose own count a ceiling cut', () => {
    render(<FunnelPanel week={MIDDLE_CAPPED} />);
    const bar = screen.getByRole('listitem', { name: /Started registration/ });
    expect(within(bar).getByText('67.8%*')).toBeInTheDocument();
  });

  it('says in words in the table what a marked step rate leaves open', () => {
    render(<FunnelPanel week={MIDDLE_CAPPED} />);
    const row = within(screen.getByRole('table')).getByRole('row', {
      name: /Started registration/,
    });
    expect(within(row).getByText(`67.8% (${NOTE})`)).toBeInTheDocument();
  });

  it('leaves the biggest-drop figure unmarked, its own counts being whole', () => {
    render(<FunnelPanel week={MIDDLE_CAPPED} />);
    expect(
      screen.getByText(/Biggest drop: Visited . Clicked into the product \(11\.1%\)\./)
    ).toBeInTheDocument();
  });

  it('says a capped rate may have chosen the step the caption names', () => {
    render(<FunnelPanel week={MIDDLE_CAPPED} />);
    expect(
      screen.getByText(/A rate whose input hit a ceiling may have chosen this step\./)
    ).toBeInTheDocument();
  });
});

describe('FunnelPanel where no ceiling was reached', () => {
  it('prints the rate beside the bar as the number alone', () => {
    render(<FunnelPanel week={WEEK} />);
    const bar = screen.getByRole('listitem', { name: /Account created/ });
    expect(within(bar).getByText('42.3%')).toBeInTheDocument();
  });

  it('prints both table rates as the numbers alone', () => {
    render(<FunnelPanel week={WEEK} />);
    const row = within(screen.getByRole('table')).getByRole('row', { name: /Account created/ });
    expect(within(row).getByText('42.3%')).toBeInTheDocument();
    expect(within(row).getByText('3.2%')).toBeInTheDocument();
  });

  it('prints the caption\u2019s biggest-drop figure as the number alone', () => {
    render(<FunnelPanel week={WEEK} />);
    expect(
      screen.getByText(/Biggest drop: Visited . Clicked into the product \(11\.1%\)\./)
    ).toBeInTheDocument();
  });

  it('carries no marker and no ceiling wording anywhere on the panel', () => {
    const { container } = render(<FunnelPanel week={WEEK} />);
    expect(container.textContent).not.toContain('*');
    expect(container.textContent.toLowerCase()).not.toContain('ceiling');
  });
});

describe('FunnelPanel with an empty week', () => {
  const EMPTY: GrowthFunnelWeekWire = {
    ...WEEK,
    visitorsDailySummed: 0,
    productEntryClicksHourlySummed: 0,
    started: 0,
    finished: 0,
    verified: 0,
    activated: 0,
    returnedWeek1: 0,
    firstPaid: 0,
    revenueNanoUsd: '0',
  };

  it('says no drop could be measured rather than naming a false one', () => {
    render(<FunnelPanel week={EMPTY} />);
    expect(screen.getByText(/No step-to-step drop could be measured/)).toBeInTheDocument();
  });

  it('states in words that there is no rate, rather than a mark read as a sign', () => {
    render(<FunnelPanel week={EMPTY} />);
    expect(screen.getAllByText('No rate').length).toBeGreaterThan(0);
  });
});

describe('FunnelPanel where a step has no rate to state', () => {
  it('says the whole of it in the rate column beside the bar', () => {
    render(<FunnelPanel week={WEEK} />);
    const bar = screen.getByRole('listitem', { name: /Visited/ });
    expect(within(bar).getByText('No rate')).toBeInTheDocument();
  });

  it('says the same words in the table a reader gets instead of the bars', () => {
    render(<FunnelPanel week={WEEK} />);
    const row = within(screen.getByRole('table')).getByRole('row', { name: /Visited/ });
    expect(within(row).getByText('No rate')).toBeInTheDocument();
  });

  it('puts no long dash on any surface the panel renders', () => {
    const { container } = render(<FunnelPanel week={WEEK} />);
    expect(container.textContent).not.toContain('\u2014');
    expect(container.textContent).not.toContain('\u2013');
    for (const bar of within(ladder(container)).getAllByRole('listitem')) {
      expect(bar.getAttribute('aria-label')).not.toContain('\u2014');
      expect(bar.getAttribute('aria-label')).not.toContain('\u2013');
    }
  });
});

describe('FunnelPanel caption', () => {
  it('says what the hatched bars mean rather than counting them', () => {
    render(<FunnelPanel week={WEEK} />);
    expect(screen.getByText(/no account identity stands behind its count/i)).toBeInTheDocument();
  });
});

describe('FunnelPanel data table naming', () => {
  it('heads the figures column with a name true of every step in it', () => {
    render(<FunnelPanel week={WEEK} />);
    expect(screen.getByRole('columnheader', { name: 'Count' })).toBeInTheDocument();
  });
});
