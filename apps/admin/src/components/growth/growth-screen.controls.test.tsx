import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MAX_GROWTH_READ_WINDOW_DAYS } from '@hushbox/shared';
import { DAY_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import {
  DEFAULT_EVENT_ROWS,
  GROWTH_READ_OPS,
  requestedWindow,
  requestedPage,
  stubFetch,
  renderScreen,
  screenReady,
  settleFrame,
  chooseCampaigns,
  chooseGrain,
  scopeNoteOf,
  SERIES_PANEL,
  NO_CAMPAIGN_CLAUSE,
  installGrowthScreenHarness,
} from './test-support/growth-screen-harness.setup.js';
import type { GrowthMarketingRowWire } from '@hushbox/shared';

vi.mock('@/components/ops/op-modal-provider', () => ({
  useRunOp: () => vi.fn(),
}));

vi.mock('recharts', async (importOriginal) => {
  const { rechartsWithFixedContainer } =
    await import('./test-support/recharts-fixed-container.setup.js');
  return rechartsWithFixedContainer(await importOriginal<typeof import('recharts')>());
});

installGrowthScreenHarness();

/** The page the last events read asked for, off the body the typed client sent. */
function lastEventsPage(fetchMock: ReturnType<typeof vi.fn>): number {
  const reads = fetchMock.mock.calls.filter((call) =>
    String(call[0]).includes('/ops/growth.events.read/execute')
  );
  const last = reads.at(-1);
  if (last === undefined) throw new Error('no events read was issued');
  return requestedPage(last[1] as RequestInit | undefined);
}

describe('GrowthScreen campaign controls', () => {
  it('draws the campaign controls when the catalogue names both mutations', async () => {
    stubFetch({
      catalogOps: [...GROWTH_READ_OPS, 'growth.campaign.create', 'growth.campaign.archive'],
    });
    renderScreen();
    await screenReady();
    expect(await screen.findByRole('button', { name: /Create campaign/ })).toBeInTheDocument();
  });

  it('omits the campaign controls when the catalogue names only reads', async () => {
    stubFetch();
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(screen.getByRole('cell', { name: 'hn-launch' })).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /Create campaign/ })).not.toBeInTheDocument();
  });
});

describe('GrowthScreen filters', () => {
  it('offers a week picker', async () => {
    stubFetch();
    renderScreen();
    await screenReady();
    expect(screen.getByRole('combobox', { name: /^Week/ })).toBeInTheDocument();
  });

  it('offers an hour grain toggle for the visitor series', async () => {
    stubFetch();
    renderScreen();
    await screenReady();
    expect(screen.getByRole('radio', { name: 'Hour' })).toBeInTheDocument();
  });

  it('re-reads the marketing series when the grain changes', async () => {
    const fetchMock = stubFetch();
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(screen.getByRole('listitem', { name: /news\.ycombinator\.com/ })).toBeInTheDocument();
    });
    await chooseGrain('Hour');
    await waitFor(() => {
      const marketingReads = fetchMock.mock.calls.filter((call) =>
        String(call[0]).includes('/ops/growth.marketing.read/execute')
      );
      expect(marketingReads.length).toBeGreaterThan(1);
    });
  });
});

describe('GrowthScreen campaign filtering', () => {
  it('drops a ladder whose campaign is filtered out', async () => {
    stubFetch();
    renderScreen();
    await screenReady();
    await chooseCampaigns('hn-launch');
    expect(screen.getByText('Campaign: hn-launch')).toBeInTheDocument();
    await chooseCampaigns('hn-launch');
    await waitFor(() => {
      expect(screen.getByText('Campaign: hn-launch')).toBeInTheDocument();
    });
  });

  it('re-reads the events panel when the campaign scope narrows', async () => {
    const fetchMock = stubFetch();
    renderScreen();
    await screenReady();
    await chooseCampaigns('hn-launch');
    await waitFor(() => {
      const eventReads = fetchMock.mock.calls.filter((call) =>
        String(call[0]).includes('/ops/growth.events.read/execute')
      );
      expect(eventReads.length).toBeGreaterThan(1);
    });
  });

  it('returns the named events to their first page when a campaign is toggled', async () => {
    const fetchMock = stubFetch({ eventRows: DEFAULT_EVENT_ROWS, eventsHaveMore: true });
    renderScreen();
    await screenReady();
    await userEvent.click(await screen.findByRole('button', { name: 'Next page' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Next page' }));
    await waitFor(() => {
      expect(lastEventsPage(fetchMock)).toBe(2);
    });
    await chooseCampaigns('hn-launch');
    await waitFor(() => {
      expect(lastEventsPage(fetchMock)).toBe(0);
    });
  });
});

describe('GrowthScreen grain toggle', () => {
  it('returns the series to the day grain when asked', async () => {
    stubFetch();
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(screen.getByRole('listitem', { name: /news\.ycombinator\.com/ })).toBeInTheDocument();
    });
    await chooseGrain('Hour');
    await chooseGrain('Day');
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'Day' })).toHaveAttribute('data-state', 'on');
    });
  });
});

