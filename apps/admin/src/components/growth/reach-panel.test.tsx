import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ReachPanel } from './reach-panel.js';
import type { GrowthReachRowWire } from '@hushbox/shared';

const ROWS: readonly GrowthReachRowWire[] = [
  { landingPath: '/welcome', reachedPath: '/pricing', visitorsDailySummed: 402, overflow: false },
  { landingPath: '/welcome', reachedPath: '/privacy', visitorsDailySummed: 301, overflow: false },
];

describe('ReachPanel', () => {
  it('lists each landing and reached pair the server sent', () => {
    render(<ReachPanel rows={ROWS} />);
    expect(screen.getByRole('row', { name: /\/welcome.*\/pricing 402/ })).toBeInTheDocument();
  });

  it('sorts the journeys largest first', () => {
    render(<ReachPanel rows={ROWS} />);
    const cells = screen.getAllByRole('cell').map((cell) => cell.textContent);
    expect(cells.indexOf('/pricing')).toBeLessThan(cells.indexOf('/privacy'));
  });

  it('names the figure as summed daily counts rather than distinct people', () => {
    render(<ReachPanel rows={ROWS} />);
    expect(screen.getByRole('columnheader', { name: /summed/i })).toBeInTheDocument();
  });

  it('says in the caption that the figure is a lower bound', () => {
    render(<ReachPanel rows={ROWS} />);
    expect(screen.getByText(/lower bound/i)).toBeInTheDocument();
  });

  it('renders no row for a pair the read did not carry', () => {
    render(<ReachPanel rows={[ROWS[0]!]} />);
    expect(screen.queryByText('/privacy')).not.toBeInTheDocument();
  });

  it('never fills an uncounted pair in as a zero', () => {
    render(<ReachPanel rows={[ROWS[0]!]} />);
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('says nothing was counted when the read carried no pairs at all', () => {
    render(<ReachPanel rows={[]} />);
    expect(screen.getByText(/No journeys were counted/i)).toBeInTheDocument();
  });

  it('does not draw an empty table as a table of zeroes', () => {
    render(<ReachPanel rows={[]} />);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});

describe('ReachPanel capped journeys', () => {
  const CAPPED: GrowthReachRowWire = {
    landingPath: '/welcome',
    reachedPath: '/pricing',
    visitorsDailySummed: 100_000,
    overflow: true,
  };

  it('marks a journey whose count hit the ceiling as a floor', () => {
    render(<ReachPanel rows={[CAPPED]} />);
    expect(screen.getByRole('cell', { name: '100,000+' })).toBeInTheDocument();
  });

  it('states a count that never hit the ceiling as the exact figure', () => {
    render(<ReachPanel rows={[ROWS[0]!]} />);
    expect(screen.getByRole('cell', { name: '402' })).toBeInTheDocument();
  });
});

describe('ReachPanel caption', () => {
  it('claims no narrowing to a largest row, because this figure simply sums its days', () => {
    render(<ReachPanel rows={ROWS} />);
    expect(screen.queryByText(/largest/i)).not.toBeInTheDocument();
  });

  it('still says the figure is a floor rather than a total', () => {
    render(<ReachPanel rows={ROWS} />);
    expect(screen.getByText(/lower bound/i)).toBeInTheDocument();
  });
});

/**
 * A read carrying the pair every landing makes with itself, which is where the
 * landing's own visitor count comes from: the reach set is keyed by (landed on,
 * reached) and a visitor's first page of the day fills the pair for that page
 * against itself.
 */
const GROUPED: readonly GrowthReachRowWire[] = [
  { landingPath: '/welcome', reachedPath: '/welcome', visitorsDailySummed: 200, overflow: false },
  { landingPath: '/welcome', reachedPath: '/pricing', visitorsDailySummed: 50, overflow: false },
  { landingPath: '/welcome', reachedPath: '/privacy', visitorsDailySummed: 30, overflow: false },
  { landingPath: '/blog', reachedPath: '/blog', visitorsDailySummed: 40, overflow: false },
  { landingPath: '/blog', reachedPath: '/pricing', visitorsDailySummed: 10, overflow: false },
];

/** The box the rows scroll inside, which is also the table's keyboard stop. */
function scrollport(): HTMLElement {
  const node = document.querySelector('[data-slot="reach-scrollport"]');
  if (node === null) throw new Error('no scrollport was rendered');
  return node as HTMLElement;
}

describe('ReachPanel grouped by landing', () => {
  it('names each landing once, above the journeys made from it', () => {
    render(<ReachPanel rows={GROUPED} />);
    const headers = screen.getAllByRole('rowheader', { name: /\/welcome/ });
    expect(headers).toHaveLength(1);
    expect(headers[0]).toHaveAttribute('rowspan', '2');
  });

  it("states that landing's own visitors, from the pair it makes with itself", () => {
    render(<ReachPanel rows={GROUPED} />);
    expect(screen.getByText('Landed: 200')).toBeInTheDocument();
  });

  it('marks the landing figure as a floor where its own count hit the ceiling', () => {
    render(
      <ReachPanel
        rows={[
          {
            landingPath: '/welcome',
            reachedPath: '/welcome',
            visitorsDailySummed: 100_000,
            overflow: true,
          },
          ...GROUPED.slice(1, 3),
        ]}
      />
    );
    expect(screen.getByText('Landed: 100,000+')).toBeInTheDocument();
  });

  it("states each journey as a share of that landing's own visitors", () => {
    render(<ReachPanel rows={GROUPED} />);
    expect(screen.getByRole('row', { name: /\/privacy 30 15\.0%/ })).toBeInTheDocument();
  });

  it('takes each share against its own landing rather than against the whole read', () => {
    render(<ReachPanel rows={GROUPED} />);
    expect(screen.getByRole('row', { name: /\/blog.*\/pricing 10 25\.0%/ })).toBeInTheDocument();
  });

  it("orders the groups by each landing's own visitors, largest first", () => {
    render(<ReachPanel rows={GROUPED} />);
    const landings = screen.getAllByRole('rowheader').map((cell) => cell.textContent);
    expect(landings.findIndex((text) => text.startsWith('/welcome'))).toBeLessThan(
      landings.findIndex((text) => text.startsWith('/blog'))
    );
  });

  it('states no rate where the landing carried no count of its own', () => {
    render(<ReachPanel rows={ROWS} />);
    expect(screen.getByRole('row', { name: /\/pricing 402 No rate/ })).toBeInTheDocument();
  });

  it('states no rate where either figure hit a counting ceiling', () => {
    render(
      <ReachPanel
        rows={[
          {
            landingPath: '/welcome',
            reachedPath: '/welcome',
            visitorsDailySummed: 100_000,
            overflow: true,
          },
          GROUPED[1]!,
        ]}
      />
    );
    expect(screen.getByRole('row', { name: /\/pricing 50 No rate/ })).toBeInTheDocument();
  });
});

describe('ReachPanel folding of the pairs a landing makes with itself', () => {
  it('folds them away and says how many it folded', () => {
    render(<ReachPanel rows={GROUPED} />);
    expect(screen.queryByRole('cell', { name: '/welcome' })).not.toBeInTheDocument();
    expect(screen.getByText(/folded away \(2\)/)).toBeInTheDocument();
  });

  it('shows them when the control is pressed, and says it is showing them', async () => {
    render(<ReachPanel rows={GROUPED} />);
    await userEvent.click(screen.getByRole('button', { name: /pairs where the landing/ }));
    expect(screen.getByRole('cell', { name: '/welcome' })).toBeInTheDocument();
    expect(screen.getByText(/shown \(2\)/)).toBeInTheDocument();
  });

  it('marks the control as pressed while those pairs are shown', async () => {
    render(<ReachPanel rows={GROUPED} />);
    const control = screen.getByRole('button', { name: /pairs where the landing/ });
    await userEvent.click(control);
    expect(control).toHaveAttribute('aria-pressed', 'true');
  });

  it('offers no control where no pair has the landing as the page reached', () => {
    render(<ReachPanel rows={ROWS} />);
    expect(
      screen.queryByRole('button', { name: /pairs where the landing/ })
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/No pair here has the landing as the page reached/)
    ).toBeInTheDocument();
  });

  it('keeps a landing whose only pair is with itself out of the folded view', () => {
    render(
      <ReachPanel
        rows={[
          { landingPath: '/terms', reachedPath: '/terms', visitorsDailySummed: 9, overflow: false },
          ...GROUPED,
        ]}
      />
    );
    expect(screen.queryByRole('rowheader', { name: /\/terms/ })).not.toBeInTheDocument();
    expect(screen.getByText(/folded away \(3\)/)).toBeInTheDocument();
  });
});

describe('ReachPanel bounded height', () => {
  it('scrolls its rows inside a box a keyboard can reach and name', () => {
    render(<ReachPanel rows={GROUPED} />);
    const box = scrollport();
    expect(box).toHaveAttribute('tabindex', '0');
    expect(box).toHaveAttribute('role', 'group');
    expect(box).toHaveAccessibleName(/landed on one page and reached another/i);
    expect(box.className).toMatch(/\bmax-h-/);
    expect(box.className).toMatch(/\boverflow-auto\b/);
  });

  // Its rows stop short of the box's corners, so the rounding clips nothing.
  it('draws the box rounded, its own shape rather than the scroll region’s', () => {
    render(<ReachPanel rows={GROUPED} />);
    expect(scrollport()).toHaveClass('rounded-sm');
  });

  it('keeps the column names in view while the rows scroll under them', () => {
    render(<ReachPanel rows={GROUPED} />);
    for (const heading of screen.getAllByRole('columnheader')) {
      expect(heading).toHaveClass('sticky');
    }
  });

  it('leaves the lower-bound note outside the box, so the bound never scrolls it away', () => {
    render(<ReachPanel rows={GROUPED} />);
    const note = screen.getByText(/lower bound/i);
    expect(scrollport().contains(note)).toBe(false);
  });

  it('leaves what it folded outside the box for the same reason', () => {
    render(<ReachPanel rows={GROUPED} />);
    const note = screen.getByText(/folded away \(2\)/);
    expect(scrollport().contains(note)).toBe(false);
  });

  it('names what the percentages are taken against, in view and without interaction', () => {
    render(<ReachPanel rows={GROUPED} />);
    expect(
      within(screen.getByRole('figure')).getByText(/of that landing's own visitors/)
    ).toBeInTheDocument();
  });
});

describe('ReachPanel group ordering beyond the leading landing', () => {
  /** The landings each group is read off, so the order is the only thing varying. */
  function landingsInOrder(): (string | null)[] {
    return screen.getAllByRole('rowheader').map((cell) => cell.textContent);
  }

  it('orders two landings whose own visitors are level by their path', () => {
    render(
      <ReachPanel
        rows={[
          { landingPath: '/beta', reachedPath: '/beta', visitorsDailySummed: 5, overflow: false },
          {
            landingPath: '/beta',
            reachedPath: '/roadmap',
            visitorsDailySummed: 2,
            overflow: false,
          },
          { landingPath: '/alpha', reachedPath: '/alpha', visitorsDailySummed: 5, overflow: false },
          {
            landingPath: '/alpha',
            reachedPath: '/roadmap',
            visitorsDailySummed: 1,
            overflow: false,
          },
        ]}
      />
    );
    const order = landingsInOrder();
    expect(order.findIndex((text) => text?.startsWith('/alpha') === true)).toBeLessThan(
      order.findIndex((text) => text?.startsWith('/beta') === true)
    );
  });

  it('orders a landing the read carried no count for after one it did', () => {
    render(
      <ReachPanel
        rows={[
          {
            landingPath: '/alpha',
            reachedPath: '/roadmap',
            visitorsDailySummed: 9,
            overflow: false,
          },
          { landingPath: '/zebra', reachedPath: '/zebra', visitorsDailySummed: 1, overflow: false },
          {
            landingPath: '/zebra',
            reachedPath: '/roadmap',
            visitorsDailySummed: 1,
            overflow: false,
          },
        ]}
      />
    );
    const order = landingsInOrder();
    expect(order.findIndex((text) => text?.startsWith('/zebra') === true)).toBeLessThan(
      order.findIndex((text) => text?.startsWith('/alpha') === true)
    );
  });
});
