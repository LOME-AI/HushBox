import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// Unmock stability provider so we can mock it with controlled values
vi.unmock('@/providers/stability-provider');

import { useStableBalance } from './use-stable-balance';

// Mock dependencies
vi.mock('./billing', () => ({
  useBalance: vi.fn(),
}));

vi.mock('@/providers/stability-provider', () => ({
  useStability: vi.fn(),
}));

import { useBalance } from './billing';
import { useStability } from '@/providers/stability-provider';

const mockedUseBalance = vi.mocked(useBalance);
const mockedUseStability = vi.mocked(useStability);

describe('useStableBalance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('isStable', () => {
    it('returns isBalanceStable from stability provider', () => {
      mockedUseBalance.mockReturnValue({
        data: { balance: '10.00' },
        isPending: false,
      } as unknown as ReturnType<typeof useBalance>);
      mockedUseStability.mockReturnValue({
        isAuthStable: true,
        isBalanceStable: true,
        isAppStable: true,
      });

      const { result } = renderHook(() => useStableBalance());

      expect(result.current.isStable).toBe(true);
    });

    it('returns false when balance is not stable', () => {
      mockedUseBalance.mockReturnValue({
        data: undefined,
        isPending: true,
      } as unknown as ReturnType<typeof useBalance>);
      mockedUseStability.mockReturnValue({
        isAuthStable: true,
        isBalanceStable: false,
        isAppStable: false,
      });

      const { result } = renderHook(() => useStableBalance());

      expect(result.current.isStable).toBe(false);
    });
  });

  describe('displayBalance', () => {
    it('returns balance from data when available', () => {
      mockedUseBalance.mockReturnValue({
        data: { balance: '25.50' },
        isPending: false,
      } as unknown as ReturnType<typeof useBalance>);
      mockedUseStability.mockReturnValue({
        isAuthStable: true,
        isBalanceStable: true,
        isAppStable: true,
      });

      const { result } = renderHook(() => useStableBalance());

      expect(result.current.displayBalance).toBe('25.50');
    });

    it('returns "0" when no data available', () => {
      mockedUseBalance.mockReturnValue({
        data: undefined,
        isPending: true,
      } as unknown as ReturnType<typeof useBalance>);
      mockedUseStability.mockReturnValue({
        isAuthStable: true,
        isBalanceStable: false,
        isAppStable: false,
      });

      const { result } = renderHook(() => useStableBalance());

      expect(result.current.displayBalance).toBe('0');
    });

    it('returns "0" when data is null', () => {
      mockedUseBalance.mockReturnValue({
        data: null,
        isPending: false,
      } as unknown as ReturnType<typeof useBalance>);
      mockedUseStability.mockReturnValue({
        isAuthStable: true,
        isBalanceStable: true,
        isAppStable: true,
      });

      const { result } = renderHook(() => useStableBalance());

      expect(result.current.displayBalance).toBe('0');
    });
  });

  describe('passes through useBalance properties', () => {
    it('returns data from useBalance', () => {
      const balanceData = { balance: '100.00', freeAllowanceCents: 50 };
      mockedUseBalance.mockReturnValue({
        data: balanceData,
        isPending: false,
      } as unknown as ReturnType<typeof useBalance>);
      mockedUseStability.mockReturnValue({
        isAuthStable: true,
        isBalanceStable: true,
        isAppStable: true,
      });

      const { result } = renderHook(() => useStableBalance());

      expect(result.current.data).toEqual(balanceData);
    });

    it('returns isPending from useBalance', () => {
      mockedUseBalance.mockReturnValue({
        data: undefined,
        isPending: true,
      } as unknown as ReturnType<typeof useBalance>);
      mockedUseStability.mockReturnValue({
        isAuthStable: true,
        isBalanceStable: false,
        isAppStable: false,
      });

      const { result } = renderHook(() => useStableBalance());

      expect(result.current.isPending).toBe(true);
    });
  });
});
