import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TEST_IDS } from '@hushbox/shared';
import { DAY_MS } from '@hushbox/shared/test-time';
import { NO_LADDER_ROW_REASON, NO_MARGINAL_ROW_REASON } from './headline-figures.js';
import {
  WEEK_START,
  FUNNEL_WEEK,
  MARKETING_ROWS,
  PRODUCT_ENTRY_ROW,
  campaignRow,
  stubFetch,
  renderScreen,
  screenReady,
  chooseCampaigns,
  chooseWeek,
  panelNamed,
  scopeNoteOf,
  HEADLINE_PANEL,
  headlineTiles,
  installGrowthScreenHarness,
} from './test-support/growth-screen-harness.setup.js';
import type { GrowthGrain, GrowthMarketingRowWire } from '@hushbox/shared';

vi.mock('@/components/ops/op-modal-provider', () => ({
  useRunOp: () => vi.fn(),
}));

vi.mock('recharts', async (importOriginal) => {
  const { rechartsWithFixedContainer } =
    await import('./test-support/recharts-fixed-container.setup.js');
  return rechartsWithFixedContainer(await importOriginal<typeof import('recharts')>());
});

installGrowthScreenHarness();

describe('GrowthScreen headline figures', () => {
  /**
   * One week under two campaigns the same person saw, reaching the product under
   * both. Each campaign's ladder row counts that person, so adding the rows
   * counts two; the campaign-free marginals beneath count one.
   */
  const SHARED_VISITOR = [
    {
      ...FUNNEL_WEEK,
      campaign: 'hn-launch',
      visitorsDailySummed: 1,
      productEntryClicksHourlySummed: 1,
    },
    {
      ...FUNNEL_WEEK,
      campaign: 'bing-brand',
      visitorsDailySummed: 1,
      productEntryClicksHourlySummed: 1,
    },
  ];

  /** One visitor and one entrant across the whole site, whatever the campaigns did. */
  function oneEachMarginal(grain: GrowthGrain): readonly GrowthMarketingRowWire[] {
    const row = grain === 'hour' ? PRODUCT_ENTRY_ROW : MARKETING_ROWS[0];
    if (row === undefined) throw new Error('no row to build the marginal from');
    return [{ ...row, visitors: 1 }];
  }

  it('states the whole-site visitor figure while no campaign is selected', async () => {
    stubFetch();
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(within(headlineTiles()).getByText('500')).toBeInTheDocument();
    });
  });

  it('states the whole-site product-entry figure from the hourly marginal', async () => {
    stubFetch();
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(within(headlineTiles()).getByText('77')).toBeInTheDocument();
    });
  });

  it('counts a visitor who saw two campaigns once, where adding the campaigns counts two', async () => {
    stubFetch({
      funnelWeeks: SHARED_VISITOR,
      marketingRowsByGrain: oneEachMarginal,
    });
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(within(headlineTiles()).getAllByText('1').length).toBe(2);
    });
    expect(within(headlineTiles()).queryByText('2')).not.toBeInTheDocument();
  });

  it('leaves the per-campaign figures as they were once a single campaign is selected', async () => {
    stubFetch();
    renderScreen();
    await screenReady();
    await chooseCampaigns('hn-launch');
    await waitFor(() => {
      expect(within(headlineTiles()).getByText('1,284')).toBeInTheDocument();
    });
    expect(within(headlineTiles()).getByText('143')).toBeInTheDocument();
  });

  it('states no figure where the campaign-free read holds no bucket for the week', async () => {
    stubFetch({ marketingRows: [] });
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(within(headlineTiles()).getAllByText(NO_MARGINAL_ROW_REASON).length).toBe(2);
    });
  });
});

