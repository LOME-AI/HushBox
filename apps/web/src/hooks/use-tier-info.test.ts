import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useTierInfo } from './use-tier-info.js';

// Mock dependencies
vi.mock('@/lib/auth', () => ({
  useSession: vi.fn(),
}));

vi.mock('./billing.js', () => ({
  useBalance: vi.fn(),
}));

import { useSession } from '@/lib/auth';
import { useBalance } from './billing.js';

const mockedUseSession = vi.mocked(useSession);
const mockedUseBalance = vi.mocked(useBalance);

describe('useTierInfo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns trial tier when not authenticated', () => {
    mockedUseSession.mockReturnValue({ data: null } as unknown as ReturnType<typeof useSession>);
    mockedUseBalance.mockReturnValue({ data: null } as unknown as ReturnType<typeof useBalance>);

    const { result } = renderHook(() => useTierInfo());

    expect(result.current!.tier).toBe('trial');
    expect(result.current!.canAccessPremium).toBe(false);
    expect(result.current!.balanceCents).toBe(0);
    expect(result.current!.freeAllowanceCents).toBe(0);
  });

  it('returns null when session is loading', () => {
    mockedUseSession.mockReturnValue({ data: null, isPending: true } as unknown as ReturnType<
      typeof useSession
    >);
    mockedUseBalance.mockReturnValue({ data: undefined } as unknown as ReturnType<
      typeof useBalance
    >);

    const { result } = renderHook(() => useTierInfo());

    expect(result.current).toBeNull();
  });

  it('returns free tier when authenticated with zero balance', () => {
    mockedUseSession.mockReturnValue({
      data: { user: { id: 'user-123' } },
    } as unknown as ReturnType<typeof useSession>);
    mockedUseBalance.mockReturnValue({
      data: { balance: '0.00', freeAllowanceCents: 100 },
    } as unknown as ReturnType<typeof useBalance>);

    const { result } = renderHook(() => useTierInfo());

    expect(result.current!.tier).toBe('free');
    expect(result.current!.canAccessPremium).toBe(false);
    expect(result.current!.balanceCents).toBe(0);
    expect(result.current!.freeAllowanceCents).toBe(100);
  });

  it('returns paid tier when authenticated with positive balance', () => {
    mockedUseSession.mockReturnValue({
      data: { user: { id: 'user-123' } },
    } as unknown as ReturnType<typeof useSession>);
    mockedUseBalance.mockReturnValue({
      data: { balance: '10.50', freeAllowanceCents: 0 },
    } as unknown as ReturnType<typeof useBalance>);

    const { result } = renderHook(() => useTierInfo());

    expect(result.current!.tier).toBe('paid');
    expect(result.current!.canAccessPremium).toBe(true);
    expect(result.current!.balanceCents).toBe(1050);
    expect(result.current!.freeAllowanceCents).toBe(0);
  });

  it('returns canAccessPremium: true only for paid tier', () => {
    // Trial
    mockedUseSession.mockReturnValue({ data: null } as unknown as ReturnType<typeof useSession>);
    mockedUseBalance.mockReturnValue({ data: null } as unknown as ReturnType<typeof useBalance>);
    const { result: trialResult } = renderHook(() => useTierInfo());
    expect(trialResult.current!.canAccessPremium).toBe(false);

    // Free
    mockedUseSession.mockReturnValue({
      data: { user: { id: 'user-123' } },
    } as unknown as ReturnType<typeof useSession>);
    mockedUseBalance.mockReturnValue({
      data: { balance: '0.00', freeAllowanceCents: 100 },
    } as unknown as ReturnType<typeof useBalance>);
    const { result: freeResult } = renderHook(() => useTierInfo());
    expect(freeResult.current!.canAccessPremium).toBe(false);

    // Paid
    mockedUseBalance.mockReturnValue({
      data: { balance: '5.00', freeAllowanceCents: 0 },
    } as unknown as ReturnType<typeof useBalance>);
    const { result: paidResult } = renderHook(() => useTierInfo());
    expect(paidResult.current!.canAccessPremium).toBe(true);
  });

  it('returns null when authenticated but balance not loaded', () => {
    mockedUseSession.mockReturnValue({
      data: { user: { id: 'user-123' } },
    } as unknown as ReturnType<typeof useSession>);
    mockedUseBalance.mockReturnValue({ data: undefined } as unknown as ReturnType<
      typeof useBalance
    >);

    const { result } = renderHook(() => useTierInfo());

    // While balance is loading, return null — don't guess the tier
    expect(result.current).toBeNull();
  });

  it('correctly converts balance string to cents', () => {
    mockedUseSession.mockReturnValue({
      data: { user: { id: 'user-123' } },
    } as unknown as ReturnType<typeof useSession>);
    mockedUseBalance.mockReturnValue({
      data: { balance: '123.45', freeAllowanceCents: 50 },
    } as unknown as ReturnType<typeof useBalance>);

    const { result } = renderHook(() => useTierInfo());

    expect(result.current!.balanceCents).toBe(12_345);
    expect(result.current!.freeAllowanceCents).toBe(50);
  });
});
