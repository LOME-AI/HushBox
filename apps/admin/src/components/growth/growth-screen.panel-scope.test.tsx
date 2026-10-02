import { waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { isoAt } from '@hushbox/shared/test-time';
import { panelScopeNote } from './panel-scope.js';
import {
  WEEK_START,
  campaignRow,
  stubFetch,
  renderScreen,
  screenReady,
  chooseCampaigns,
  chooseGrain,
  panelNamed,
  scopeNoteOf,
  SERIES_PANEL,
  NO_CAMPAIGN_CLAUSE,
  HEADLINE_PANEL,
  installGrowthScreenHarness,
} from './test-support/growth-screen-harness.setup.js';
import type { GrowthSourceCountWire } from '@hushbox/shared';
import type { PanelScope } from './panel-scope.js';

vi.mock('@/components/ops/op-modal-provider', () => ({
  useRunOp: () => vi.fn(),
}));

vi.mock('recharts', async (importOriginal) => {
  const { rechartsWithFixedContainer } =
    await import('./test-support/recharts-fixed-container.setup.js');
  return rechartsWithFixedContainer(await importOriginal<typeof import('recharts')>());
});

installGrowthScreenHarness();

describe('GrowthScreen named events scope', () => {
  const CAMPAIGNS = [campaignRow('hn-launch'), campaignRow('x-thread'), campaignRow('direct')];

  /** The panel the named events are drawn in, by its heading. */
  const EVENTS_PANEL = 'Named events';

  /** What the events panel says when the read was not narrowed to one campaign. */
  const EVERY_CAMPAIGN_NOTE =
    panelScopeNote({
      campaigns: { kind: 'every-campaign', reason: 'one-at-a-time' },
      window: { kind: 'selected-week' },
    }) ?? '';

  async function selectCampaigns(tags: readonly string[]): Promise<void> {
    stubFetch({ campaigns: CAMPAIGNS });
    renderScreen();
    await screenReady();
    await chooseCampaigns(...tags);
  }

  it('says the named events cover every campaign while none is selected', async () => {
    await selectCampaigns([]);
    await waitFor(() => {
      expect(within(panelNamed(EVENTS_PANEL)).getByText(EVERY_CAMPAIGN_NOTE)).toBeInTheDocument();
    });
  });

  it('states no such scope once a single campaign is selected', async () => {
    await selectCampaigns(['hn-launch']);
    await waitFor(() => {
      expect(
        within(panelNamed(EVENTS_PANEL)).queryByText(EVERY_CAMPAIGN_NOTE)
      ).not.toBeInTheDocument();
    });
  });

  it('says the named events still cover every campaign under a two-campaign selection', async () => {
    await selectCampaigns(['hn-launch', 'x-thread']);
    await waitFor(() => {
      expect(within(panelNamed(EVENTS_PANEL)).getByText(EVERY_CAMPAIGN_NOTE)).toBeInTheDocument();
    });
  });

  it('says the named events still cover every campaign under a three-campaign selection', async () => {
    await selectCampaigns(['hn-launch', 'x-thread', 'direct']);
    await waitFor(() => {
      expect(within(panelNamed(EVENTS_PANEL)).getByText(EVERY_CAMPAIGN_NOTE)).toBeInTheDocument();
    });
  });
});

describe('GrowthScreen panel scope', () => {
  /** What each panel covers, against the two controls drawn above all of them. */
  const SCOPES: readonly (readonly [string, PanelScope])[] = [
    ['Cohorts', { campaigns: { kind: 'narrowed' }, window: { kind: 'recent-weeks', weeks: 12 } }],
    [
      'Visitors',
      {
        campaigns: { kind: 'every-campaign', reason: 'no-campaign-dimension' },
        window: { kind: 'recent-days', days: 90 },
      },
    ],
    [
      'Referrers',
      {
        campaigns: { kind: 'every-campaign', reason: 'no-campaign-dimension' },
        window: { kind: 'recent-days', days: 90 },
      },
    ],
    [
      'Top pages',
      {
        campaigns: { kind: 'every-campaign', reason: 'no-campaign-dimension' },
        window: { kind: 'recent-days', days: 90 },
      },
    ],
    [
      'Landed on, then reached',
      {
        campaigns: { kind: 'every-campaign', reason: 'no-campaign-dimension' },
        window: { kind: 'selected-week' },
      },
    ],
    [
      'Where visitors are',
      {
        campaigns: { kind: 'every-campaign', reason: 'no-campaign-dimension' },
        window: { kind: 'recent-days', days: 90 },
      },
    ],
    [
      'Where people said they heard of us',
      {
        campaigns: { kind: 'every-campaign', reason: 'not-narrowed' },
        window: { kind: 'recent-weeks', weeks: 12 },
      },
    ],
    [
      'Campaigns',
      {
        campaigns: { kind: 'every-campaign', reason: 'is-the-list' },
        window: { kind: 'unwindowed' },
      },
    ],
  ];

  it.each(SCOPES)('says what the %s panel covers', async (title, scope) => {
    stubFetch();
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(within(panelNamed(title)).getByText(panelScopeNote(scope) ?? '')).toBeInTheDocument();
    });
  });

  it('states no span on the visitor series at the grain that reads the selected week', async () => {
    stubFetch();
    renderScreen();
    await screenReady();
    await chooseGrain('Hour');
    await waitFor(() => {
      expect(scopeNoteOf(SERIES_PANEL)).toBe(NO_CAMPAIGN_CLAUSE);
    });
  });

  it('states no scope on the panels both controls reach', async () => {
    stubFetch();
    renderScreen();
    await screenReady();
    await waitFor(() => {
      // The panel says "Biggest drop" twice once it has answered — in its
      // caption, naming the pair, and in its legend, keying the mark — so this
      // waits for at least one rather than for exactly one.
      expect(
        within(panelNamed('Funnel')).getAllByText(/Biggest drop|No step-to-step/).length
      ).toBeGreaterThan(0);
    });
    expect(panelNamed('Funnel').querySelector('[data-slot="panel-scope-note"]')).toBeNull();
    expect(panelNamed(HEADLINE_PANEL).querySelector('[data-slot="panel-scope-note"]')).toBeNull();
  });
});

