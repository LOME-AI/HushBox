import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePayerPremiumAccess } from '@/hooks/models/use-payer-premium-access.js';

vi.mock('@/lib/auth/auth', () => ({
  useSession: vi.fn(),
}));

// A double, not a second implementation: each test states what is KNOWN about
// the payer's funding — served, awaiting, exhausted, or no door at all. How a
// query settles into one of those answers is pinned where it lives, in
// `use-spendable.test.ts`.
vi.mock('@/hooks/billing/use-spendable.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/billing/use-spendable.js')>()),
  useFundingRead: vi.fn(),
}));

import { useSession } from '@/lib/auth/auth';
import { useFundingRead } from '@/hooks/billing/use-spendable.js';
import type { FundingRead } from '@/hooks/billing/use-spendable.js';

const mockedUseSession = vi.mocked(useSession);
const mockedUseFundingRead = vi.mocked(useFundingRead);

/** A landed read of the payer's snapshot at the given tier. */
function served(tier: 'paid' | 'free'): FundingRead {
  return {
    status: 'served',
    snapshot: {
      spendableNanoUsd: '0',
      heldNanoUsd: '0',
      payerTier: tier,
      payer: 'self',
      ownerFundingLimit: null,
    },
  };
}

const AWAITING: FundingRead = { status: 'awaiting', snapshot: undefined };
const UNAVAILABLE: FundingRead = { status: 'unavailable', snapshot: undefined };
const NO_DOOR: FundingRead = { status: 'no-door', snapshot: undefined };

describe('usePayerPremiumAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedUseSession.mockReturnValue({
      data: { user: { id: 'user-1' } },
      isPending: false,
    } as ReturnType<typeof useSession>);
    mockedUseFundingRead.mockReturnValue(served('paid'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports awaiting while the session that names the caller is still resolving', () => {
    mockedUseSession.mockReturnValue({
      data: undefined,
      isPending: true,
    } as unknown as ReturnType<typeof useSession>);

    const { result } = renderHook(() => usePayerPremiumAccess(null));

    expect(result.current).toEqual({ status: 'awaiting' });
  });

  it('reports awaiting while the payer read is still in flight', () => {
    mockedUseFundingRead.mockReturnValue(AWAITING);

    const { result } = renderHook(() => usePayerPremiumAccess(null));

    expect(result.current).toEqual({ status: 'awaiting' });
  });

  it('reports an exhausted payer read as unavailable, never as awaiting', () => {
    mockedUseFundingRead.mockReturnValue(UNAVAILABLE);

    const { result } = renderHook(() => usePayerPremiumAccess(null));

    expect(result.current).toEqual({ status: 'unavailable' });
  });

  it('answers at the tier of a caller that has no funding door to read', () => {
    mockedUseFundingRead.mockReturnValue(NO_DOOR);

    const { result } = renderHook(() => usePayerPremiumAccess(null));

    expect(result.current).toEqual({ status: 'known', canAccessPremium: false });
  });

  it('reports premium reach for a served paid payer', () => {
    const { result } = renderHook(() => usePayerPremiumAccess(null));

    expect(result.current).toEqual({ status: 'known', canAccessPremium: true });
  });

  it('reports no premium reach for a served free payer', () => {
    mockedUseFundingRead.mockReturnValue(served('free'));

    const { result } = renderHook(() => usePayerPremiumAccess(null));

    expect(result.current).toEqual({ status: 'known', canAccessPremium: false });
  });

  it('reads the funding door of the conversation whose payer decides the tier', () => {
    renderHook(() => usePayerPremiumAccess('conv-owner'));

    expect(mockedUseFundingRead).toHaveBeenCalledWith(true, 'conv-owner');
  });
});
