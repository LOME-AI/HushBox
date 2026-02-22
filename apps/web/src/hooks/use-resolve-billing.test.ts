import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useResolveBilling, type UseResolveBillingInput } from './use-resolve-billing';

vi.mock('./billing', () => ({
  useBalance: vi.fn(),
}));

vi.mock('@/providers/stability-provider', () => ({
  useStability: vi.fn(() => ({
    isAuthStable: true,
    isBalanceStable: true,
    isAppStable: true,
  })),
}));

import { useBalance } from './billing';
import type { UseQueryResult } from '@tanstack/react-query';
import type { GetBalanceResponse } from '@hushbox/shared';

const mockUseBalance = vi.mocked(useBalance);

describe('useResolveBilling', () => {
  const defaultInput: UseResolveBillingInput = {
    estimatedMinimumCostCents: 4,
    isPremiumModel: false,
    isAuthenticated: true,
  };

  beforeEach(() => {
    mockUseBalance.mockReturnValue({
      data: { balance: '10.00000000', freeAllowanceCents: 500 },
      isPending: false,
    } as UseQueryResult<GetBalanceResponse>);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns personal_balance for paid user with sufficient balance', () => {
    const { result } = renderHook(() => useResolveBilling(defaultInput));

    expect(result.current.fundingSource).toBe('personal_balance');
  });

  it('returns free_allowance for free tier user', () => {
    mockUseBalance.mockReturnValue({
      data: { balance: '0.00000000', freeAllowanceCents: 500 },
      isPending: false,
    } as UseQueryResult<GetBalanceResponse>);

    const { result } = renderHook(() => useResolveBilling(defaultInput));

    expect(result.current.fundingSource).toBe('free_allowance');
  });

  it('returns guest_fixed for unauthenticated user within cost cap', () => {
    const { result } = renderHook(() =>
      useResolveBilling({
        ...defaultInput,
        isAuthenticated: false,
        estimatedMinimumCostCents: 1, // Within MAX_TRIAL_MESSAGE_COST_CENTS (1 cent)
      })
    );

    expect(result.current.fundingSource).toBe('guest_fixed');
  });

  it('returns denied with premium_requires_balance for free user with premium model', () => {
    mockUseBalance.mockReturnValue({
      data: { balance: '0.00000000', freeAllowanceCents: 500 },
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

  it('returns denied with insufficient_balance for paid user with too-low balance', () => {
    // Small positive balance → paid tier, but cost exceeds balance + cushion
    mockUseBalance.mockReturnValue({
      data: { balance: '0.01000000', freeAllowanceCents: 0 },
      isPending: false,
    } as UseQueryResult<GetBalanceResponse>);

    const { result } = renderHook(() =>
      useResolveBilling({
        ...defaultInput,
        estimatedMinimumCostCents: 100_000, // Far exceeds $0.01 balance + $0.50 cushion
      })
    );

    expect(result.current.fundingSource).toBe('denied');
    if (result.current.fundingSource === 'denied') {
      expect(result.current.reason).toBe('insufficient_balance');
    }
  });

  it('returns owner_balance when group budget is available', () => {
    const { result } = renderHook(() =>
      useResolveBilling({
        ...defaultInput,
        group: {
          effectiveCents: 500,
          ownerTier: 'paid',
          ownerBalanceCents: 5000,
        },
      })
    );

    expect(result.current.fundingSource).toBe('owner_balance');
  });

  it('falls through to personal when group budget is exhausted', () => {
    const { result } = renderHook(() =>
      useResolveBilling({
        ...defaultInput,
        group: {
          effectiveCents: 0,
          ownerTier: 'paid',
          ownerBalanceCents: 5000,
        },
      })
    );

    // effectiveCents=0 → falls through to personal
    expect(result.current.fundingSource).toBe('personal_balance');
  });

  it('memoizes result when inputs are stable', () => {
    const { result, rerender } = renderHook(() => useResolveBilling(defaultInput));

    const first = result.current;
    rerender();
    const second = result.current;

    expect(first).toBe(second);
  });
});