describe('GrowthScreen sources panel under a campaign selection', () => {
  const CAMPAIGNS = [campaignRow('hn-launch'), campaignRow('x-thread')];
  const SOURCE_ROWS: readonly GrowthSourceCountWire[] = [
    {
      userCreatedWeek: isoAt(WEEK_START),
      campaign: 'hn-launch',
      selfReportedChannel: 'podcast',
      selfReportedContext: 'post_signup',
      primarySource: 'podcast',
      accounts: 7,
    },
    {
      userCreatedWeek: isoAt(WEEK_START),
      campaign: 'x-thread',
      selfReportedChannel: 'podcast',
      selfReportedContext: 'post_signup',
      primarySource: 'podcast',
      accounts: 3,
    },
  ];

  /** The panel the self-reported sources are drawn in, by its heading. */
  const SOURCES_PANEL = 'Where people said they heard of us';

  async function selectOnlyHnLaunch(): Promise<void> {
    stubFetch({ campaigns: CAMPAIGNS, sourceRows: SOURCE_ROWS });
    renderScreen();
    await screenReady();
    await chooseCampaigns('hn-launch');
  }

  it('keeps showing the deselected campaign, because the selection does not narrow this read', async () => {
    await selectOnlyHnLaunch();
    await waitFor(() => {
      expect(within(panelNamed(SOURCES_PANEL)).getByText(/x-thread 3/)).toBeInTheDocument();
    });
  });

  it('says so on the panel rather than leaving the unchanged rows to be read as narrowed', async () => {
    await selectOnlyHnLaunch();
    await waitFor(() => {
      expect(
        within(panelNamed(SOURCES_PANEL)).getByText(
          panelScopeNote({
            campaigns: { kind: 'every-campaign', reason: 'not-narrowed' },
            window: { kind: 'recent-weeks', weeks: 12 },
          }) ?? ''
        )
      ).toBeInTheDocument();
    });
  });
});