describe('GrowthScreen headline tiles when the funnel read fails', () => {
  it('states the refusal on the tiles rather than drawing figures', async () => {
    stubFetch({ failing: new Set(['growth.funnel.read']) });
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(
        within(panelNamed(HEADLINE_PANEL)).getByTestId(TEST_IDS.adminPanelError)
      ).toHaveTextContent('UNAVAILABLE');
    });
  });

  it('draws no account figure while the read that carries it has failed', async () => {
    stubFetch({ failing: new Set(['growth.funnel.read']) });
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(
        within(panelNamed(HEADLINE_PANEL)).getByTestId(TEST_IDS.adminPanelError)
      ).toBeInTheDocument();
    });
    expect(screen.queryByText('Accounts created')).not.toBeInTheDocument();
    expect(screen.queryByText('First payments')).not.toBeInTheDocument();
  });

  it('draws no zero anywhere in the leading figures', async () => {
    stubFetch({ failing: new Set(['growth.funnel.read']) });
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(
        within(panelNamed(HEADLINE_PANEL)).getByTestId(TEST_IDS.adminPanelError)
      ).toBeInTheDocument();
    });
    expect(within(panelNamed(HEADLINE_PANEL)).queryByText('0')).not.toBeInTheDocument();
  });

  it('keeps the panels whose own reads answered', async () => {
    stubFetch({ failing: new Set(['growth.funnel.read']) });
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(screen.getByRole('listitem', { name: /news\.ycombinator\.com/ })).toBeInTheDocument();
    });
  });
});

describe('GrowthScreen headline tiles when a whole-site read fails', () => {
  it('states the refusal on the tiles rather than a sentence about the week', async () => {
    stubFetch({ failing: new Set(['growth.marketing.read']) });
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(
        within(panelNamed(HEADLINE_PANEL)).getByTestId(TEST_IDS.adminPanelError)
      ).toHaveTextContent('UNAVAILABLE');
    });
  });

  it('draws no sentence about an unmeasured week while that read has failed', async () => {
    stubFetch({ failing: new Set(['growth.marketing.read']) });
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(
        within(panelNamed(HEADLINE_PANEL)).getByTestId(TEST_IDS.adminPanelError)
      ).toBeInTheDocument();
    });
    expect(screen.queryByText(NO_MARGINAL_ROW_REASON)).not.toBeInTheDocument();
  });

  it('draws no ladder figure beside the figures that read refused', async () => {
    stubFetch({ failing: new Set(['growth.marketing.read']) });
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(
        within(panelNamed(HEADLINE_PANEL)).getByTestId(TEST_IDS.adminPanelError)
      ).toBeInTheDocument();
    });
    expect(within(panelNamed(HEADLINE_PANEL)).queryByText('41')).not.toBeInTheDocument();
  });
});

describe('GrowthScreen headline tiles while a read behind them is in flight', () => {
  it('draws the leading figures as still loading once the ladder has answered', async () => {
    stubFetch({ pending: new Set(['growth.marketing.read']) });
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(screen.getByText('Campaign: hn-launch')).toBeInTheDocument();
    });
    expect(
      panelNamed(HEADLINE_PANEL).querySelector('[data-slot="panel-frame-skeleton"]')
    ).toBeInTheDocument();
  });

  it('states no sentence about an unmeasured week before that read answers', async () => {
    stubFetch({ pending: new Set(['growth.marketing.read']) });
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(screen.getByText('Campaign: hn-launch')).toBeInTheDocument();
    });
    expect(screen.queryByText(NO_MARGINAL_ROW_REASON)).not.toBeInTheDocument();
  });
});

describe('GrowthScreen headline tiles for a week the ladder holds no row for', () => {
  it('says the ladder held no row rather than drawing a zero', async () => {
    stubFetch();
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(screen.getByText('Campaign: hn-launch')).toBeInTheDocument();
    });
    await chooseWeek(WEEK_START - 5 * 7 * DAY_MS);
    await waitFor(() => {
      expect(within(panelNamed(HEADLINE_PANEL)).getAllByText(NO_LADDER_ROW_REASON).length).toBe(2);
    });
  });

  it('draws no zero in the leading figures for that week', async () => {
    stubFetch();
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(screen.getByText('Campaign: hn-launch')).toBeInTheDocument();
    });
    await chooseWeek(WEEK_START - 5 * 7 * DAY_MS);
    await waitFor(() => {
      expect(screen.getByText('No ladder for this week.')).toBeInTheDocument();
    });
    expect(within(panelNamed(HEADLINE_PANEL)).queryByText('0')).not.toBeInTheDocument();
  });
});

