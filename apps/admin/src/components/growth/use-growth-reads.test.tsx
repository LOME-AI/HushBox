import * as React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { growthDayBucket } from '@hushbox/shared';
import { DAY_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { requestUrl } from '@/test-utils/request-url';
import {
  growthKeys,
  useGrowthCampaigns,
  useGrowthFreshness,
  useGrowthFunnel,
  useGrowthReach,
} from './use-growth-reads.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const WINDOW = { from: isoAt(TEST_DAY_START), to: isoAt(TEST_DAY_START + 7 * DAY_MS) } as const;

/** What the global fetch is called with, so a stub can declare it once. */
type FetchInput = string | URL | Request;

/** The request body as the stub recorded it — always a JSON string here. */
function bodyOf(init: RequestInit | undefined): string {
  return typeof init?.body === 'string' ? init.body : '';
}

function wrapper({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function readResponse(data: unknown): Response {
  return Response.json(
    { kind: 'read', auditId: '00000000-0000-7000-8000-000000000000', data },
    { status: 200 }
  );
}

const FUNNEL_DATA = {
  panels: {
    funnel: {
      ok: true,
      data: {
        weeks: [
          {
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
          },
        ],
      },
    },
  },
};

describe('growthKeys', () => {
  it('namespaces every growth query under admin growth', () => {
    expect(growthKeys.funnel(WINDOW)[0]).toBe('admin');
    expect(growthKeys.funnel(WINDOW)[1]).toBe('growth');
  });

  it('keys a campaign-filtered funnel apart from the unfiltered one', () => {
    expect(growthKeys.funnel(WINDOW, 'hn-launch')).not.toEqual(growthKeys.funnel(WINDOW));
  });
});

describe('useGrowthFunnel', () => {
  it('posts the read through the operation execute route', async () => {
    const fetchMock = vi.fn((_input: FetchInput, _init?: RequestInit) =>
      Promise.resolve(readResponse(FUNNEL_DATA))
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useGrowthFunnel(WINDOW), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(requestUrl(fetchMock.mock.calls[0]![0])).toContain(
      '/api/admin/ops/growth.funnel.read/execute'
    );
  });

  it('sends the window as the operation input', async () => {
    const fetchMock = vi.fn((_input: FetchInput, _init?: RequestInit) =>
      Promise.resolve(readResponse(FUNNEL_DATA))
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useGrowthFunnel(WINDOW), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(JSON.parse(bodyOf(fetchMock.mock.calls[0]?.[1]))).toEqual({ input: WINDOW });
  });

  it('includes the campaign in the input only when one is selected', async () => {
    const fetchMock = vi.fn((_input: FetchInput, _init?: RequestInit) =>
      Promise.resolve(readResponse(FUNNEL_DATA))
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useGrowthFunnel(WINDOW, 'hn-launch'), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(JSON.parse(bodyOf(fetchMock.mock.calls[0]?.[1])).input.campaign).toBe('hn-launch');
  });

  it('unwraps the read envelope and returns the panel payload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(readResponse(FUNNEL_DATA)))
    );

    const { result } = renderHook(() => useGrowthFunnel(WINDOW), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    const panel = result.current.data?.panels.funnel;
    expect(panel?.ok === true && panel.data.weeks[0]?.campaign).toBe('hn-launch');
  });

  it('keeps a degraded panel as a failure inside a successful read', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(readResponse({ panels: { funnel: { ok: false, error: 'UNAVAILABLE' } } }))
      )
    );

    const { result } = renderHook(() => useGrowthFunnel(WINDOW), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    const panel = result.current.data?.panels.funnel;
    expect(panel?.ok === false && panel.error).toBe('UNAVAILABLE');
  });

  it('rejects a mutation result arriving where a read was asked for', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          Response.json(
            { auditId: '00000000-0000-7000-8000-000000000000', effects: [], inverseInput: null },
            { status: 200 }
          )
        )
      )
    );

    const { result } = renderHook(() => useGrowthFunnel(WINDOW), { wrapper });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
  });

  it('rejects a payload whose panel shape has drifted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(readResponse({ panels: { funnel: { ok: true, data: {} } } })))
    );

    const { result } = renderHook(() => useGrowthFunnel(WINDOW), { wrapper });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
  });

  it('surfaces a refused read as an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ code: 'FORBIDDEN_ROLE' }, { status: 403 })))
    );

    const { result } = renderHook(() => useGrowthFunnel(WINDOW), { wrapper });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
  });
});

describe('useGrowthCampaigns', () => {
  it('sends an empty input for the read that takes no window', async () => {
    const fetchMock = vi.fn((_input: FetchInput, _init?: RequestInit) =>
      Promise.resolve(readResponse({ panels: { campaigns: { ok: true, data: { rows: [] } } } }))
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useGrowthCampaigns(), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(JSON.parse(bodyOf(fetchMock.mock.calls[0]?.[1]))).toEqual({ input: {} });
  });
});

describe('useGrowthReach', () => {
  it('returns the landing to reached rows the server sent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          readResponse({
            panels: {
              reach: {
                ok: true,
                data: {
                  rows: [
                    {
                      landingPath: '/welcome',
                      reachedPath: '/pricing',
                      visitorsDailySummed: 402,
                      overflow: false,
                    },
                  ],
                },
              },
            },
          })
        )
      )
    );

    const { result } = renderHook(() => useGrowthReach(WINDOW), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    const panel = result.current.data?.panels.reach;
    expect(panel?.ok === true && panel.data.rows[0]?.visitorsDailySummed).toBe(402);
  });
});

describe('useGrowthFreshness', () => {
  const FUNNEL_DAY = growthDayBucket(new Date(TEST_DAY_START - 3 * DAY_MS));
  const SOURCES_DAY = growthDayBucket(new Date(TEST_DAY_START - 10 * DAY_MS));
  const MARKETING_DAY = growthDayBucket(new Date(TEST_DAY_START));
  const FRESHNESS = {
    panels: {
      freshness: {
        ok: true,
        data: {
          funnel: { grain: 'week', weekOpening: FUNNEL_DAY },
          sources: { grain: 'week', weekOpening: SOURCES_DAY },
          marketing: { grain: 'day', runsThrough: MARKETING_DAY },
          events: null,
        },
      },
    },
  };

  it('sends no input, so no control the page holds can narrow it', async () => {
    const fetchMock = vi.fn((_input: FetchInput, _init?: RequestInit) =>
      Promise.resolve(readResponse(FRESHNESS))
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useGrowthFreshness(), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(requestUrl(fetchMock.mock.calls[0]![0])).toContain(
      '/api/admin/ops/growth.freshness.read/execute'
    );
    expect(JSON.parse(bodyOf(fetchMock.mock.calls[0]?.[1]))).toEqual({ input: {} });
  });

  it('returns the newest day of each data set, and no day where a set holds nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(readResponse(FRESHNESS)))
    );

    const { result } = renderHook(() => useGrowthFreshness(), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    const panel = result.current.data?.panels.freshness;
    expect(panel?.ok === true && panel.data.marketing).toEqual({
      grain: 'day',
      runsThrough: MARKETING_DAY,
    });
    expect(panel?.ok === true && panel.data.events).toBeNull();
  });

  it('keys itself apart from every windowed read', () => {
    expect(growthKeys.freshness()).toEqual(['admin', 'growth', 'freshness']);
  });
});
