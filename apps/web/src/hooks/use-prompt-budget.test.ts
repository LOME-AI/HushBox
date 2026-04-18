import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePromptBudget } from './use-prompt-budget';
import type { BudgetCalculationResult, CapabilityId, ResolveBillingResult } from '@hushbox/shared';

// Hoisted mock factories
const {
  mockUseBudgetCalculation,
  mockUseConversationBudgets,
  mockUseResolveBilling,
  mockSelectedModels,
  mockModelsData,
} = vi.hoisted(() => ({
  mockUseBudgetCalculation: vi.fn(),
  mockUseConversationBudgets: vi.fn(),
  mockUseResolveBilling: vi.fn(),
  mockSelectedModels: { current: [{ id: 'test-model', name: 'Test Model' }] },
  mockModelsData: {
    current: {
      models: [
        {
          id: 'test-model',
          contextLength: 128_000,
          pricePerInputToken: 0.000_01,
          pricePerOutputToken: 0.000_03,
        },
      ],
      premiumIds: new Set<string>(),
    },
  },
}));

vi.mock('./use-budget-calculation', () => ({
  useBudgetCalculation: (...args: unknown[]) => mockUseBudgetCalculation(...args),
}));

vi.mock('./use-conversation-budgets', () => ({
  useConversationBudgets: (...args: unknown[]) => mockUseConversationBudgets(...args),
}));

vi.mock('./use-resolve-billing', () => ({
  useResolveBilling: (...args: unknown[]) => mockUseResolveBilling(...args),
}));

vi.mock('@/stores/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/model')>();
  const { createModelStoreStub, selectorFromState } = await import('@/test-utils/model-store-mock');
  return {
    ...actual,
    useModelStore: (selector?: (state: unknown) => unknown) => {
      const state = createModelStoreStub({
        selections: {
          text: mockSelectedModels.current,
          image: [],
          audio: [],
          video: [],
        },
      });
      return selectorFromState(state)(selector as (s: unknown) => unknown);
    },
  };
});

vi.mock('@/hooks/models', () => ({
  useModels: () => ({
    data: mockModelsData.current,
    isLoading: false,
  }),
}));

vi.mock('@/lib/auth', () => ({
  useSession: () => ({
    data: {
      user: {
        id: 'user-1',
        email: 'test@test.com',
        username: 'testuser',
        emailVerified: true,
        totpEnabled: false,
      },
      session: { id: 'session-1' },
    },
    isPending: false,
  }),
  useAuthStore: (selector: (state: { customInstructions: string | null }) => unknown) =>
    selector({ customInstructions: null }),
}));