describe('GrowthScreen headline tiles for a week the ladder counted nobody in', () => {
  it('draws the counted zero as a figure', async () => {
    stubFetch({ funnelWeeks: [{ ...FUNNEL_WEEK, finished: 0, firstPaid: 0 }] });
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(screen.getByText('Campaign: hn-launch')).toBeInTheDocument();
    });
    expect(within(headlineTiles()).getAllByText('0').length).toBe(2);
  });

  it('states no reason beside a figure it was able to state', async () => {
    stubFetch({ funnelWeeks: [{ ...FUNNEL_WEEK, finished: 0, firstPaid: 0 }] });
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(screen.getByText('Campaign: hn-launch')).toBeInTheDocument();
    });
    expect(
      within(panelNamed(HEADLINE_PANEL)).queryByText(NO_LADDER_ROW_REASON)
    ).not.toBeInTheDocument();
  });
});

describe('GrowthScreen headline tiles under a multi-campaign selection', () => {
  const THREE = [
    { ...FUNNEL_WEEK, campaign: 'hn-launch', finished: 41, firstPaid: 6 },
    { ...FUNNEL_WEEK, campaign: 'x-thread', finished: 1, firstPaid: 0 },
    { ...FUNNEL_WEEK, campaign: 'direct', finished: 25, firstPaid: 3 },
  ];
  const CAMPAIGNS = [campaignRow('hn-launch'), campaignRow('x-thread'), campaignRow('direct')];

  it('adds the account figures over exactly the campaigns selected', async () => {
    stubFetch({ funnelWeeks: THREE, campaigns: CAMPAIGNS });
    renderScreen();
    await screenReady();
    await chooseCampaigns('hn-launch', 'x-thread');
    await waitFor(() => {
      expect(within(headlineTiles()).getByText('42')).toBeInTheDocument();
    });
  });

  it('leaves the unselected campaign out of the whole-site total it used to show', async () => {
    stubFetch({ funnelWeeks: THREE, campaigns: CAMPAIGNS });
    renderScreen();
    await screenReady();
    await chooseCampaigns('hn-launch', 'x-thread');
    await waitFor(() => {
      expect(within(headlineTiles()).getByText('42')).toBeInTheDocument();
    });
    expect(within(headlineTiles()).queryByText('67')).not.toBeInTheDocument();
  });

  it('sums every campaign while none is selected', async () => {
    stubFetch({ funnelWeeks: THREE, campaigns: CAMPAIGNS });
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(within(headlineTiles()).getByText('67')).toBeInTheDocument();
    });
  });

  it('names the figures the selection does not reach once it names several campaigns', async () => {
    stubFetch({ funnelWeeks: THREE, campaigns: CAMPAIGNS });
    renderScreen();
    await screenReady();
    await chooseCampaigns('hn-launch', 'x-thread');
    await waitFor(() => {
      expect(scopeNoteOf(HEADLINE_PANEL)).toBe(
        'The selection above reaches every figure here but Visitors (daily uniques, summed) ' +
          'and Product entry clicks (hourly uniques, summed), which count every campaign: ' +
          'a count of distinct visitors narrows to one campaign at a time. ' +
          'Select a single campaign to scope them.'
      );
    });
  });

  it('states no such scope once the selection names the one campaign every figure follows', async () => {
    stubFetch({ funnelWeeks: THREE, campaigns: CAMPAIGNS });
    renderScreen();
    await screenReady();
    await chooseCampaigns('hn-launch');
    await waitFor(() => {
      expect(within(headlineTiles()).getByText('41')).toBeInTheDocument();
    });
    expect(panelNamed(HEADLINE_PANEL).querySelector('[data-slot="panel-scope-note"]')).toBeNull();
  });
});
