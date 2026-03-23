import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useUserTierInfo } from './use-user-tier-info';

vi.mock('./billing', () => ({
  useBalance: vi.fn(),
}));

vi.mock('@/lib/link-guest-auth', () => ({
  getLinkGuestAuth: vi.fn(),
}));

import { useBalance } from './billing';
import { getLinkGuestAuth } from '@/lib/link-guest-auth';
import type { UseQueryResult } from '@tanstack/react-query';
import type { GetBalanceResponse } from '@hushbox/shared';

const mockUseBalance = vi.mocked(useBalance);
const mockGetLinkGuestAuth = vi.mocked(getLinkGuestAuth);

describe('useUserTierInfo', () => {
  beforeEach(() => {
    mockGetLinkGuestAuth.mockReturnValue(null);
    mockUseBalance.mockReturnValue({
      data: { balance: '10.00000000', freeAllowanceCents: 500 },
      isPending: false,
    } as UseQueryResult<GetBalanceResponse>);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns paid tier for authenticated user with positive balance', () => {
    const { result } = renderHook(() => useUserTierInfo(true));

    expect(result.current.tier).toBe('paid');
    expect(result.current.balanceCents).toBe(1000);
    expect(result.current.freeAllowanceCents).toBe(500);
  });

  it('returns free tier for authenticated user with zero balance', () => {
    mockUseBalance.mockReturnValue({
      data: { balance: '0.00000000', freeAllowanceCents: 500 },
      isPending: false,
    } as UseQueryResult<GetBalanceResponse>);

    const { result } = renderHook(() => useUserTierInfo(true));

    expect(result.current.tier).toBe('free');
    expect(result.current.balanceCents).toBe(0);
    expect(result.current.freeAllowanceCents).toBe(500);
  });

  it('returns trial tier for unauthenticated user', () => {
    const { result } = renderHook(() => useUserTierInfo(false));

    expect(result.current.tier).toBe('trial');
    expect(result.current.balanceCents).toBe(0);
    expect(result.current.freeAllowanceCents).toBe(0);
  });

  it('returns trial tier when authenticated but balance data is not yet available', () => {
    mockUseBalance.mockReturnValue({
      data: undefined,
      isPending: true,
    } as UseQueryResult<GetBalanceResponse>);

    const { result } = renderHook(() => useUserTierInfo(true));

    expect(result.current.tier).toBe('trial');
  });

  it('returns guest tier when link guest auth is set', () => {
    mockGetLinkGuestAuth.mockReturnValue('some-public-key');

    const { result } = renderHook(() => useUserTierInfo(false));

    expect(result.current.tier).toBe('guest');
    expect(result.current.balanceCents).toBe(0);
    expect(result.current.freeAllowanceCents).toBe(0);
  });

  it('memoizes result when inputs are stable', () => {
    const { result, rerender } = renderHook(() => useUserTierInfo(true));

    const first = result.current;
    rerender();
    const second = result.current;

    expect(first).toBe(second);
  });
});
