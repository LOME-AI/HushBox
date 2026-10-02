import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

vi.mock('@/lib/api-client.js', () => ({
  client: {
    chat: {
      trial: {
        remaining: { $get: vi.fn() },
      },
    },
  },
  fetchJson: vi.fn(),
}));

vi.mock('@/lib/chat/trial-token.js', () => ({
  peekTrialToken: vi.fn(),
}));

vi.mock('@tanstack/react-query', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query');
  return {
    ...actual,
    useQuery: vi.fn(actual.useQuery),
  };
});

import { useQuery } from '@tanstack/react-query';
import { trialDailyMessageAllowance } from '@hushbox/shared';
import { client, fetchJson } from '@/lib/api-client.js';
import { peekTrialToken } from '@/lib/chat/trial-token.js';
import { trialRemainingKeys, useTrialRemaining } from '@/hooks/chat/use-trial-remaining.js';

const mockedUseQuery = vi.mocked(useQuery);
const mockedFetchJson = vi.mocked(fetchJson);
const mockedPeek = vi.mocked(peekTrialToken);
const mockedGet = vi.mocked(client.chat.trial.remaining.$get);

const refetch = vi.fn();

function stubQuery(data?: unknown): void {
  mockedUseQuery.mockReturnValue({ data, refetch } as unknown as ReturnType<typeof useQuery>);
}

/** The options the hook handed `useQuery` on its most recent render. */
function lastQueryOptions(): {
  queryKey: unknown;
  queryFn: () => unknown;
  enabled: boolean;
} {
  const call = mockedUseQuery.mock.calls.at(-1);
  if (!call) throw new Error('useQuery was never called');
  return call[0] as { queryKey: unknown; queryFn: () => unknown; enabled: boolean };
}

describe('trialRemainingKeys', () => {
  it('keys the read under one stable name', () => {
    expect(trialRemainingKeys.all).toEqual(['trial', 'remaining']);
  });
});

describe('useTrialRemaining', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubQuery();
  });

  it('serves the count the read returned', () => {
    stubQuery({ remaining: 3 });

    const { result } = renderHook(() => useTrialRemaining({ enabled: true, runInFlight: false }));

    expect(result.current.remaining).toBe(3);
  });

  it('serves nothing when the read is unavailable', () => {
    stubQuery();

    const { result } = renderHook(() => useTrialRemaining({ enabled: true, runInFlight: false }));

    expect(result.current.remaining).toBeUndefined();
  });

  it('serves nothing to a caller with no trial allowance, even from a warm cache', () => {
    stubQuery({ remaining: 3 });

    const { result } = renderHook(() => useTrialRemaining({ enabled: false, runInFlight: false }));

    expect(result.current.remaining).toBeUndefined();
  });

  /**
   * The verdict, held here rather than at the surface that renders it. Whether
   * today's preview has been drawn on is a comparison against the trial's
   * declared allowance, and a component making it holds a money figure of its
   * own — which is what a second surface would eventually disagree with.
   */
  it('calls the day untouched while the whole declared allowance is still there', () => {
    stubQuery({ remaining: trialDailyMessageAllowance() });

    const { result } = renderHook(() => useTrialRemaining({ enabled: true, runInFlight: false }));

    expect(result.current.allowanceUntouched).toBe(true);
  });

  it('calls the day spent-into the moment one message of it is gone', () => {
    stubQuery({ remaining: trialDailyMessageAllowance() - 1 });

    const { result } = renderHook(() => useTrialRemaining({ enabled: true, runInFlight: false }));

    expect(result.current.allowanceUntouched).toBe(false);
  });

  it('calls the day untouched when no count came back, so nothing is said on a guess', () => {
    stubQuery();

    const { result } = renderHook(() => useTrialRemaining({ enabled: true, runInFlight: false }));

    expect(result.current.allowanceUntouched).toBe(true);
  });

  it('calls the day untouched for a caller with no trial allowance to spend', () => {
    stubQuery({ remaining: 0 });

    const { result } = renderHook(() => useTrialRemaining({ enabled: false, runInFlight: false }));

    expect(result.current.allowanceUntouched).toBe(true);
  });

  it('disables the read for a caller with no trial allowance', () => {
    renderHook(() => useTrialRemaining({ enabled: false, runInFlight: false }));

    expect(lastQueryOptions().enabled).toBe(false);
  });

  it('reads under the trial-remaining key', () => {
    renderHook(() => useTrialRemaining({ enabled: true, runInFlight: false }));

    expect(lastQueryOptions().queryKey).toEqual(trialRemainingKeys.all);
  });

  it('sends the stored trial token so the read is keyed on this session', () => {
    mockedPeek.mockReturnValue('token-abc');
    renderHook(() => useTrialRemaining({ enabled: true, runInFlight: false }));

    lastQueryOptions().queryFn();

    expect(mockedGet).toHaveBeenCalledWith({}, { headers: { 'x-trial-token': 'token-abc' } });
  });

  it('omits the header when no token is stored, leaving the server on the IP counter', () => {
    mockedPeek.mockReturnValue(null);
    renderHook(() => useTrialRemaining({ enabled: true, runInFlight: false }));

    lastQueryOptions().queryFn();

    expect(mockedGet).toHaveBeenCalledWith({}, {});
  });

  it('unwraps the response through the typed client', () => {
    mockedPeek.mockReturnValue(null);
    renderHook(() => useTrialRemaining({ enabled: true, runInFlight: false }));

    lastQueryOptions().queryFn();

    expect(mockedFetchJson).toHaveBeenCalledTimes(1);
  });

  it('re-reads once the run that spent a message ends', () => {
    const { rerender } = renderHook(
      ({ runInFlight }) => useTrialRemaining({ enabled: true, runInFlight }),
      { initialProps: { runInFlight: true } }
    );
    expect(refetch).not.toHaveBeenCalled();

    rerender({ runInFlight: false });

    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('does not re-read while the run is still streaming', () => {
    const { rerender } = renderHook(
      ({ runInFlight }) => useTrialRemaining({ enabled: true, runInFlight }),
      { initialProps: { runInFlight: false } }
    );

    rerender({ runInFlight: true });

    expect(refetch).not.toHaveBeenCalled();
  });

  it('does not re-read for a caller with no trial allowance', () => {
    const { rerender } = renderHook(
      ({ runInFlight }) => useTrialRemaining({ enabled: false, runInFlight }),
      { initialProps: { runInFlight: true } }
    );

    rerender({ runInFlight: false });

    expect(refetch).not.toHaveBeenCalled();
  });
});
