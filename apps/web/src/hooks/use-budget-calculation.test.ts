import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useBudgetCalculation } from './use-budget-calculation';
import * as billingHooks from './billing';
import type { UseQueryResult } from '@tanstack/react-query';
import type { GetBalanceResponse } from '@hushbox/shared';

// Hoist mock functions for vi.mock factories
const { mockUseStability } = vi.hoisted(() => ({
  mockUseStability: vi.fn(),
}));

// Mock the billing hooks module
vi.mock('./billing', () => ({
  useBalance: vi.fn(),
}));

// Mock stability provider
vi.mock('@/providers/stability-provider', () => ({
  useStability: mockUseStability,
}));

const mockUseBalance = vi.mocked(billingHooks.useBalance);

describe('useBudgetCalculation', () => {
  const defaultInput = {
    promptCharacterCount: 1000,
    modelInputPricePerToken: 0.000_01,
    modelOutputPricePerToken: 0.000_03,
    modelContextLength: 128_000,
    isAuthenticated: true,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    mockUseBalance.mockReturnValue({
      data: { balance: '10.00000000', freeAllowanceCents: 500 },
      isPending: false,
    } as UseQueryResult<GetBalanceResponse>);
    mockUseStability.mockReturnValue({
      isAuthStable: true,
      isBalanceStable: true,
      isAppStable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('returns math result before debounce completes', () => {
      const { result } = renderHook(() => useBudgetCalculation(defaultInput));

      expect(result.current.maxOutputTokens).toBeGreaterThan(0);
      expect(result.current.estimatedInputTokens).toBeGreaterThan(0);
      expect(result.current.capacityPercent).toBeGreaterThanOrEqual(0);
    });
  });

  describe('tier determination', () => {
    it('uses conservative token estimation for unauthenticated (trial) user', () => {
      const { result } = renderHook(() =>
        useBudgetCalculation({
          ...defaultInput,
          promptCharacterCount: 4000,
          isAuthenticated: false,
        })
      );

      act(() => {
        vi.advanceTimersByTime(200);
      });

      // Trial tier uses 2 chars/token → 4000/2 = 2000 tokens
      expect(result.current.estimatedInputTokens).toBe(2000);
    });

    it('uses standard token estimation for authenticated paid user', () => {
      mockUseBalance.mockReturnValue({
        data: { balance: '10.00000000', freeAllowanceCents: 0 },
        isPending: false,
      } as UseQueryResult<GetBalanceResponse>);

      const { result } = renderHook(() =>
        useBudgetCalculation({
          ...defaultInput,
          promptCharacterCount: 4000,
        })
      );

      act(() => {
        vi.advanceTimersByTime(200);
      });

      // Paid tier uses 4 chars/token → 4000/4 = 1000 tokens
      expect(result.current.estimatedInputTokens).toBe(1000);
    });

    it('treats authenticated user with zero balance as free tier', () => {
      mockUseBalance.mockReturnValue({
        data: { balance: '0.00000000', freeAllowanceCents: 500 },
        isPending: false,
      } as UseQueryResult<GetBalanceResponse>);

      const { result } = renderHook(() =>
        useBudgetCalculation({
          ...defaultInput,
          promptCharacterCount: 4000,
        })
      );

      act(() => {
        vi.advanceTimersByTime(200);
      });

      // Free tier uses 2 chars/token → 4000/2 = 2000 tokens
      expect(result.current.estimatedInputTokens).toBe(2000);
    });

    it('sets isBalanceLoading true when authenticated and balance is not stable', () => {
      mockUseStability.mockReturnValue({
        isAuthStable: true,
        isBalanceStable: false,
        isAppStable: false,
      });
      mockUseBalance.mockReturnValue({
        data: undefined,
        isPending: true,
      } as UseQueryResult<GetBalanceResponse>);

      const { result } = renderHook(() => useBudgetCalculation(defaultInput));

      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(result.current.isBalanceLoading).toBe(true);
    });

    it('sets isBalanceLoading false when not authenticated', () => {
      mockUseStability.mockReturnValue({
        isAuthStable: true,
        isBalanceStable: true,
        isAppStable: true,
      });
      mockUseBalance.mockReturnValue({
        data: undefined,
        isPending: false,
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

      expect(result.current.isBalanceLoading).toBe(false);
    });

    it('sets isBalanceLoading false when balance is stable', () => {
      mockUseStability.mockReturnValue({
        isAuthStable: true,
        isBalanceStable: true,
        isAppStable: true,
      });
      mockUseBalance.mockReturnValue({
        data: { balance: '10.00000000', freeAllowanceCents: 500 },
        isPending: false,
      } as UseQueryResult<GetBalanceResponse>);

      const { result } = renderHook(() => useBudgetCalculation(defaultInput));

      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(result.current.isBalanceLoading).toBe(false);
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

    it('returns positive maxOutputTokens when balance covers minimum cost', () => {
      mockUseBalance.mockReturnValue({
        data: { balance: '10.00000000', freeAllowanceCents: 0 },
        isPending: false,
      } as UseQueryResult<GetBalanceResponse>);

      const { result } = renderHook(() => useBudgetCalculation(defaultInput));

      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(result.current.maxOutputTokens).toBeGreaterThan(0);
    });

    it('returns zero maxOutputTokens when balance is insufficient', () => {
      mockUseBalance.mockReturnValue({
        data: { balance: '0.00000000', freeAllowanceCents: 0 },
        isPending: false,
      } as UseQueryResult<GetBalanceResponse>);

      const { result } = renderHook(() =>
        useBudgetCalculation({
          ...defaultInput,
          promptCharacterCount: 100_000, // Large message
          modelInputPricePerToken: 0.001, // Expensive model
        })
      );

      act(() => {
        vi.advanceTimersByTime(200);
      });

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
          modelContextLength: 10_000, // Small context for test
        })
      );

      act(() => {
        vi.advanceTimersByTime(200);
      });

      // currentUsage = capacityInputTokens (4000/4=1000) + MINIMUM_OUTPUT_TOKENS (1000)
      // capacityPercent = 2000 / 10000 * 100 = 20%
      expect(result.current.capacityPercent).toBe(20);
    });

    it('returns estimatedMinimumCost in dollars', () => {
      mockUseBalance.mockReturnValue({
        data: { balance: '10.00000000', freeAllowanceCents: 0 },
        isPending: false,
      } as UseQueryResult<GetBalanceResponse>);

      const { result } = renderHook(() =>
        useBudgetCalculation({
          ...defaultInput,
          promptCharacterCount: 4000,
          modelInputPricePerToken: 0.000_01,
          modelOutputPricePerToken: 0.000_03,
        })
      );

      act(() => {
        vi.advanceTimersByTime(200);
      });

      // 4000 chars / 4 chars per token (paid) = 1000 input tokens
      // inputStorageCost = 4000 * 0.0000003 = 0.0012
      // estimatedInputCost = 1000 * 0.00001 + 0.0012 = 0.0112
      // outputCostPerToken = 0.00003 + 4 * 0.0000003 = 0.0000312
      // minimumOutputCost = 1000 * 0.0000312 = 0.0312
      // estimatedMinimumCost = 0.0112 + 0.0312 = 0.0424
      expect(result.current.estimatedMinimumCost).toBeCloseTo(0.0424, 5);
    });
  });
});
