import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClientProvider, useQuery } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';

vi.mock('@/lib/auth/auth', () => ({
  useSession: vi.fn(),
}));

vi.mock('@/lib/api/api', () => ({
  getApiUrl: () => 'http://localhost:8787',
  ApiError: class ApiError extends Error {},
}));

vi.mock('@/lib/platform/env', () => ({
  env: { isLocalDev: false },
}));

vi.mock('@/lib/api-client.js', () => ({
  client: {
    billing: { spendable: { $get: vi.fn() } },
    conversations: {
      ':conversationId': { funding: { $get: vi.fn() }, budgets: { $get: vi.fn() } },
    },
  },
  fetchJson: vi.fn(),
}));

vi.mock('@/lib/auth/link-guest-auth.js', () => ({
  getLinkGuestAuth: () => null,
}));

import { useSession } from '@/lib/auth/auth';
import { fetchJson } from '@/lib/api-client.js';
import { queryClient } from '@/providers/query-provider';
import { useSpendable } from '@/hooks/billing/use-spendable.js';
import { useConversationBudgets } from '@/hooks/billing/use-conversation-budgets.js';

const mockedUseSession = vi.mocked(useSession);
const mockedFetchJson = vi.mocked(fetchJson);

/**
 * The APP's own client, deliberately — not a test client. The blackout these
 * cases reproduce is produced by the app's global defaults (five-minute stale
 * time, focus refetching off), so a client that restates them could drift out
 * of agreement with the shipped one and pass while the app still blacks out.
 */
function AppClientWrapper({ children }: Readonly<{ children: ReactNode }>): React.JSX.Element {
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

/** The production focus signal: query-core listens for `visibilitychange`. */
function focusWindow(): void {
  act(() => {
    globalThis.dispatchEvent(new Event('visibilitychange'));
  });
}

const HELD = {
  spendableNanoUsd: '200000000',
  heldNanoUsd: '800000000',
  payerTier: 'paid',
  payer: 'self',
};

const RELEASED = {
  spendableNanoUsd: '1000000000',
  heldNanoUsd: '0',
  payerTier: 'paid',
  payer: 'self',
};

const BUDGETS_HELD = {
  conversationCapNanoUsd: '1000000000',
  conversationSpentNanoUsd: '0',
  ownerBalanceNanoUsd: '1000000000',
  members: [{ effectiveRemainingNanoUsd: '200000000' }],
};

const BUDGETS_RELEASED = {
  ...BUDGETS_HELD,
  members: [{ effectiveRemainingNanoUsd: '1000000000' }],
};

describe('freshness on a socket-less surface', () => {
  /**
   * What the server would return right now. A mutable snapshot rather than a
   * `mockResolvedValueOnce` chain: an unconsumed queued value survives
   * `clearAllMocks` and leaks into the next case, which is exactly what a
   * blackout case looks like when it is red.
   */
  let currentSnapshot: unknown;

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient.clear();
    mockedUseSession.mockReturnValue({
      data: { user: { id: 'user-1' } },
    } as unknown as ReturnType<typeof useSession>);
    mockedFetchJson.mockReset();
    mockedFetchJson.mockImplementation(() => Promise.resolve(currentSnapshot));
  });

  afterEach(() => {
    queryClient.clear();
  });

  // A surface with no conversation socket receives no run frame at all, so the
  // realtime invalidations cannot reach it and the served hold stays on screen
  // for the whole stale window. BILLING §Notices & Refusals 9: a blackout that
  // outlives the run it describes is a defect.
  it('window focus refreshes the served spendable snapshot inside the stale window', async () => {
    currentSnapshot = HELD;

    const { result } = renderHook(() => useSpendable(), { wrapper: AppClientWrapper });
    await waitFor(() => {
      expect(result.current.data).toEqual(HELD);
    });

    currentSnapshot = RELEASED;
    focusWindow();

    await waitFor(() => {
      expect(result.current.data).toEqual(RELEASED);
    });
  });

  it('window focus refreshes the hold-aware conversation budget inside the stale window', async () => {
    currentSnapshot = BUDGETS_HELD;

    const { result } = renderHook(() => useConversationBudgets('conv-1'), {
      wrapper: AppClientWrapper,
    });
    await waitFor(() => {
      expect(result.current.data).toEqual(BUDGETS_HELD);
    });

    currentSnapshot = BUDGETS_RELEASED;
    focusWindow();

    await waitFor(() => {
      expect(result.current.data).toEqual(BUDGETS_RELEASED);
    });
  });

  // The narrowing, not an incidental default: the two cases above prove the
  // focus signal reaches this client, so a key outside the funding families
  // staying put is evidence of scope rather than of a dead event. This case
  // goes red if the policy is ever moved to the client's global defaults.
  it('leaves focus refetching off for every key outside the funding families', async () => {
    const fetchUnrelated = vi.fn().mockResolvedValue('unrelated');

    renderHook(() => useQuery({ queryKey: ['not-funding'], queryFn: fetchUnrelated }), {
      wrapper: AppClientWrapper,
    });
    await waitFor(() => {
      expect(fetchUnrelated).toHaveBeenCalledTimes(1);
    });

    focusWindow();
    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchUnrelated).toHaveBeenCalledTimes(1);
  });
});
