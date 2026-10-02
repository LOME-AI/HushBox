import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DAY_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { DATA_EDGE_NO_CAMPAIGN, panelScopeNote } from './panel-scope.js';
import {
  WEEK_START,
  stubFetch,
  renderScreen,
  screenReady,
  chooseCampaigns,
  chooseWeek,
  chooseGrain,
  installGrowthScreenHarness,
} from './test-support/growth-screen-harness.setup.js';
import type { GrowthFreshnessWire } from '@hushbox/shared';

vi.mock('@/components/ops/op-modal-provider', () => ({
  useRunOp: () => vi.fn(),
}));

vi.mock('recharts', async (importOriginal) => {
  const { rechartsWithFixedContainer } =
    await import('./test-support/recharts-fixed-container.setup.js');
  return rechartsWithFixedContainer(await importOriginal<typeof import('recharts')>());
});

installGrowthScreenHarness();

/** The toolbar's status line, which is where the page states its page-level facts. */
function statusLine(): HTMLElement {
  const status = document.querySelector('[data-slot="growth-status"]');
  if (status === null) throw new Error('no status line in the toolbar');
  return status as HTMLElement;
}

describe('GrowthScreen staleness', () => {
  it('says the figures reflect the database now rather than as of the week', async () => {
    stubFetch();
    renderScreen();
    await screenReady();
    expect(screen.getByText(/reflect the database now/i)).toBeInTheDocument();
  });
});

describe('GrowthScreen data edge', () => {
  /** The sentence the page states about how far its data reaches. */
  function dataEdgeText(): string {
    const note = document.querySelector('[data-slot="data-edge-note"]');
    if (note === null) throw new Error('no data-edge note on the page');
    return note.textContent;
  }

  const WEEK_START_DAY = isoAt(WEEK_START).slice(0, 10);
  const STOPPED_DAY = isoAt(WEEK_START - 10 * DAY_MS).slice(0, 10);
  const PREVIOUS_WEEK_DAY = isoAt(WEEK_START - 7 * DAY_MS).slice(0, 10);

  /** Freshness with the two day-grained sets stopping on a day, the rest silent. */
  function runningThrough(day: string): GrowthFreshnessWire {
    return {
      funnel: null,
      sources: null,
      marketing: { grain: 'day', runsThrough: day },
      events: { grain: 'day', runsThrough: day },
    };
  }

  it('states the day the data runs through when the data reaches the week selected', async () => {
    stubFetch({ freshness: runningThrough(WEEK_START_DAY) });
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(dataEdgeText()).toBe(`Data runs through ${WEEK_START_DAY}.`);
    });
  });

  it('states the newest day its data reaches when that day is before the week selected', async () => {
    stubFetch({ freshness: runningThrough(STOPPED_DAY), funnelWeeks: [] });
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(screen.getByText('No ladder for this week.')).toBeInTheDocument();
    });
    expect(dataEdgeText()).toBe(
      `Data runs through ${STOPPED_DAY}, before the week selected: no growth data reaches that week, so a week-scoped panel below is empty for want of data rather than for want of traffic.`
    );
  });

  it('names the week a week-grouped set opens rather than a day its data runs through', async () => {
    stubFetch({
      freshness: {
        funnel: { grain: 'week', weekOpening: WEEK_START_DAY },
        sources: { grain: 'week', weekOpening: WEEK_START_DAY },
        marketing: null,
        events: null,
      },
    });
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(dataEdgeText()).toBe(`The newest data is in the week beginning ${WEEK_START_DAY}.`);
    });
  });

  it('states no day when no growth data set holds a row', async () => {
    stubFetch({
      freshness: { funnel: null, sources: null, marketing: null, events: null },
      funnelWeeks: [],
    });
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(screen.getByText('No ladder for this week.')).toBeInTheDocument();
    });
    expect(dataEdgeText()).toBe(
      'No growth data set holds a row yet, so there is no newest day to state.'
    );
  });

  it('drops the empty-panel clause once a week the data reaches is selected', async () => {
    stubFetch({ freshness: runningThrough(PREVIOUS_WEEK_DAY) });
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(dataEdgeText()).toContain('before the week selected');
    });
    await chooseWeek(WEEK_START - 7 * DAY_MS);
    await waitFor(() => {
      expect(dataEdgeText()).toBe(`Data runs through ${PREVIOUS_WEEK_DAY}.`);
    });
  });

  it('declares its limit over the day it states rather than over counts', async () => {
    stubFetch({ freshness: runningThrough(WEEK_START_DAY) });
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(statusLine()).toHaveTextContent(
        'Covers every campaign, not the selection above: the edge of the data carries no ' +
          'campaign. Not limited to the week selected above.'
      );
    });
  });

  it('draws the clause it declares that limit in from the one the panels use', async () => {
    stubFetch({ freshness: runningThrough(WEEK_START_DAY) });
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(statusLine()).toHaveTextContent(
        panelScopeNote({ campaigns: DATA_EDGE_NO_CAMPAIGN, window: { kind: 'unwindowed' } }) ?? ''
      );
    });
  });

  it('states the refusal rather than a sentence about the data when its read fails', async () => {
    stubFetch({ failing: new Set(['growth.freshness.read']) });
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(within(statusLine()).getByText('UNAVAILABLE').tagName).toBe('CODE');
    });
    expect(document.querySelector('[data-slot="data-edge-note"]')).toBeNull();
  });

  it('says the read failed rather than that the data stops before the week', async () => {
    stubFetch({ failing: new Set(['growth.freshness.read']) });
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(statusLine()).toHaveTextContent('how far the data reaches is unknown');
    });
    expect(statusLine()).not.toHaveTextContent('runs through');
  });

  it('states nothing about the data before its read has answered', async () => {
    stubFetch({ pending: new Set(['growth.freshness.read']) });
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(screen.getByText('Campaign: hn-launch')).toBeInTheDocument();
    });
    expect(statusLine().querySelector('[data-slot="skeleton"]')).toBeInTheDocument();
    expect(document.querySelector('[data-slot="data-edge-note"]')).toBeNull();
  });

  it('states the same day whatever the controls are narrowed to', async () => {
    stubFetch({ freshness: runningThrough(WEEK_START_DAY) });
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(dataEdgeText()).toBe(`Data runs through ${WEEK_START_DAY}.`);
    });
    const oneDay = isoAt(TEST_DAY_START).slice(0, 10);
    fireEvent.change(screen.getByLabelText('From'), { target: { value: oneDay } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: oneDay } });
    await chooseGrain('Hour');
    await chooseWeek(WEEK_START - 11 * 7 * DAY_MS);
    await chooseCampaigns('hn-launch');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Campaigns/ })).toHaveTextContent('1 of 1');
    });
    expect(dataEdgeText()).toBe(`Data runs through ${WEEK_START_DAY}.`);
  });
});