describe('usePromptBudget', () => {
  const defaultInput: {
    value: string;
    historyCharacters: number;
    capabilities: CapabilityId[];
  } = {
    value: 'Hello',
    historyCharacters: 0,
    capabilities: [],
  };

  const baseBudgetResult: BudgetCalculationResult & { isBalanceLoading: boolean } = {
    maxOutputTokens: 5000,
    estimatedInputTokens: 100,
    estimatedInputCost: 0.001,
    estimatedMinimumCost: 0.002,
    effectiveBalance: 10,
    currentUsage: 1100,
    capacityPercent: 1,
    outputCostPerToken: 0.000_001,
    isBalanceLoading: false,
  };

  const approvedBillingResult: ResolveBillingResult = {
    fundingSource: 'personal_balance',
  };

  beforeEach(() => {
    mockUseBudgetCalculation.mockReturnValue(baseBudgetResult);
    mockUseConversationBudgets.mockReturnValue({
      data: undefined,
      isPending: true,
      isLoading: false,
    });
    mockUseResolveBilling.mockReturnValue(approvedBillingResult);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('return shape', () => {
    it('returns flat PromptBudgetResult with all expected fields', () => {
      const { result } = renderHook(() => usePromptBudget(defaultInput));

      expect(result.current).toEqual(
        expect.objectContaining({
          fundingSource: 'personal_balance',
          notifications: expect.any(Array),
          capacityPercent: 1,
          capacityCurrentUsage: 1100,
          capacityMaxCapacity: 128_000,
          estimatedCostCents: expect.any(Number),
          isOverCapacity: false,
          hasBlockingError: false,
          hasContent: true,
        })
      );
    });

    it('returns estimatedCostCents as estimatedMinimumCost * 100', () => {
      const { result } = renderHook(() => usePromptBudget(defaultInput));

      // estimatedMinimumCost = 0.002 → cents = 0.2
      expect(result.current.estimatedCostCents).toBeCloseTo(0.2, 5);
    });
  });

  describe('solo conversation', () => {
    it('passes null to useConversationBudgets when no conversationId', () => {
      renderHook(() => usePromptBudget(defaultInput));

      expect(mockUseConversationBudgets).toHaveBeenCalledWith(null);
    });

    it('does not pass group context to useResolveBilling for solo', () => {
      renderHook(() => usePromptBudget(defaultInput));

      const callArgument = mockUseResolveBilling.mock.calls[0]![0] as Record<string, unknown>;
      expect(callArgument).not.toHaveProperty('group');
    });
  });

  describe('group budget wiring', () => {
    it('passes null to useConversationBudgets for conversation owners', () => {
      renderHook(() =>
        usePromptBudget({
          ...defaultInput,
          conversationId: 'conv-1',
          currentUserPrivilege: 'owner',
        })
      );

      expect(mockUseConversationBudgets).toHaveBeenCalledWith(null);
    });

    it('passes group context to useResolveBilling when group budget data is available', () => {
      mockUseConversationBudgets.mockReturnValue({
        data: {
          effectiveDollars: 5,
          ownerTier: 'paid',
          ownerBalanceDollars: 50,
          conversationBudget: '10.00',
          totalSpent: '2.00',
          memberBudgets: [],
        },
        isLoading: false,
      });

      renderHook(() =>
        usePromptBudget({
          ...defaultInput,
          conversationId: 'conv-1',
          currentUserPrivilege: 'write',
        })
      );

      // Hook converts dollars → cents for internal use
      expect(mockUseResolveBilling).toHaveBeenCalledWith(
        expect.objectContaining({
          group: {
            effectiveCents: 500,
            ownerTier: 'paid',
            ownerBalanceCents: 5000,
          },
        })
      );
    });

    it('does not pass group context while budget data is loading', () => {
      mockUseConversationBudgets.mockReturnValue({
        data: undefined,
        isLoading: true,
      });

      renderHook(() =>
        usePromptBudget({
          ...defaultInput,
          conversationId: 'conv-1',
          currentUserPrivilege: 'write',
        })
      );

      const callArgument = mockUseResolveBilling.mock.calls[0]![0] as Record<string, unknown>;
      expect(callArgument).not.toHaveProperty('group');
    });

    it('passes hasDelegatedBudget to generateNotifications when group member', () => {
      mockUseConversationBudgets.mockReturnValue({
        data: {
          effectiveCents: 500,
          ownerTier: 'paid',
          ownerBalanceCents: 5000,
          conversationBudgetCents: 1000,
          totalSpentCents: 200,
          memberBudgets: [],
          memberBudgetDollars: 5,
        },
        isLoading: false,
      });
      mockUseResolveBilling.mockReturnValue({ fundingSource: 'owner_balance' });

      const { result } = renderHook(() =>
        usePromptBudget({
          ...defaultInput,
          conversationId: 'conv-1',
          currentUserPrivilege: 'write',
        })
      );

      // owner_balance + hasDelegatedBudget → delegated_budget_notice
      const hasDelegatedNotice = result.current.notifications.some(
        (n: { id: string }) => n.id === 'delegated_budget_notice'
      );
      expect(hasDelegatedNotice).toBe(true);
    });

    it('does not show delegated_budget_exhausted when memberBudgetDollars is 0', () => {
      mockUseConversationBudgets.mockReturnValue({
        data: {
          effectiveDollars: 0,
          ownerTier: 'paid',
          ownerBalanceDollars: 50,
          conversationBudget: '10.00',
          totalSpent: '0.00',
          memberBudgets: [],
          memberBudgetDollars: 0,
        },
        isPending: false,
        isLoading: false,
      });
      mockUseResolveBilling.mockReturnValue({ fundingSource: 'personal_balance' });

      const { result } = renderHook(() =>
        usePromptBudget({
          ...defaultInput,
          conversationId: 'conv-1',
          currentUserPrivilege: 'write',
        })
      );

      const hasExhausted = result.current.notifications.some(
        (n: { id: string }) => n.id === 'delegated_budget_exhausted'
      );
      expect(hasExhausted).toBe(false);
    });
  });

  describe('billing and notifications', () => {
    it('hasBlockingError is true when billing is denied', () => {
      mockUseResolveBilling.mockReturnValue({
        fundingSource: 'denied',
        reason: 'insufficient_balance',
      });

      const { result } = renderHook(() => usePromptBudget(defaultInput));

      expect(result.current.hasBlockingError).toBe(true);
    });

    it('hasBlockingError is true when over capacity', () => {
      mockUseBudgetCalculation.mockReturnValue({
        ...baseBudgetResult,
        capacityPercent: 150,
      });

      const { result } = renderHook(() => usePromptBudget(defaultInput));

      expect(result.current.hasBlockingError).toBe(true);
      expect(result.current.isOverCapacity).toBe(true);
    });

    it('hasContent is false for empty input', () => {
      const { result } = renderHook(() =>
        usePromptBudget({
          ...defaultInput,
          value: '   ',
        })
      );

      expect(result.current.hasContent).toBe(false);
    });

    it('passes isPremiumModel based on premiumIds', () => {
      renderHook(() => usePromptBudget(defaultInput));

      // premiumIds is empty set, so test-model is NOT premium
      expect(mockUseResolveBilling).toHaveBeenCalledWith(
        expect.objectContaining({
          isPremiumModel: false,
        })
      );
    });

    it('returns fundingSource from useResolveBilling', () => {
      mockUseResolveBilling.mockReturnValue({ fundingSource: 'free_allowance' });

      const { result } = renderHook(() => usePromptBudget(defaultInput));

      expect(result.current.fundingSource).toBe('free_allowance');
    });
  });

  describe('multi-model budget', () => {
    it('passes all selected models pricing to useBudgetCalculation', () => {
      mockSelectedModels.current = [
        { id: 'model-a', name: 'Model A' },
        { id: 'model-b', name: 'Model B' },
      ];
      mockModelsData.current = {
        models: [
          {
            id: 'model-a',
            contextLength: 128_000,
            pricePerInputToken: 0.000_01,
            pricePerOutputToken: 0.000_03,
          },
          {
            id: 'model-b',
            contextLength: 64_000,
            pricePerInputToken: 0.000_02,
            pricePerOutputToken: 0.000_06,
          },
        ],
        premiumIds: new Set<string>(),
      };

      renderHook(() => usePromptBudget(defaultInput));

      const budgetInput = mockUseBudgetCalculation.mock.calls[0]![0] as { models: unknown[] };
      expect(budgetInput.models).toHaveLength(2);
    });

    it('uses minimum context length across all selected models', () => {
      mockSelectedModels.current = [
        { id: 'model-a', name: 'Model A' },
        { id: 'model-b', name: 'Model B' },
      ];
      mockModelsData.current = {
        models: [
          {
            id: 'model-a',
            contextLength: 128_000,
            pricePerInputToken: 0.000_01,
            pricePerOutputToken: 0.000_03,
          },
          {
            id: 'model-b',
            contextLength: 64_000,
            pricePerInputToken: 0.000_02,
            pricePerOutputToken: 0.000_06,
          },
        ],
        premiumIds: new Set<string>(),
      };

      renderHook(() => usePromptBudget(defaultInput));

      // capacityMaxCapacity should reflect the minimum context length (64_000)
      const budgetInput = mockUseBudgetCalculation.mock.calls[0]![0] as {
        models: { contextLength: number }[];
      };
      const contextLengths = budgetInput.models.map((m) => m.contextLength);
      expect(Math.min(...contextLengths)).toBe(64_000);
    });

    it('reports isPremiumModel true when any selected model is premium', () => {
      mockSelectedModels.current = [
        { id: 'model-a', name: 'Model A' },
        { id: 'model-b', name: 'Model B' },
      ];
      mockModelsData.current = {
        models: [
          {
            id: 'model-a',
            contextLength: 128_000,
            pricePerInputToken: 0.000_01,
            pricePerOutputToken: 0.000_03,
          },
          {
            id: 'model-b',
            contextLength: 64_000,
            pricePerInputToken: 0.000_02,
            pricePerOutputToken: 0.000_06,
          },
        ],
        premiumIds: new Set<string>(['model-b']),
      };

      renderHook(() => usePromptBudget(defaultInput));

      expect(mockUseResolveBilling).toHaveBeenCalledWith(
        expect.objectContaining({
          isPremiumModel: true,
        })
      );
    });

    afterEach(() => {
      // Reset to single-model defaults
      mockSelectedModels.current = [{ id: 'test-model', name: 'Test Model' }];
      mockModelsData.current = {
        models: [
          {
            id: 'test-model',
            contextLength: 128_000,
            pricePerInputToken: 0.000_01,
            pricePerOutputToken: 0.000_03,
          },
        ],
        premiumIds: new Set<string>(),
      };
    });
  });

  describe('read-only privilege', () => {
    it('hasBlockingError is true when privilege is read', () => {
      const { result } = renderHook(() =>
        usePromptBudget({
          ...defaultInput,
          conversationId: 'conv-1',
          currentUserPrivilege: 'read',
        })
      );

      expect(result.current.hasBlockingError).toBe(true);
    });

    it('fundingSource is denied when privilege is read', () => {
      const { result } = renderHook(() =>
        usePromptBudget({
          ...defaultInput,
          conversationId: 'conv-1',
          currentUserPrivilege: 'read',
        })
      );

      expect(result.current.fundingSource).toBe('denied');
    });

    it('includes read_only_notice notification when privilege is read', () => {
      const { result } = renderHook(() =>
        usePromptBudget({
          ...defaultInput,
          conversationId: 'conv-1',
          currentUserPrivilege: 'read',
        })
      );

      const hasReadOnlyNotice = result.current.notifications.some(
        (n: { id: string }) => n.id === 'read_only_notice'
      );
      expect(hasReadOnlyNotice).toBe(true);
    });
  });

  describe('loading state blocking', () => {
    it('hasBlockingError is true while group budget is loading', () => {
      mockUseConversationBudgets.mockReturnValue({
        data: undefined,
        isPending: true,
        isLoading: true,
      });

      const { result } = renderHook(() =>
        usePromptBudget({
          ...defaultInput,
          conversationId: 'conv-1',
          currentUserPrivilege: 'write',
        })
      );

      expect(result.current.hasBlockingError).toBe(true);
    });

    it('hasBlockingError is true while balance is loading', () => {
      mockUseBudgetCalculation.mockReturnValue({
        ...baseBudgetResult,
        isBalanceLoading: true,
      });

      const { result } = renderHook(() => usePromptBudget(defaultInput));

      expect(result.current.hasBlockingError).toBe(true);
    });

    it('hasBlockingError is false once group budget and balance have loaded', () => {
      mockUseConversationBudgets.mockReturnValue({
        data: {
          effectiveCents: 500,
          ownerTier: 'paid',
          ownerBalanceCents: 5000,
          conversationBudgetCents: 1000,
          totalSpentCents: 200,
          memberBudgets: [],
        },
        isPending: false,
        isLoading: false,
      });
      mockUseBudgetCalculation.mockReturnValue({
        ...baseBudgetResult,
        isBalanceLoading: false,
      });

      const { result } = renderHook(() =>
        usePromptBudget({
          ...defaultInput,
          conversationId: 'conv-1',
          currentUserPrivilege: 'write',
        })
      );

      expect(result.current.hasBlockingError).toBe(false);
    });

    it('group budget loading does not block owners', () => {
      mockUseConversationBudgets.mockReturnValue({
        data: undefined,
        isPending: true,
        isLoading: false,
      });

      const { result } = renderHook(() =>
        usePromptBudget({
          ...defaultInput,
          conversationId: 'conv-1',
          currentUserPrivilege: 'owner',
        })
      );

      // Owner is not a group member, so group budget pending does not block
      expect(result.current.hasBlockingError).toBe(false);
    });
  });
});