describe('GrowthScreen day range', () => {
  /** The first day the screen opens on, ninety days back from the day it opened in. */
  const OPENING_FROM = isoAt(TEST_DAY_START - 89 * DAY_MS);
  const PAST_START = isoAt(TEST_DAY_START - 13 * DAY_MS).slice(0, 10);
  const PAST_END = isoAt(TEST_DAY_START - 7 * DAY_MS).slice(0, 10);

  /** A marketing row naming one referrer, so which range answered is readable on the page. */
  function referrerRow(host: string): GrowthMarketingRowWire {
    return {
      bucket: isoAt(TEST_DAY_START - 10 * DAY_MS),
      family: 'referrer',
      path: '/welcome',
      referrerHost: host,
      campaign: null,
      country: null,
      region: null,
      device: null,
      visitors: 412,
      landings: null,
      overflow: false,
    };
  }

  /** Every call the visitor series made, newest last. */
  function marketingCalls(fetchMock: ReturnType<typeof vi.fn>): readonly unknown[][] {
    return fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes('/ops/growth.marketing.read/execute')
    );
  }

  async function setRangeStart(day: string): Promise<void> {
    fireEvent.change(screen.getByLabelText('From'), { target: { value: day } });
    await settleFrame();
  }

  async function setRangeEnd(day: string): Promise<void> {
    fireEvent.change(screen.getByLabelText('To'), { target: { value: day } });
    await settleFrame();
  }

  it('offers a start day', async () => {
    stubFetch();
    renderScreen();
    await screenReady();
    expect(screen.getByLabelText('From')).toBeInTheDocument();
  });

  it('offers an end day', async () => {
    stubFetch();
    renderScreen();
    await screenReady();
    expect(screen.getByLabelText('To')).toBeInTheDocument();
  });

  it('answers a changed range with what that range holds', async () => {
    stubFetch({
      marketingRowsByWindow: (window) => [
        referrerRow(window.from === OPENING_FROM ? 'news.ycombinator.com' : 'lobste.rs'),
      ],
    });
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(screen.getByRole('listitem', { name: /news\.ycombinator\.com/ })).toBeInTheDocument();
    });
    await setRangeStart(PAST_START);
    await setRangeEnd(PAST_END);
    await waitFor(() => {
      expect(screen.getByRole('listitem', { name: /lobste\.rs/ })).toBeInTheDocument();
    });
  });

  it('asks for the range an operator set', async () => {
    const fetchMock = stubFetch();
    renderScreen();
    await screenReady();
    await setRangeStart(PAST_START);
    await setRangeEnd(PAST_END);
    await waitFor(() => {
      const last = marketingCalls(fetchMock).at(-1);
      expect(requestedWindow(last?.[1] as RequestInit | undefined)).toEqual({
        from: isoAt(TEST_DAY_START - 13 * DAY_MS),
        to: isoAt(TEST_DAY_START - 6 * DAY_MS),
      });
    });
  });

  it('refuses a range wider than the read cap where the operator set it', async () => {
    stubFetch();
    renderScreen();
    await screenReady();
    await setRangeStart(isoAt(TEST_DAY_START - MAX_GROWTH_READ_WINDOW_DAYS * DAY_MS).slice(0, 10));
    await waitFor(() => {
      expect(
        screen.getByText(`Pick a range of at most ${String(MAX_GROWTH_READ_WINDOW_DAYS)} days.`)
      ).toBeInTheDocument();
    });
  });

  it('spends no read on a range it refused', async () => {
    const fetchMock = stubFetch();
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(screen.getByRole('listitem', { name: /news\.ycombinator\.com/ })).toBeInTheDocument();
    });
    const before = marketingCalls(fetchMock).length;
    await setRangeStart(isoAt(TEST_DAY_START - MAX_GROWTH_READ_WINDOW_DAYS * DAY_MS).slice(0, 10));
    await waitFor(() => {
      expect(
        screen.getByText(`Pick a range of at most ${String(MAX_GROWTH_READ_WINDOW_DAYS)} days.`)
      ).toBeInTheDocument();
    });
    expect(marketingCalls(fetchMock)).toHaveLength(before);
  });

  it('re-asks the range it is showing when the reads are refreshed', async () => {
    const fetchMock = stubFetch();
    renderScreen();
    await screenReady();
    await setRangeStart(PAST_START);
    await setRangeEnd(PAST_END);
    await waitFor(() => {
      expect(marketingCalls(fetchMock).length).toBeGreaterThan(1);
    });
    const spent = marketingCalls(fetchMock).length;
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => {
      expect(marketingCalls(fetchMock).length).toBeGreaterThan(spent);
    });
    const last = marketingCalls(fetchMock).at(-1);
    expect(requestedWindow(last?.[1] as RequestInit | undefined)).toEqual({
      from: isoAt(TEST_DAY_START - 13 * DAY_MS),
      to: isoAt(TEST_DAY_START - 6 * DAY_MS),
    });
  });

  it('turns the day range off at the grain that reads the selected week instead', async () => {
    stubFetch();
    renderScreen();
    await screenReady();
    await chooseGrain('Hour');
    await waitFor(() => {
      expect(screen.getByLabelText('From')).toBeDisabled();
    });
  });

  it('says why the day range is off at the hour grain', async () => {
    stubFetch();
    renderScreen();
    await screenReady();
    await chooseGrain('Hour');
    await waitFor(() => {
      expect(
        screen.getByText('The hour grain reads the week selected, so the day range is off.')
      ).toBeInTheDocument();
    });
  });

  it('states the trailing span the page opens on before any day is set', async () => {
    stubFetch();
    renderScreen();
    await screenReady();
    await waitFor(() => {
      expect(scopeNoteOf(SERIES_PANEL)).toBe(
        `${NO_CAMPAIGN_CLAUSE} Covers the last 90 days, not the week selected above.`
      );
    });
  });

  it('names both days of the range its read asked for once the range ends before today', async () => {
    const fetchMock = stubFetch();
    renderScreen();
    await screenReady();
    await setRangeStart(PAST_START);
    await setRangeEnd(PAST_END);
    await waitFor(() => {
      expect(marketingCalls(fetchMock).length).toBeGreaterThan(1);
    });
    const asked = requestedWindow(marketingCalls(fetchMock).at(-1)?.[1] as RequestInit | undefined);
    const firstDay = asked.from.slice(0, 10);
    const lastDay = isoAt(Date.parse(asked.to) - DAY_MS).slice(0, 10);
    await waitFor(() => {
      expect(scopeNoteOf(SERIES_PANEL)).toBe(
        `${NO_CAMPAIGN_CLAUSE} Covers ${firstDay} to ${lastDay}, the range set above.`
      );
    });
  });

  it('still names a trailing run of days where the range ends on the day the page opened in', async () => {
    stubFetch();
    renderScreen();
    await screenReady();
    await setRangeStart(isoAt(TEST_DAY_START - 29 * DAY_MS).slice(0, 10));
    await waitFor(() => {
      expect(scopeNoteOf(SERIES_PANEL)).toBe(
        `${NO_CAMPAIGN_CLAUSE} Covers the last 30 days, not the week selected above.`
      );
    });
  });

  it('keeps naming the range still being read after an edit it refused', async () => {
    stubFetch();
    renderScreen();
    await screenReady();
    await setRangeStart(PAST_START);
    await setRangeEnd(PAST_END);
    await waitFor(() => {
      expect(scopeNoteOf(SERIES_PANEL)).toContain(`Covers ${PAST_START} to ${PAST_END}`);
    });
    await setRangeStart(
      isoAt(TEST_DAY_START - (MAX_GROWTH_READ_WINDOW_DAYS + 7) * DAY_MS).slice(0, 10)
    );
    await waitFor(() => {
      expect(
        screen.getByText(`Pick a range of at most ${String(MAX_GROWTH_READ_WINDOW_DAYS)} days.`)
      ).toBeInTheDocument();
    });
    expect(scopeNoteOf(SERIES_PANEL)).toBe(
      `${NO_CAMPAIGN_CLAUSE} Covers ${PAST_START} to ${PAST_END}, the range set above.`
    );
  });
});
