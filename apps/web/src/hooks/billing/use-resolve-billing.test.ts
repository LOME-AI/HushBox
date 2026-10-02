import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  useResolveBilling,
  type UseResolveBillingInput,
} from '@/hooks/billing/use-resolve-billing';

vi.mock('@/hooks/billing/billing', () => ({
  useBalance: vi.fn(),
}));

vi.mock('@/hooks/billing/use-spendable', () => ({
  useFundingRead: vi.fn(),
}));

const { mockLinkGuest } = vi.hoisted(() => ({
  mockLinkGuest: { current: null as string | null },
}));

vi.mock('@/lib/auth/link-guest-auth', () => ({
  getLinkGuestAuth: () => mockLinkGuest.current,
}));

vi.mock('@/providers/stability-provider', () => ({
  useStability: vi.fn(() => ({
    isAuthStable: true,
    isBalanceStable: true,
    isAppStable: true,
  })),
}));

import { useBalance } from '@/hooks/billing/billing';
import { useFundingRead, type FundingRead } from '@/hooks/billing/use-spendable';
import type { UseQueryResult } from '@tanstack/react-query';
import type { GetBalanceResponse, GetSpendableResponse } from '@hushbox/shared';

const mockUseBalance = vi.mocked(useBalance);
const mockUseFundingRead = vi.mocked(useFundingRead);

function spendable(spendableNanoUsd: string): FundingRead {
  return {
    status: 'served',
    snapshot: { spendableNanoUsd, heldNanoUsd: '0' } as GetSpendableResponse,
  };
}

// Balance wire shape: purchased (negative-capable) + free-tier allowance, all
// NanoUSD strings. $1 = 1_000_000_000 nano.
function balance(purchasedNanoUsd: string, remainingNanoUsd: string): GetBalanceResponse {
  return {
    purchased: { balanceNanoUsd: purchasedNanoUsd },
    free: { balanceNanoUsd: '0' },
    allowance: {
      day: '2026-07-11',
      limitNanoUsd: '5000000000',
      spentNanoUsd: '0',
      remainingNanoUsd,
    },
  };
}

