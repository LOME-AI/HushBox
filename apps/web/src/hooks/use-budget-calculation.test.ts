import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useBudgetCalculation } from './use-budget-calculation';
import * as billingHooks from './billing';
import type { UseQueryResult } from '@tanstack/react-query';
import type { GetBalanceResponse } from '@lome-chat/shared';

// Mock the billing hooks module
vi.mock('./billing', () => ({
  useBalance: vi.fn(),
}));

const mockUseBalance = vi.mocked(billingHooks.useBalance);

describe('useBudgetCalculation', () => {
  const defaultInput = {
    promptCharacterCount: 1000,
    modelInputPricePerToken: 0.00001,
    modelOutputPricePerToken: 0.00003,
    modelContextLength: 128000,
    isAuthenticated: true,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    mockUseBalance.mockReturnValue({
      data: { balance: '10.00000000', freeAllowanceCents: 500 },
      isPending: false,
    } as UseQueryResult<GetBalanceResponse>);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('returns default result before debounce completes', () => {
      const { result } = renderHook(() => useBudgetCalculation(defaultInput));

      expect(result.current.canAfford).toBe(true);
      expect(result.current.errors).toEqual([]);
    });
  });

  describe('tier determination', () => {
    it('treats unauthenticated user as guest', () => {
      const { result } = renderHook(() =>
        useBudgetCalculation({
          ...defaultInput,
          isAuthenticated: false,
        })
      );

      act(() => {
        vi.advanceTimersByTime(200);
      });

      // Guest tier should have the guest notice
      const hasGuestNotice = result.current.errors.some((e) => e.id === 'guest_notice');
      expect(hasGuestNotice).toBe(true);
    });

    it('treats authenticated user with positive balance as paid tier', () => {
      mockUseBalance.mockReturnValue({
        data: { balance: '10.00000000', freeAllowanceCents: 0 },
        isPending: false,
      } as UseQueryResult<GetBalanceResponse>);

      const { result } = renderHook(() => useBudgetCalculation(defaultInput));

      act(() => {
        vi.advanceTimersByTime(200);
      });

      // Paid tier should NOT have free/guest notices
      const hasTierNotice = result.current.errors.some(
        (e) => e.id === 'guest_notice' || e.id === 'free_tier_notice'
      );
      expect(hasTierNotice).toBe(false);
    });

    it('treats authenticated user with zero balance as free tier', () => {
      mockUseBalance.mockReturnValue({
        data: { balance: '0.00000000', freeAllowanceCents: 500 },
        isPending: false,
      } as UseQueryResult<GetBalanceResponse>);

      const { result } = renderHook(() => useBudgetCalculation(defaultInput));

      act(() => {
        vi.advanceTimersByTime(200);
      });

      // Free tier should have the free tier notice
      const hasFreeTierNotice = result.current.errors.some((e) => e.id === 'free_tier_notice');
      expect(hasFreeTierNotice).toBe(true);
    });

    it('sets isBalanceLoading true when authenticated and balance is loading', () => {
      mockUseBalance.mockReturnValue({
        data: undefined,
        isPending: true,
      } as UseQueryResult<GetBalanceResponse>);

      const { result } = renderHook(() => useBudgetCalculation(defaultInput));

      act(() => {
        vi.advanceTimersByTime(200);
      });

      // isBalanceLoading should be true for authenticated users while balance is loading
      expect(result.current.isBalanceLoading).toBe(true);
      // Calculation still happens with guest tier (errors may include guest notice)
      // but UI should use isBalanceLoading to suppress display
    });

    it('sets isBalanceLoading false when not authenticated', () => {
      mockUseBalance.mockReturnValue({
        data: undefined,
        isPending: true,
      } as UseQueryResult<GetBalanceResponse>);

      const { result } = renderHook(() =>
        useBudgetCalculation({
          ...defaultInput,
          isAuthenticated: false,
        })
      );

      act(() => {
        vi.advanceTimersByTime(200);
      });

      // Not authenticated, so loading state doesn't matter
      expect(result.current.isBalanceLoading).toBe(false);
    });

    it('sets isBalanceLoading false when balance is loaded', () => {
      mockUseBalance.mockReturnValue({
        data: { balance: '10.00000000', freeAllowanceCents: 500 },
        isPending: false,
      } as UseQueryResult<GetBalanceResponse>);

      const { result } = renderHook(() => useBudgetCalculation(defaultInput));

      act(() => {
        vi.advanceTimersByTime(200);
      });

      // Balance is loaded, no longer loading
      expect(result.current.isBalanceLoading).toBe(false);
    });

    it('filters tier notices when isAuthPending is true', () => {
      mockUseBalance.mockReturnValue({
        data: undefined,
        isPending: false,
      } as UseQueryResult<GetBalanceResponse>);

      const { result } = renderHook(() =>
        useBudgetCalculation({
          ...defaultInput,
          isAuthenticated: false,
          isAuthPending: true,
        })
      );

      act(() => {
        vi.advanceTimersByTime(200);
      });

      const hasTierNotice = result.current.errors.some(
        (e) => e.id === 'guest_notice' || e.id === 'free_tier_notice'
      );
      expect(hasTierNotice).toBe(false);
    });

    it('shows tier notices after auth and balance settle', () => {
      mockUseBalance.mockReturnValue({
        data: { balance: '0.00000000', freeAllowanceCents: 500 },
        isPending: false,
      } as UseQueryResult<GetBalanceResponse>);

      const { result } = renderHook(() =>
        useBudgetCalculation({
          ...defaultInput,
          isAuthenticated: true,
          isAuthPending: false,
        })
      );

      act(() => {
        vi.advanceTimersByTime(200);
      });

      const hasFreeTierNotice = result.current.errors.some((e) => e.id === 'free_tier_notice');
      expect(hasFreeTierNotice).toBe(true);
    });
  });

  describe('debouncing', () => {
    it('debounces calculation by 150ms', () => {
      const { result, rerender } = renderHook(
        ({ count }: { count: number }) =>
          useBudgetCalculation({
            ...defaultInput,
            promptCharacterCount: count,
          }),
        { initialProps: { count: 1000 } }
      );

      const initialResult = result.current;

      // Rerender with new value before debounce completes
      rerender({ count: 2000 });

      // Result should still be initial values (debounce not complete)
      expect(result.current).toStrictEqual(initialResult);

      // Advance past debounce time
      act(() => {
        vi.advanceTimersByTime(200);
      });

      // Now result should be updated
      expect(result.current.estimatedInputTokens).toBeGreaterThan(0);
    });
  });

  describe('budget calculation', () => {
    it('calculates input tokens based on character count', () => {
      mockUseBalance.mockReturnValue({
        data: { balance: '10.00000000', freeAllowanceCents: 0 },
        isPending: false,
      } as UseQueryResult<GetBalanceResponse>);

      const { result } = renderHook(() =>
        useBudgetCalculation({
          ...defaultInput,
          promptCharacterCount: 4000, // 4000 chars at 4 chars/token = 1000 tokens
        })
      );

      act(() => {
        vi.advanceTimersByTime(200);
      });

      // Paid tier uses 4 chars/token
      expect(result.current.estimatedInputTokens).toBe(1000);
    });

    it('returns canAfford true when balance covers minimum cost', () => {
      mockUseBalance.mockReturnValue({
        data: { balance: '10.00000000', freeAllowanceCents: 0 },
        isPending: false,
      } as UseQueryResult<GetBalanceResponse>);

      const { result } = renderHook(() => useBudgetCalculation(defaultInput));

      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(result.current.canAfford).toBe(true);
      expect(result.current.maxOutputTokens).toBeGreaterThan(0);
    });

    it('returns canAfford false when balance is insufficient', () => {
      mockUseBalance.mockReturnValue({
        data: { balance: '0.00000000', freeAllowanceCents: 0 },
        isPending: false,
      } as UseQueryResult<GetBalanceResponse>);

      const { result } = renderHook(() =>
        useBudgetCalculation({
          ...defaultInput,
          promptCharacterCount: 100000, // Large message
          modelInputPricePerToken: 0.001, // Expensive model
        })
      );

      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(result.current.canAfford).toBe(false);
      expect(result.current.maxOutputTokens).toBe(0);
    });

    it('calculates capacity percentage correctly', () => {
      mockUseBalance.mockReturnValue({
        data: { balance: '10.00000000', freeAllowanceCents: 0 },
        isPending: false,
      } as UseQueryResult<GetBalanceResponse>);

      const { result } = renderHook(() =>
        useBudgetCalculation({
          ...defaultInput,
          promptCharacterCount: 4000,
          modelContextLength: 10000, // Small context for test
        })
      );

      act(() => {
        vi.advanceTimersByTime(200);
      });

      // currentUsage = estimatedInputTokens + MINIMUM_OUTPUT_TOKENS
      // 1000 + 1000 = 2000
      // capacityPercent = 2000 / 10000 * 100 = 20%
      expect(result.current.capacityPercent).toBe(20);
    });
  });

  describe('error messages', () => {
    it('includes capacity warning when over threshold', () => {
      mockUseBalance.mockReturnValue({
        data: { balance: '10.00000000', freeAllowanceCents: 0 },
        isPending: false,
      } as UseQueryResult<GetBalanceResponse>);

      const { result } = renderHook(() =>
        useBudgetCalculation({
          ...defaultInput,
          promptCharacterCount: 40000, // 10000 tokens at 4 chars/token
          modelContextLength: 15000, // capacity = (10000+1000)/15000 = 73%
        })
      );

      act(() => {
        vi.advanceTimersByTime(200);
      });

      const hasCapacityWarning = result.current.errors.some((e) => e.id === 'capacity_warning');
      expect(hasCapacityWarning).toBe(true);
    });

    it('includes low balance warning for paid user with limited output', () => {
      // Very low balance: $0.01 primary + $0.50 cushion = $0.51 effective
      // With expensive output price, maxOutputTokens < 10000 triggers warning
      mockUseBalance.mockReturnValue({
        data: { balance: '0.01000000', freeAllowanceCents: 0 },
        isPending: false,
      } as UseQueryResult<GetBalanceResponse>);

      const { result } = renderHook(() =>
        useBudgetCalculation({
          ...defaultInput,
          promptCharacterCount: 400,
          modelInputPricePerToken: 0.00001,
          // High output price: $0.51 / $0.0001 per token = ~5100 tokens (< 10000)
          modelOutputPricePerToken: 0.0001,
        })
      );

      act(() => {
        vi.advanceTimersByTime(200);
      });

      const hasLowBalanceWarning = result.current.errors.some((e) => e.id === 'low_balance');
      expect(hasLowBalanceWarning).toBe(true);
    });
  });
});
