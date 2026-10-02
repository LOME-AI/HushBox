import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { SourcesPanel } from './sources-panel.js';
import type { GrowthSourceCountWire } from '@hushbox/shared';

const ROWS: readonly GrowthSourceCountWire[] = [
  {
    userCreatedWeek: isoAt(TEST_DAY_START),
    campaign: 'direct',
    selfReportedChannel: 'podcast',
    selfReportedContext: 'post_signup',
    primarySource: 'podcast',
    accounts: 7,
  },
  {
    userCreatedWeek: isoAt(TEST_DAY_START),
    campaign: 'seed-newsletter',
    selfReportedChannel: 'social',
    selfReportedContext: 'post_signup',
    primarySource: 'social',
    accounts: 3,
  },
  {
    userCreatedWeek: isoAt(TEST_DAY_START),
    campaign: 'hn-launch',
    selfReportedChannel: null,
    selfReportedContext: null,
    primarySource: 'hn-launch',
    accounts: 13,
  },
];

describe('SourcesPanel', () => {
  it('ranks each answered channel as a row of its own', () => {
    render(<SourcesPanel rows={ROWS} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('writes each channel by its display label rather than its enum member', () => {
    render(<SourcesPanel rows={ROWS} />);
    expect(screen.getByRole('listitem', { name: /^Podcast\./ })).toBeInTheDocument();
  });

  it('counts the accounts that named each channel', () => {
    render(<SourcesPanel rows={ROWS} />);
    expect(screen.getByRole('listitem', { name: /Answers: 7/ })).toBeInTheDocument();
  });

  it('states each channel share of the accounts that answered', () => {
    render(<SourcesPanel rows={ROWS} />);
    const row = screen.getByRole('listitem', { name: /^Podcast\./ });
    expect(within(row).getByText('70.0%')).toBeInTheDocument();
  });

  it('takes that share against the accounts that answered rather than against every account', () => {
    render(<SourcesPanel rows={ROWS} />);
    // 7 of the 10 who answered, not 7 of the 23 counted, which would read 30.4%.
    expect(screen.queryByText('30.4%')).toBeNull();
  });

  it('names what the shares are taken against, in view and without interaction', () => {
    render(<SourcesPanel rows={ROWS} />);
    expect(screen.getByText(/Shares are of the 10 that answered/)).toBeInTheDocument();
  });

  it('names both figure columns, because one right-aligned label would sit over the share', () => {
    render(<SourcesPanel rows={ROWS} />);
    expect(screen.getByText(/Answers/, { selector: 'p' })).toHaveTextContent(
      /Answers.*Share of answers/
    );
  });
});

describe('how SourcesPanel draws a ranked row', () => {
  it('draws the bar behind the label rather than under it', () => {
    const { container } = render(<SourcesPanel rows={ROWS} />);
    const row = screen.getByRole('listitem', { name: /^Podcast\./ });
    const bar = container.querySelector('[data-slot="ranked-bar"]');
    expect(row.firstElementChild).toBe(bar);
    expect(bar).toHaveClass('absolute');
    expect(row).toHaveClass('relative');
  });

  it('sizes the leading channel bar to the whole row', () => {
    const { container } = render(<SourcesPanel rows={ROWS} />);
    expect(container.querySelector('[data-slot="ranked-bar"]')).toHaveAttribute(
      'style',
      'width: 100%;'
    );
  });

  it('sets the row ink in the ramp own text partner, which the bar fill is held against', () => {
    render(<SourcesPanel rows={ROWS} />);
    expect(screen.getByRole('listitem', { name: /^Podcast\./ })).toHaveClass('text-seq-foreground');
  });

  it('keeps the bar out of the accessible name, which the row carries in words', () => {
    const { container } = render(<SourcesPanel rows={ROWS} />);
    expect(container.querySelector('[data-slot="ranked-bar"]')).toHaveAttribute(
      'aria-hidden',
      'true'
    );
  });
});

describe('what SourcesPanel keeps in view rather than behind a hover', () => {
  it('shows the campaign split inside the row it belongs to', () => {
    render(<SourcesPanel rows={ROWS} />);
    const row = screen.getByRole('listitem', { name: /^Podcast\./ });
    expect(within(row).getByText('direct 7')).toBeInTheDocument();
  });

  it('shows the primary source total inside the row it belongs to', () => {
    render(<SourcesPanel rows={ROWS} />);
    const row = screen.getByRole('listitem', { name: /^Podcast\./ });
    expect(within(row).getByText('Primary source total: 7')).toBeInTheDocument();
  });

  it('carries both of them in the row accessible name as well as on the row', () => {
    render(<SourcesPanel rows={ROWS} />);
    expect(
      screen.getByRole('listitem', {
        name: 'Podcast. Answers: 7. Share of answers: 70.0%. By campaign: direct 7. Primary source total: 7.',
      })
    ).toBeInTheDocument();
  });
});

describe('the accounts SourcesPanel counts but cannot rank', () => {
  it('keeps them out of the ranking, because they named no channel to rank', () => {
    render(<SourcesPanel rows={ROWS} />);
    for (const row of screen.getAllByRole('listitem')) {
      expect(row).not.toHaveAccessibleName(/answered/i);
    }
  });

  it('states how many of them there were', () => {
    render(<SourcesPanel rows={ROWS} />);
    expect(screen.getByText(/13 accounts named no channel/)).toBeInTheDocument();
  });

  it('keeps their campaign split too, which the ranking has nowhere to put', () => {
    render(<SourcesPanel rows={ROWS} />);
    expect(screen.getByText(/hn-launch 13/)).toBeInTheDocument();
  });

  it('says their primary source falls back to the campaign', () => {
    render(<SourcesPanel rows={ROWS} />);
    expect(screen.getByText(/falls back to the campaign/i)).toBeInTheDocument();
  });

  it('states them outside the ranked list, so the ranking counts only answers', () => {
    render(<SourcesPanel rows={ROWS} />);
    expect(screen.getByText(/13 accounts named no channel/).closest('ul')).toBeNull();
  });

  it('says nothing about them when every account answered', () => {
    render(<SourcesPanel rows={ROWS.slice(0, 2)} />);
    expect(screen.queryByText(/named no channel/)).toBeNull();
  });
});

describe('SourcesPanel totals', () => {
  it('reports how many accounts answered', () => {
    render(<SourcesPanel rows={ROWS} />);
    expect(screen.getByText(/Answered 10 of 23 accounts \(43\.5%\)/)).toBeInTheDocument();
  });

  it('says nothing was counted when there are no accounts', () => {
    render(<SourcesPanel rows={[]} />);
    expect(screen.getByText(/No accounts were created/i)).toBeInTheDocument();
  });
});

describe('SourcesPanel with only unanswered accounts', () => {
  const NONE: readonly GrowthSourceCountWire[] = [
    {
      userCreatedWeek: isoAt(TEST_DAY_START),
      campaign: 'direct',
      selfReportedChannel: null,
      selfReportedContext: null,
      primarySource: 'direct',
      accounts: 4,
    },
  ];

  it('reports a zero answered rate rather than a dash', () => {
    render(<SourcesPanel rows={NONE} />);
    expect(screen.getByText(/Answered 0 of 4 accounts \(0\.0%\)/)).toBeInTheDocument();
  });

  it('ranks nothing, because a ranking of no answers has no rows', () => {
    render(<SourcesPanel rows={NONE} />);
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });

  it('still states the accounts that answered nothing', () => {
    render(<SourcesPanel rows={NONE} />);
    expect(screen.getByText(/4 accounts named no channel/)).toBeInTheDocument();
  });
});

describe('SourcesPanel where a channel was counted but nobody answered', () => {
  const EMPTY_CHANNEL: readonly GrowthSourceCountWire[] = [
    {
      userCreatedWeek: isoAt(TEST_DAY_START),
      campaign: 'direct',
      selfReportedChannel: 'podcast',
      selfReportedContext: 'post_signup',
      primarySource: 'podcast',
      accounts: 0,
    },
    {
      userCreatedWeek: isoAt(TEST_DAY_START),
      campaign: 'hn-launch',
      selfReportedChannel: null,
      selfReportedContext: null,
      primarySource: 'hn-launch',
      accounts: 13,
    },
  ];

  it('states no rate rather than a figure nothing can be taken against', () => {
    render(<SourcesPanel rows={EMPTY_CHANNEL} />);
    const row = screen.getByRole('listitem', { name: /^Podcast\./ });
    expect(within(row).getByText('No rate')).toBeInTheDocument();
  });

  it('draws that channel no bar, because it leads nothing', () => {
    const { container } = render(<SourcesPanel rows={EMPTY_CHANNEL} />);
    expect(container.querySelector('[data-slot="ranked-bar"]')).toHaveAttribute(
      'style',
      'width: 0%;'
    );
  });
});