describe('useResolveBilling', () => {
  const defaultInput: UseResolveBillingInput = {
    estimatedMinimumCostNanoUsd: 40_000_000n, // 4¢
    isPremiumModel: false,
    isAuthenticated: true,
    conversationId: null,
  };

  beforeEach(() => {
    mockUseBalance.mockReturnValue({
      data: balance('10000000000', '5000000000'),
      isPending: false,
    } as UseQueryResult<GetBalanceResponse>);
    // Served spendable: $10 balance + 50¢ baked cushion.
    mockUseFundingRead.mockReturnValue(spendable('10500000000'));
    mockLinkGuest.current = null;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns personal_balance for paid user with sufficient balance', () => {
    const { result } = renderHook(() => useResolveBilling(defaultInput));

    expect(result.current.fundingSource).toBe('personal_balance');
  });

  it('gives no verdict, and asks the funding core nothing, when there is no turn to price', () => {
    // A composer with no model selected (every media modality starts that way)
    // has no priced turn. A ZERO here would read as a turn that costs nothing:
    // the funding core clears any minimum at or below headroom, so a payer with
    // any balance at all would come back FUNDED for a turn that cannot exist.
    // The absence is passed as an absence and short-circuits before the core.
    const { result } = renderHook(() =>
      useResolveBilling({ ...defaultInput, estimatedMinimumCostNanoUsd: undefined })
    );

    expect(result.current.fundingSource).toBe('no_verdict');
  });

  it('returns free_allowance for free tier user', () => {
    mockUseBalance.mockReturnValue({
      data: balance('0', '5000000000'),
      isPending: false,
    } as UseQueryResult<GetBalanceResponse>);

    const { result } = renderHook(() => useResolveBilling(defaultInput));

    expect(result.current.fundingSource).toBe('free_allowance');
  });

  it('returns trial_fixed for unauthenticated user within cost cap', () => {
    const { result } = renderHook(() =>
      useResolveBilling({
        ...defaultInput,
        isAuthenticated: false,
        estimatedMinimumCostNanoUsd: 10_000_000n, // Within MAX_TRIAL_MESSAGE_COST_CENTS (1 cent)
      })
    );

    expect(result.current.fundingSource).toBe('trial_fixed');
  });

  it('returns denied with premium_requires_balance for free user with premium model', () => {
    mockUseBalance.mockReturnValue({
      data: balance('0', '5000000000'),
      isPending: false,
    } as UseQueryResult<GetBalanceResponse>);

    const { result } = renderHook(() =>
      useResolveBilling({
        ...defaultInput,
        isPremiumModel: true,
      })
    );

    expect(result.current.fundingSource).toBe('denied');
    if (result.current.fundingSource === 'denied') {
      expect(result.current.reason).toBe('premium_requires_balance');
    }
  });

  it('returns denied with insufficient_balance for paid user with too-low served spendable', () => {
    // Small positive balance → paid tier; the SERVED spendable (already
    // cushioned) is what the estimate compares against.
    mockUseBalance.mockReturnValue({
      data: balance('10000000', '0'),
      isPending: false,
    } as UseQueryResult<GetBalanceResponse>);
    mockUseFundingRead.mockReturnValue(spendable('510000000'));

    const { result } = renderHook(() =>
      useResolveBilling({
        ...defaultInput,
        estimatedMinimumCostNanoUsd: 1_000_000_000_000n, // Far exceeds the served spendable
      })
    );

    expect(result.current.fundingSource).toBe('denied');
    if (result.current.fundingSource === 'denied') {
      expect(result.current.reason).toBe('insufficient_balance');
    }
  });

  it("returns owner_balance for a link guest whose payer's served figure covers the turn", () => {
    // Owner funding reaches this hook only through the SERVED figure — there is
    // no group dimension for a caller to compose one from.
    mockUseBalance.mockReturnValue({
      data: balance('0', '0'),
      isPending: false,
    } as UseQueryResult<GetBalanceResponse>);
    mockUseFundingRead.mockReturnValue(spendable('5000000000'));
    mockLinkGuest.current = 'link-public-key';

    const { result } = renderHook(() =>
      useResolveBilling({
        ...defaultInput,
        // A link guest holds no session: the app masks it as unauthenticated.
        isAuthenticated: false,
        conversationId: 'conversation-1',
      })
    );

    expect(result.current.fundingSource).toBe('owner_balance');
  });

  it('reads the funding snapshot scoped to the conversation that names the payer', () => {
    renderHook(() => useResolveBilling({ ...defaultInput, conversationId: 'conversation-1' }));

    expect(mockUseFundingRead).toHaveBeenCalledWith(true, 'conversation-1');
  });

  it('denies with negative_balance when the caller purchased balance is negative (solo)', () => {
    // The hard block reads the RAW served balance — the cushioned spendable is
    // positive here, and must not override the negative-balance denial.
    mockUseBalance.mockReturnValue({
      data: balance('-2000000000', '0'),
      isPending: false,
    } as UseQueryResult<GetBalanceResponse>);
    mockUseFundingRead.mockReturnValue(spendable('300000000'));

    const { result } = renderHook(() => useResolveBilling(defaultInput));

    expect(result.current.fundingSource).toBe('denied');
    if (result.current.fundingSource === 'denied') {
      expect(result.current.reason).toBe('negative_balance');
    }
  });

  it('answers no verdict while a snapshot for a door-holding payer is still in flight', () => {
    // Nothing is known about this payer's money, so there is no verdict to give.
    // A zero standing in for the unread figure denies a payer who may be rich.
    mockUseFundingRead.mockReturnValue({ status: 'awaiting', snapshot: undefined });

    const { result } = renderHook(() => useResolveBilling(defaultInput));

    expect(result.current).toEqual({ fundingSource: 'no_verdict' });
  });

  it('answers no verdict when a door-holding payer funding read is exhausted', () => {
    mockUseFundingRead.mockReturnValue({ status: 'unavailable', snapshot: undefined });

    const { result } = renderHook(() => useResolveBilling(defaultInput));

    expect(result.current).toEqual({ fundingSource: 'no_verdict' });
  });

  it('keeps the doorless zero for the trial, the one payer it describes', () => {
    // The trial has no funding endpoint to read, so its absence is permanent and
    // `0n` is its real figure rather than a stand-in for an unread one.
    mockUseFundingRead.mockReturnValue({ status: 'no-door', snapshot: undefined });

    const { result } = renderHook(() =>
      useResolveBilling({
        ...defaultInput,
        isAuthenticated: false,
        estimatedMinimumCostNanoUsd: 10_000_000n,
      })
    );

    expect(result.current).toEqual({ fundingSource: 'trial_fixed' });
  });

  it('memoizes result when inputs are stable', () => {
    const { result, rerender } = renderHook(() => useResolveBilling(defaultInput));

    const first = result.current;
    rerender();
    const second = result.current;

    expect(first).toBe(second);
  });
});
