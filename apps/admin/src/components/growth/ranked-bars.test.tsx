import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { RankedBars } from './ranked-bars.js';
import { summedCountLabel } from './summed-label.js';

/** What the referrer figures are called wherever they appear, from one definition. */
const VISITORS = summedCountLabel('Visitors', 'daily');

const TOTALS = [
  { key: 'news.ycombinator.com', visitors: 412, overflow: false },
  { key: 'duckduckgo.com', visitors: 201, overflow: false },
  { key: 'other', visitors: 31, overflow: false },
];

describe('RankedBars', () => {
  it('draws one row per entry', () => {
    render(<RankedBars totals={TOTALS} countLabel={VISITORS} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('carries every entry as a real table, hidden from the eye until asked for', () => {
    const { container } = render(<RankedBars totals={TOTALS} countLabel={VISITORS} />);
    expect(container.querySelector('[data-slot="chart-data-table"]')).toHaveClass('sr-only');
    const table = screen.getByRole('table');
    expect(within(table).getByRole('row', { name: /duckduckgo\.com 201/ })).toBeInTheDocument();
  });

  it('shows that table when the control is pressed', async () => {
    const { container } = render(<RankedBars totals={TOTALS} countLabel={VISITORS} />);
    await userEvent.click(screen.getByRole('button', { name: 'Show data' }));
    expect(container.querySelector('[data-slot="chart-data-table"]')).not.toHaveClass('sr-only');
  });

  it('names the shown table by what it holds, as its caption does', async () => {
    render(<RankedBars totals={TOTALS} countLabel={VISITORS} />);
    await userEvent.click(screen.getByRole('button', { name: 'Show data' }));
    expect(screen.getByRole('group', { name: `Name by ${VISITORS}` })).toContainElement(
      screen.getByRole('table')
    );
  });

  it('closes with a line naming what leads the ranking', () => {
    render(<RankedBars totals={TOTALS} countLabel={VISITORS} />);
    expect(screen.getByText(/news\.ycombinator\.com was counted most/)).toBeInTheDocument();
  });

  it('names the figure with the bucketing behind it, above the bars', () => {
    const { container } = render(<RankedBars totals={TOTALS} countLabel={VISITORS} />);
    expect(container.querySelector('figure > p')).toHaveTextContent(
      'Visitors (daily uniques, summed)'
    );
  });

  it("states that bucketing in every bar's accessible name", () => {
    render(<RankedBars totals={TOTALS} countLabel={VISITORS} />);
    expect(
      screen.getByRole('listitem', {
        name: /^news\.ycombinator\.com\. Visitors \(daily uniques, summed\): 412\./,
      })
    ).toBeInTheDocument();
  });

  it('states the count beside each bar', () => {
    render(<RankedBars totals={TOTALS} countLabel={VISITORS} />);
    const row = screen.getByRole('listitem', { name: /news\.ycombinator\.com/ });
    expect(within(row).getByText('412')).toBeInTheDocument();
  });

  it('gives every bar keyboard focus', () => {
    render(<RankedBars totals={TOTALS} countLabel={VISITORS} />);
    for (const row of screen.getAllByRole('listitem')) {
      expect(row).toHaveAttribute('tabindex', '0');
    }
  });

  it("hides each bar's browser outline only while it has keyboard focus", () => {
    render(<RankedBars totals={TOTALS} countLabel={VISITORS} />);
    expect(
      screen
        .getAllByRole('listitem')
        .map((row) =>
          [...row.classList].filter((token) => /(^|:)outline-(none|hidden)$/.test(token))
        )
    ).toEqual(TOTALS.map(() => ['focus-visible:outline-hidden']));
  });

  it('marks a count the ceiling cut off as a floor', () => {
    render(
      <RankedBars
        totals={[{ key: 'a.com', visitors: 100_000, overflow: true }]}
        countLabel={VISITORS}
      />
    );
    expect(within(screen.getByRole('listitem')).getByText('100,000+')).toBeInTheDocument();
  });

  it('says nothing was counted when there are no entries', () => {
    render(<RankedBars totals={[]} countLabel={VISITORS} />);
    expect(screen.getByText(/Nothing was counted/i)).toBeInTheDocument();
  });

  it('shows only the first rows until more are asked for', () => {
    const many = Array.from({ length: 14 }, (_, index) => ({
      key: `host-${String(index)}`,
      visitors: 14 - index,
      overflow: false,
    }));
    render(<RankedBars totals={many} countLabel={VISITORS} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(10);
    expect(screen.getByRole('button', { name: /Show all 14/ })).toBeInTheDocument();
  });
});

describe('RankedBars expansion', () => {
  const many = Array.from({ length: 14 }, (_, index) => ({
    key: `host-${String(index)}`,
    visitors: 14 - index,
    overflow: false,
  }));

  it('shows every row once the reader asks for them', async () => {
    render(<RankedBars totals={many} countLabel={VISITORS} />);
    await userEvent.click(screen.getByRole('button', { name: /Show all 14/ }));
    expect(screen.getAllByRole('listitem')).toHaveLength(14);
  });

  it('withdraws the control once every row is shown', async () => {
    render(<RankedBars totals={many} countLabel={VISITORS} />);
    await userEvent.click(screen.getByRole('button', { name: /Show all 14/ }));
    expect(screen.queryByRole('button', { name: /Show all/ })).not.toBeInTheDocument();
  });

  it('draws a zero-width bar rather than dividing by an empty largest value', () => {
    render(
      <RankedBars totals={[{ key: 'a.com', visitors: 0, overflow: false }]} countLabel={VISITORS} />
    );
    expect(screen.getByRole('listitem', { name: /^a\.com\./ })).toBeInTheDocument();
  });
});

describe('RankedBars share of the counted total', () => {
  it('states each entry share of everything counted, beside its figure', () => {
    render(<RankedBars totals={TOTALS} countLabel={VISITORS} />);
    const row = screen.getByRole('listitem', { name: /news\.ycombinator\.com/ });
    expect(within(row).getByText('64.0%')).toBeInTheDocument();
  });

  it('names the total those shares are taken against, in the caption', () => {
    render(<RankedBars totals={TOTALS} countLabel={VISITORS} />);
    expect(screen.getByText(/Shares are of the 644 counted/)).toBeInTheDocument();
  });

  it('marks that total as a floor when any entry hit its ceiling', () => {
    render(
      <RankedBars
        totals={[{ key: 'a.com', visitors: 100_000, overflow: true }]}
        countLabel={VISITORS}
      />
    );
    expect(screen.getByText(/Shares are of the 100,000\+ counted/)).toBeInTheDocument();
  });

  it('states no rate rather than a share when nothing was counted', () => {
    render(
      <RankedBars totals={[{ key: 'a.com', visitors: 0, overflow: false }]} countLabel={VISITORS} />
    );
    expect(within(screen.getByRole('listitem')).getByText('No rate')).toBeInTheDocument();
  });

  it("states the share in the row's accessible name, as it states the count", () => {
    render(<RankedBars totals={TOTALS} countLabel={VISITORS} />);
    expect(
      screen.getByRole('listitem', {
        name: 'news.ycombinator.com. Visitors (daily uniques, summed): 412. Share: 64.0%.',
      })
    ).toBeInTheDocument();
  });

  it("states no rate in the row's accessible name when nothing was counted", () => {
    render(
      <RankedBars totals={[{ key: 'a.com', visitors: 0, overflow: false }]} countLabel={VISITORS} />
    );
    expect(
      screen.getByRole('listitem', {
        name: 'a.com. Visitors (daily uniques, summed): 0. Share: No rate.',
      })
    ).toBeInTheDocument();
  });

  it('carries every share in the table it renders on every pass', () => {
    render(<RankedBars totals={TOTALS} countLabel={VISITORS} />);
    const table = screen.getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Share' })).toBeInTheDocument();
    expect(within(table).getByRole('row', { name: /other 31 4\.8%/ })).toBeInTheDocument();
  });
});

describe('what a RankedBars row draws its bar with', () => {
  it('draws the bar behind the label rather than under it', () => {
    const { container } = render(<RankedBars totals={TOTALS} countLabel={VISITORS} />);
    const row = screen.getByRole('listitem', { name: /news\.ycombinator\.com/ });
    const bar = container.querySelector('[data-slot="ranked-bar"]');
    expect(bar).not.toBeNull();
    expect(row.contains(bar)).toBe(true);
    expect(bar).toHaveClass('absolute');
    expect(row).toHaveClass('relative');
  });

  it('sets the row ink in the ramp own text partner, which the bar fill is held against', () => {
    render(<RankedBars totals={TOTALS} countLabel={VISITORS} />);
    const row = screen.getByRole('listitem', { name: /news\.ycombinator\.com/ });
    expect(row).toHaveClass('text-seq-foreground');
    expect(within(row).getByText('news.ycombinator.com')).toBeInTheDocument();
  });

  it('keeps the bar out of the accessible name, which the figure carries in words', () => {
    const { container } = render(<RankedBars totals={TOTALS} countLabel={VISITORS} />);
    expect(container.querySelector('[data-slot="ranked-bar"]')).toHaveAttribute(
      'aria-hidden',
      'true'
    );
  });
});

describe('what the RankedBars header names', () => {
  it('names both figure columns, because one right-aligned label sat over the share', () => {
    const { container } = render(<RankedBars totals={TOTALS} countLabel={VISITORS} />);
    const header = container.querySelector('figure > p');
    expect(header).toHaveTextContent('Visitors (daily uniques, summed)');
    expect(header).toHaveTextContent('Share');
  });
});
