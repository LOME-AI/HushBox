import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, renderHook } from '@testing-library/react';
import {
  LOW_BALANCE_OUTPUT_TOKEN_THRESHOLD,
  REFUSAL_CODES,
  SMART_MODEL_ID,
  buildTurnSystemPrompt,
  isOverContextCapacity,
  isTransientBlock,
  noticeText,
  planReasoning,
  promptCharacterCount,
  resolveClientBilling,
  modelSchema,
  utcDayKey,
  type CanonicalReasoningEffort,
  type ContextFillBand,
  type Model,
  type NoticeReason,
  type ResolveBillingResult,
} from '@hushbox/shared';
import { usePromptBudget } from '@/hooks/billing/use-prompt-budget';
import { resolveDrainDecision } from '@/hooks/chat/use-authenticated-chat';
import { ReasoningEffortMenu } from '@/components/chat/input/reasoning-effort-menu';
import { useReasoningEffortStore } from '@/stores/reasoning-effort';
import type { ModelsData } from '@/hooks/models/models';
import type { BudgetCalculationResult } from '@/hooks/billing/use-budget-calculation';

/**
 * The shared plan's budget for the reasoning fixture below — the number the
 * hook must feed the budget calculation. Read from the published producer, not
 * from the ladder it computes from.
 */
function plannedBudget(level: CanonicalReasoningEffort): number {
  const planned = planReasoning({ contextLength: 128_000, reasoning: {} }, level, 1);
  if (!planned.feasible) throw new Error(`the reasoning fixture must plan ${level}`);
  return planned.plan.reasoningBudgetTokens;
}

const {
  mockUseBudgetCalculation,
  mockUseConversationBudgets,
  mockUseResolveBilling,
  mockSelectedModels,
  mockModelsData,
  mockCatalogRead,
  mockSearchStore,
  mockSession,
  mockActiveModality,
  mockImageSelections,
  mockVideoSelections,
  mockAudioSelections,
  mockImageConfig,
  mockVideoConfig,
  mockAudioConfig,
} = vi.hoisted(() => {
  const modelsData: ModelsData = {
    models: [
      {
        id: 'test-model',
        name: 'Test Model',
        provider: 'Fictional',
        description: 'Text generation model.',
        modality: 'text',
        supportedParameters: [],
        contextLength: 128_000,
        pricing: { inputPerToken: '10000', outputPerToken: '30000' },
      },
    ],
    premiumIds: new Set<string>(),
  };
  return {
    mockUseBudgetCalculation: vi.fn(),
    mockUseConversationBudgets: vi.fn(),
    mockUseResolveBilling: vi.fn(),
    mockSelectedModels: { current: [{ id: 'test-model', name: 'Test Model' }] },
    mockImageSelections: { current: [] as { id: string; name: string }[] },
    mockVideoSelections: { current: [] as { id: string; name: string }[] },
    mockAudioSelections: { current: [] as { id: string; name: string }[] },
    mockActiveModality: { current: 'text' as 'text' | 'image' | 'video' | 'audio' },
    mockImageConfig: { current: { aspectRatio: '1:1' as const } },
    mockVideoConfig: {
      current: {
        aspectRatio: '16:9' as '16:9' | '9:16',
        durationSeconds: 4,
        resolution: '720p' as '720p' | '1080p',
      },
    },
    mockAudioConfig: {
      current: { format: 'mp3' as 'mp3' | 'ogg' | 'wav', maxDurationSeconds: 600 },
    },
    mockModelsData: { current: modelsData },
    mockCatalogRead: { current: { isError: false } },
    mockSearchStore: { current: { webSearchEnabled: false } },
    mockSession: {
      current: {
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
      } as { data: { user: { id: string } } | null; isPending: boolean },
    },
  };
});

const { mockUseTurnOptions } = vi.hoisted(() => ({ mockUseTurnOptions: vi.fn() }));

vi.mock('@/hooks/billing/use-turn-options', () => ({
  useTurnOptions: (input: unknown) => mockUseTurnOptions(input) as unknown,
}));

/** A produced pair with the two sendability flags these tests care about. */
interface PairOptions {
  refusal?: string;
  heldNanoUsd?: bigint;
  payer?: 'self' | 'owner';
  payerSpendableNanoUsd?: bigint;
  /** The rung the admissible set took its hold at. */
  holdEffort?: string;
}

function pair(affordable: boolean, admissible: boolean, options: PairOptions = {}): unknown {
  const {
    refusal = 'insufficient_funds',
    heldNanoUsd = 0n,
    payer = 'self',
    payerSpendableNanoUsd = 0n,
    holdEffort,
  } = options;
  const held = holdEffort === undefined ? {} : { holdEffort };
  return {
    isPending: false,
    heldNanoUsd,
    payerSpendableNanoUsd,
    payer,
    options: {
      affordable: affordable
        ? { sendable: true, turnDimensions: [] }
        : { sendable: false, refusal, turnDimensions: [] },
      admissible: admissible
        ? { sendable: true, turnDimensions: [], ...held }
        : { sendable: false, refusal, turnDimensions: [], ...held },
    },
    isFundingUnavailable: false,
  };
}

/**
 * The adapter's answer while a read the turn is priced from — the payer's funding
 * or the model catalog — is still outstanding: no pair, no figures, and no
 * refusal, because a read in flight has refused nothing.
 */
function readStillInFlight(): unknown {
  return {
    isPending: true,
    isFundingUnavailable: false,
    options: undefined,
    heldNanoUsd: 0n,
    payerSpendableNanoUsd: 0n,
    payer: 'self',
  };
}

/** The adapter's answer when the payer's funding read is exhausted: no pair, no figures. */
function fundingUnavailable(): unknown {
  return {
    isPending: false,
    isFundingUnavailable: true,
    options: undefined,
    heldNanoUsd: 0n,
    payerSpendableNanoUsd: 0n,
    payer: 'self',
  };
}

const { mockUseMediaTurnOptions } = vi.hoisted(() => ({ mockUseMediaTurnOptions: vi.fn() }));

vi.mock('@/hooks/billing/use-media-turn-options', () => ({
  useMediaTurnOptions: (input: unknown) => mockUseMediaTurnOptions(input) as unknown,
}));

/** The media pair, with the two sendability flags these tests care about. */
function mediaPair(admissible: boolean, refusal = 'insufficient_funds'): unknown {
  const set = (sendable: boolean): unknown =>
    sendable
      ? { sendable: true, all: [], turnDimensions: [] }
      : { sendable: false, refusal, all: [], turnDimensions: [] };
  return {
    isPending: false,
    isFundingUnavailable: false,
    options: { affordable: set(true), admissible: set(admissible) },
  };
}

/** The media adapter's answer while a funding or catalog read is still in flight. */
function mediaPending(): unknown {
  return { isPending: true, isFundingUnavailable: false, options: undefined };
}

vi.mock('@/hooks/billing/use-budget-calculation', () => ({
  useBudgetCalculation: (...args: unknown[]) => mockUseBudgetCalculation(...args),
}));

vi.mock('@/hooks/billing/use-conversation-budgets', () => ({
  useConversationBudgets: (...args: unknown[]) => mockUseConversationBudgets(...args),
}));

vi.mock('@/hooks/billing/use-resolve-billing', () => ({
  useResolveBilling: (...args: unknown[]) => mockUseResolveBilling(...args),
}));

type FixtureTier = 'free' | 'paid' | 'trial' | 'guest';

/** The served funding snapshot the spendable hook hands back. */
interface SpendableFixture {
  spendableNanoUsd: string;
  heldNanoUsd: string;
  tier?: FixtureTier;
  payer?: 'self' | 'owner';
}

interface SpendableQueryFixture {
  data: SpendableFixture | undefined;
  isPending: boolean;
}

const { mockTierInfo, mockSpendable, mockUnscopedSpendable, mockUseSpendableFn } = vi.hoisted(
  () => ({
    mockTierInfo: {
      current: {
        tier: 'free' as FixtureTier,
        purchasedBalanceNanoUsd: 0n,
        freeAllowanceNanoUsd: 0n,
      },
    },
    mockSpendable: { current: { data: undefined, isPending: false } as SpendableQueryFixture },
    mockUnscopedSpendable: { current: undefined as SpendableQueryFixture | undefined },
    mockUseSpendableFn: vi.fn(),
  })
);

vi.mock('@/hooks/billing/use-user-tier-info', () => ({
  useUserTierInfo: () => mockTierInfo.current,
}));

vi.mock('@/hooks/billing/use-spendable', () => ({
  useSpendable: (conversationId?: string | null) => {
    mockUseSpendableFn(conversationId);
    // The conversation-scoped read and the argument-free one are distinct
    // queries serving different wallets, so a test that needs them to disagree
    // sets `mockUnscopedSpendable`; unset, both arms share one fixture.
    if ((conversationId ?? null) === null && mockUnscopedSpendable.current !== undefined) {
      return mockUnscopedSpendable.current;
    }
    return mockSpendable.current;
  },
}));

vi.mock('@/stores/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/model')>();
  const { createModelStoreStub, selectorFromState } = await import('@/test-utils/model-store-mock');
  return {
    ...actual,
    useModelStore: (selector?: (state: unknown) => unknown) => {
      const state = createModelStoreStub({
        activeModality: mockActiveModality.current,
        selections: {
          text: mockSelectedModels.current,
          image: mockImageSelections.current,
          audio: mockAudioSelections.current,
          video: mockVideoSelections.current,
        },
        imageConfig: mockImageConfig.current,
        videoConfig: mockVideoConfig.current,
        audioConfig: mockAudioConfig.current,
      });
      return selectorFromState(state)(selector as (s: unknown) => unknown);
    },
  };
});

vi.mock('@/hooks/models/models', () => ({
  useModels: () => ({
    data: mockModelsData.current,
    isLoading: false,
    isError: mockCatalogRead.current.isError,
  }),
}));

vi.mock('@/stores/search', () => ({
  useSearchStore: () => mockSearchStore.current,
}));

const { mockCustomInstructions, mockInstructionsStatus, mockStoreUser } = vi.hoisted(() => ({
  mockCustomInstructions: { current: null as string | null },
  mockInstructionsStatus: { current: 'absent' as 'pending' | 'absent' | 'present' },
  mockStoreUser: { current: { id: 'user-1' } as { id: string } | null },
}));

// The predicate comes from the real module rather than a second copy here: a
// mock that re-implemented it would agree with production only until one of
// them changed.
vi.mock('@/lib/auth/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/auth')>();
  return {
    selectInstructionsReadUnresolved: actual.selectInstructionsReadUnresolved,
    useSession: () => mockSession.current,
    useAuthStore: (
      selector: (state: {
        customInstructions: string | null;
        customInstructionsStatus: 'pending' | 'absent' | 'present';
        user: { id: string } | null;
      }) => unknown
    ) =>
      selector({
        customInstructions: mockCustomInstructions.current,
        customInstructionsStatus: mockInstructionsStatus.current,
        user: mockStoreUser.current,
      }),
  };
});

const AUTHENTICATED_SESSION = {
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
};

describe('usePromptBudget', () => {
  const defaultInput: {
    value: string;
    historyCharacters: number;
  } = {
    value: 'Hello',
    historyCharacters: 0,
  };

  const baseBudgetResult: BudgetCalculationResult = {
    maxOutputTokens: 5000,
    // Reasoning-free by default, so the whole funded pool is the answer's.
    maxAnswerTokens: 5000,
    estimatedInputTokens: 100,
    currentUsage: 1100,
    capacityPercent: 1,
    isPriced: true,
  };

  const approvedBillingResult: ResolveBillingResult = {
    fundingSource: 'personal_balance',
  };

  beforeEach(() => {
    mockUseTurnOptions.mockReturnValue(pair(true, true));
    mockUseMediaTurnOptions.mockReturnValue(mediaPair(true));
    // The shared composer state is restored here rather than in the suites that
    // happen to mutate it: two order dependences were found in this file by
    // running it shuffled — a modality and a catalog each left mutated by a test
    // whose suite had no restoring `afterEach` — and a per-suite `afterEach` is
    // exactly the thing that gets forgotten when the next suite is added. Add to
    // this list when a test mutates a ref that is not on it.
    mockActiveModality.current = 'text';
    mockSelectedModels.current = [{ id: 'test-model', name: 'Test Model' }];
    mockImageSelections.current = [];
    mockVideoSelections.current = [];
    mockAudioSelections.current = [];
    mockImageConfig.current = { aspectRatio: '1:1' };
    mockVideoConfig.current = { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' };
    mockAudioConfig.current = { format: 'mp3', maxDurationSeconds: 600 };
    mockCatalogRead.current = { isError: false };
    mockModelsData.current = {
      models: [
        {
          id: 'test-model',
          name: 'Test Model',
          provider: 'Fictional',
          description: 'Text generation model.',
          modality: 'text',
          supportedParameters: [],
          contextLength: 128_000,
          pricing: { inputPerToken: '10000', outputPerToken: '30000' },
        },
      ],
      premiumIds: new Set<string>(),
    };
    mockSession.current = AUTHENTICATED_SESSION;
    mockCustomInstructions.current = null;
    mockInstructionsStatus.current = 'absent';
    mockStoreUser.current = { id: 'user-1' };
    mockSearchStore.current = { webSearchEnabled: false };
    mockTierInfo.current = {
      tier: 'free',
      purchasedBalanceNanoUsd: 0n,
      freeAllowanceNanoUsd: 0n,
    };
    mockSpendable.current = { data: undefined, isPending: false };
    mockUnscopedSpendable.current = undefined;
    mockUseBudgetCalculation.mockReturnValue(baseBudgetResult);
    mockUseConversationBudgets.mockReturnValue({
      data: undefined,
      isPending: true,
      isLoading: false,
    });
    mockUseResolveBilling.mockReturnValue(approvedBillingResult);
    useReasoningEffortStore.setState({
      preferredReasoningEffort: 'auto',
      enabledEffortChoices: undefined,
    });
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
          estimatedCostNanoUsd: expect.any(BigInt),
          isOverCapacity: false,
          hasBlockingError: false,
          hasContent: true,
        })
      );
    });

    it('exposes the affordable output tokens from the budget calculation', () => {
      const { result } = renderHook(() => usePromptBudget(defaultInput));

      expect(result.current.maxOutputTokens).toBe(5000);
    });

    it('exposes the estimated input tokens from the budget calculation', () => {
      const { result } = renderHook(() => usePromptBudget(defaultInput));

      expect(result.current.estimatedInputTokens).toBe(100);
    });
  });

  describe('the context-fill band the composer paints', () => {
    function bandAt(capacityPercent: number): {
      band: ContextFillBand;
      nearCapacityNotice: boolean;
    } {
      mockUseBudgetCalculation.mockReturnValue({ ...baseBudgetResult, capacityPercent });
      const { result } = renderHook(() => usePromptBudget(defaultInput));
      return {
        band: result.current.capacityBand,
        nearCapacityNotice: result.current.notifications.some(
          (notice) => notice.id === 'context_near_capacity'
        ),
      };
    }

    // 66.6 is the fill that separates the produced band from one re-derived off
    // the rounded percentage the meter displays: it reads "67% filled" and is
    // below the red line.
    it.each([
      [0, 'room_to_spare'],
      [32.9, 'room_to_spare'],
      [33, 'filling_up'],
      [66.6, 'filling_up'],
      [67, 'nearly_full'],
      [100, 'nearly_full'],
    ] as const)('publishes %s percent of the window as %s', (capacityPercent, expected) => {
      expect(bandAt(capacityPercent).band).toBe(expected);
    });

    it.each([0, 32.9, 33, 66.6, 67, 100])(
      'raises the near-capacity notice at %s percent exactly where the band it paints is nearly full',
      (capacityPercent) => {
        const { band, nearCapacityNotice } = bandAt(capacityPercent);

        expect(nearCapacityNotice).toBe(band === 'nearly_full');
      }
    );
  });

  describe('the boundary past which the composer refuses to send', () => {
    function refusalAt(capacityPercent: number): { blocked: boolean; explained: boolean } {
      mockUseBudgetCalculation.mockReturnValue({ ...baseBudgetResult, capacityPercent });
      const { result } = renderHook(() => usePromptBudget(defaultInput));
      return {
        blocked: result.current.isOverCapacity,
        explained: result.current.notifications.some((notice) => notice.id === 'prompt_too_long'),
      };
    }

    // 99.6 and 100.4 both round to a full window and sit on opposite sides of
    // it, and a window filled exactly is not over: the fills where a boundary
    // re-derived here would part company with the produced verdict.
    it.each([0, 66, 99.6, 100, 100.4, 150])(
      'blocks the send at %s percent exactly where the produced verdict is over capacity',
      (capacityPercent) => {
        expect(refusalAt(capacityPercent).blocked).toBe(isOverContextCapacity(capacityPercent));
      }
    );

    // What the drift did to the user: the composer disabling the send while the
    // notice naming what to shorten came from the other comparison and stayed
    // silent — a dead end with no message.
    it.each([0, 66, 99.6, 100, 100.4, 150])(
      'says what the user must shorten at %s percent wherever it blocks the send',
      (capacityPercent) => {
        const { blocked, explained } = refusalAt(capacityPercent);

        expect(explained).toBe(blocked);
      }
    );
  });

  describe('link guest — the composer must not refuse a send the server accepts', () => {
    /**
     * A write-privileged link guest composing in the conversation its link
     * grants, with a funded link: the produced verdict is sendable and the
     * served payer figure covers the turn.
     */
    function guestComposer(): void {
      mockSession.current = { data: null, isPending: false };
      mockTierInfo.current = {
        tier: 'guest',
        purchasedBalanceNanoUsd: 0n,
        freeAllowanceNanoUsd: 0n,
      };
      mockUseTurnOptions.mockReturnValue(pair(true, true, { payer: 'owner' }));
      mockUseResolveBilling.mockReturnValue({ fundingSource: 'owner_balance' });
    }

    it('does not block a funded guest from sending', () => {
      guestComposer();

      const { result } = renderHook(() =>
        usePromptBudget({
          ...defaultInput,
          conversationId: 'conversation-1',
          currentUserPrivilege: 'write',
        })
      );

      expect(result.current.hasBlockingError).toBe(false);
      expect(result.current.sendRefusal).toBeUndefined();
    });

    it('never fires the session-only budgets read for a guest', () => {
      guestComposer();

      renderHook(() =>
        usePromptBudget({
          ...defaultInput,
          conversationId: 'conversation-1',
          currentUserPrivilege: 'write',
        })
      );

      expect(mockUseConversationBudgets).toHaveBeenCalledWith(null);
    });

    it('refuses an unallocated guest with the ask-the-owner reason, never a payment path', () => {
      guestComposer();
      mockUseTurnOptions.mockReturnValue(
        pair(false, false, { refusal: 'insufficient_funds', payer: 'owner' })
      );

      const { result } = renderHook(() =>
        usePromptBudget({
          ...defaultInput,
          conversationId: 'conversation-1',
          currentUserPrivilege: 'write',
        })
      );

      expect(result.current.sendRefusal).toBe('guest_no_group_budget');
      expect(noticeText('guest_no_group_budget')).not.toContain('Add credit');
    });

    it("refuses a guest whose payer cannot cover with the owner's-budget reason", () => {
      guestComposer();
      mockUseTurnOptions.mockReturnValue(
        pair(true, false, {
          refusal: 'insufficient_funds',
          payer: 'owner',
          payerSpendableNanoUsd: 1n,
        })
      );

      const { result } = renderHook(() =>
        usePromptBudget({
          ...defaultInput,
          conversationId: 'conversation-1',
          currentUserPrivilege: 'write',
        })
      );

      expect(result.current.sendRefusal).toBe('group_owner_funds_unavailable');
      expect(noticeText('group_owner_funds_unavailable')).not.toContain('Add credit');
    });

    it('tells a guest the funding could not be read, rather than waiting on it forever', () => {
      guestComposer();
      mockUseTurnOptions.mockReturnValue(fundingUnavailable());

      const { result } = renderHook(() =>
        usePromptBudget({
          ...defaultInput,
          conversationId: 'conversation-1',
          currentUserPrivilege: 'write',
        })
      );

      expect(result.current.sendRefusal).toBe('send_check_unavailable');
      expect(result.current.hasBlockingError).toBe(true);
    });
  });

  describe('who a link guest is told is paying', () => {
    /**
     * A write-privileged link guest. Its payer is structural — the conversation
     * owner funds the turn whether or not the funds cover it — so the served
     * headroom and the turn's money verdict are the only two facts these cases
     * vary. No member-budget row ever reaches the hook for a guest: that read is
     * session-classed and refuses one.
     */
    function guestComposing(
      affordable: boolean,
      admissible: boolean,
      options: PairOptions
    ): { noticeIds: string[]; sendRefusal: NoticeReason | undefined } {
      mockSession.current = { data: null, isPending: false };
      mockTierInfo.current = {
        tier: 'guest',
        purchasedBalanceNanoUsd: 0n,
        freeAllowanceNanoUsd: 0n,
      };
      mockUseResolveBilling.mockReturnValue({ fundingSource: 'owner_balance' });
      mockUseTurnOptions.mockReturnValue(
        pair(affordable, admissible, { payer: 'owner', ...options })
      );

      const { result } = renderHook(() =>
        usePromptBudget({
          ...defaultInput,
          conversationId: 'conversation-1',
          currentUserPrivilege: 'write',
        })
      );

      return {
        noticeIds: result.current.notifications.map((notice) => notice.id),
        sendRefusal: result.current.sendRefusal,
      };
    }

    afterEach(() => {
      mockActiveModality.current = 'text';
      mockImageSelections.current = [];
    });

    it("tells a funded guest that the owner's allocation is paying for the turn", () => {
      const { noticeIds, sendRefusal } = guestComposing(true, true, {
        payerSpendableNanoUsd: 5_000_000_000n,
      });

      expect(sendRefusal).toBeUndefined();
      expect(noticeIds).toContain('group_budget_pays');
    });

    it('claims nothing pays for a guest the link never allocated to', () => {
      const { noticeIds, sendRefusal } = guestComposing(false, false, {
        refusal: 'insufficient_funds',
        payerSpendableNanoUsd: 0n,
      });

      expect(sendRefusal).toBe('guest_no_group_budget');
      expect(noticeIds).not.toContain('group_budget_pays');
    });

    it("claims nothing pays beside the refusal that the owner's funds fall short", () => {
      const { noticeIds, sendRefusal } = guestComposing(true, false, {
        refusal: 'insufficient_funds',
        payerSpendableNanoUsd: 1n,
      });

      expect(sendRefusal).toBe('group_owner_funds_unavailable');
      expect(noticeIds).not.toContain('group_budget_pays');
    });

    it('tells a funded guest who pays while a block that is not about money holds the send', () => {
      // The refusal builder tests the money first, so a length block reaching
      // the composer is itself proof the owner's allocation covers this turn.
      // The notice states who pays, not that the send may proceed, and a
      // signed-in member in the same state keeps it.
      const { noticeIds, sendRefusal } = guestComposing(true, false, {
        refusal: 'prompt_too_long',
        payerSpendableNanoUsd: 5_000_000_000n,
      });

      expect(sendRefusal).toBe('prompt_too_long');
      expect(noticeIds).toContain('group_budget_pays');
    });

    it("claims nothing pays beside a media turn's raw money refusal", () => {
      // The per-unit producer refuses a media turn before the guest re-voice
      // runs, so a guest reads the raw code — which still says the owner's
      // money does not cover this turn.
      mockActiveModality.current = 'image';
      mockImageSelections.current = [{ id: 'image-model', name: 'Image Model' }];
      mockUseMediaTurnOptions.mockReturnValue(mediaPair(false));

      const { noticeIds, sendRefusal } = guestComposing(true, true, {
        payerSpendableNanoUsd: 5_000_000_000n,
      });

      expect(sendRefusal).toBe('insufficient_funds');
      expect(noticeIds).not.toContain('group_budget_pays');
    });

    it('tells a signed-in member the owner pays off their own budget row, never the served headroom', () => {
      mockUseConversationBudgets.mockReturnValue({
        data: { members: [{ capNanoUsd: '5000000000' }] },
        isPending: false,
      });
      mockUseResolveBilling.mockReturnValue({ fundingSource: 'owner_balance' });
      mockUseTurnOptions.mockReturnValue(
        pair(true, true, { payer: 'owner', payerSpendableNanoUsd: 0n })
      );

      const { result } = renderHook(() =>
        usePromptBudget({
          ...defaultInput,
          conversationId: 'conv-1',
          currentUserPrivilege: 'write',
        })
      );

      expect(result.current.notifications.map((notice) => notice.id)).toContain(
        'group_budget_pays'
      );
    });
  });

  describe('a funding read that failed says so', () => {
    /**
     * The state this describes is the one with NO verdict at all: the payer has
     * a funding door, the read is exhausted, and nothing about the turn's money
     * is known. A blocked send must still carry a notice (§Notices 7), and the
     * notice must name an action (§Notices 3) — waiting forever is not one.
     */
    afterEach(() => {
      // Restore default text-mode state for subsequent suites.
      mockActiveModality.current = 'text';
      mockImageSelections.current = [];
    });

    it('refuses an authenticated send with the funding-unavailable reason', () => {
      mockUseTurnOptions.mockReturnValue(fundingUnavailable());

      const { result } = renderHook(() => usePromptBudget(defaultInput));

      expect(result.current.sendRefusal).toBe('send_check_unavailable');
      expect(result.current.hasBlockingError).toBe(true);
    });

    it('refuses a media turn too, since a failed read is no modality of verdict', () => {
      // The text-only carve-out exists because the producer declines to PRICE a
      // media turn. It cannot cover this state: nothing was priced for any
      // modality, so leaving media out would let it send on unknown funding.
      mockActiveModality.current = 'image';
      mockImageSelections.current = [{ id: 'image-model', name: 'Image Model' }];
      mockUseTurnOptions.mockReturnValue(fundingUnavailable());

      const { result } = renderHook(() => usePromptBudget(defaultInput));

      expect(result.current.sendRefusal).toBe('send_check_unavailable');
    });

    it('states no other money fact while the funding is unknown', () => {
      // Every notification is derived from a funding verdict, and there is no
      // funding snapshot to have derived one from — so rendering them states
      // things about the payer's money that nothing established. The resolver
      // returns exactly this when the read is exhausted; a served source beside
      // an unread snapshot is a pair the chain cannot produce.
      mockTierInfo.current = {
        tier: 'free',
        purchasedBalanceNanoUsd: 0n,
        freeAllowanceNanoUsd: 0n,
      };
      mockUseResolveBilling.mockReturnValue({ fundingSource: 'no_verdict' });
      mockUseTurnOptions.mockReturnValue(fundingUnavailable());

      const { result } = renderHook(() => usePromptBudget(defaultInput));

      expect(result.current.notifications).toEqual([]);
    });

    it('keeps every other money notice while the funding IS known', () => {
      mockTierInfo.current = {
        tier: 'free',
        purchasedBalanceNanoUsd: 0n,
        freeAllowanceNanoUsd: 0n,
      };
      mockUseResolveBilling.mockReturnValue({ fundingSource: 'free_allowance' });

      const { result } = renderHook(() => usePromptBudget(defaultInput));

      expect(result.current.notifications.map((notice) => notice.id)).toContain(
        'free_allowance_pays'
      );
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

    it('is not a group member when a conversationId is present but privilege is omitted', () => {
      renderHook(() =>
        usePromptBudget({
          ...defaultInput,
          conversationId: 'conv-1',
          // currentUserPrivilege omitted → resolveIsGroupMember bails at the
          // privilege guard, so this is treated as solo (no group budget query).
        })
      );

      expect(mockUseConversationBudgets).toHaveBeenCalledWith(null);
      expect(mockUseResolveBilling).toHaveBeenCalledWith(
        expect.not.objectContaining({ group: expect.anything() })
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
          conversationCapNanoUsd: '10000000000',
          conversationSpentNanoUsd: '2000000000',
          ownerBalanceNanoUsd: '50000000000',
          members: [
            {
              memberId: 'mem-1',
              userId: 'user-1',
              username: 'testuser',
              privilege: 'write',
              capNanoUsd: '5000000000',
              spentNanoUsd: '0',
              effectiveRemainingNanoUsd: '5000000000',
            },
          ],
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

      // owner_balance + hasDelegatedBudget → the owner-funds-you notice
      const hasDelegatedNotice = result.current.notifications.some(
        (n: { id: string }) => n.id === 'group_budget_pays'
      );
      expect(hasDelegatedNotice).toBe(true);
    });

    it('discloses the payer switch when the member was never allocated a budget', () => {
      mockUseConversationBudgets.mockReturnValue({
        data: {
          conversationCapNanoUsd: '10000000000',
          conversationSpentNanoUsd: '0',
          ownerBalanceNanoUsd: '50000000000',
          members: [
            {
              memberId: 'mem-1',
              userId: 'user-1',
              username: 'testuser',
              privilege: 'write',
              capNanoUsd: '0',
              spentNanoUsd: '0',
              effectiveRemainingNanoUsd: '0',
            },
          ],
        },
        isPending: false,
        isLoading: false,
      });
      mockUseResolveBilling.mockReturnValue({
        fundingSource: 'personal_balance',
        payerSwitch: 'group_headroom_insufficient',
      });

      const { result } = renderHook(() =>
        usePromptBudget({
          ...defaultInput,
          conversationId: 'conv-1',
          currentUserPrivilege: 'write',
        })
      );

      const hasDisclosure = result.current.notifications.some(
        (n: { id: string }) => n.id === 'payer_switched_to_personal'
      );
      expect(hasDisclosure).toBe(true);
    });
  });

  describe('billing and notifications', () => {
    it('warns of a shortened answer off the answer share, not the funded pool', () => {
      // A pool of 34,000 with a 32,768-token reasoning budget pinned leaves
      // 1,232 tokens of answer: the pool clears the low-balance threshold
      // while the reply the payer actually receives does not.
      mockUseResolveBilling.mockReturnValue({ fundingSource: 'personal_balance' });
      mockUseBudgetCalculation.mockReturnValue({
        ...baseBudgetResult,
        maxOutputTokens: 34_000,
        maxAnswerTokens: 1232,
      });

      const { result } = renderHook(() => usePromptBudget(defaultInput));

      expect(result.current.notifications.map((notice) => notice.id)).toContain(
        'answer_may_be_shortened'
      );
    });

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

    it('treats a model as non-premium while the catalog is still loading', () => {
      // useModels().data undefined (loading) → premiumIds lookup short-circuits
      // and the `?? false` fallback applies.
      (mockModelsData as { current: unknown }).current = undefined;

      renderHook(() => usePromptBudget(defaultInput));

      expect(mockUseResolveBilling).toHaveBeenCalledWith(
        expect.objectContaining({ isPremiumModel: false })
      );
    });
  });

  describe('prompt measurement', () => {
    it('measures the send-path prompt through the shared counter', () => {
      // The send path never carries capability blocks (that feature is
      // deferred), so the hook takes no capabilities input: the measured
      // count is the ONE shared counter over the ONE builder's output.
      renderHook(() =>
        usePromptBudget({
          ...defaultInput,
          historyCharacters: 26,
        })
      );

      const budgetInput = mockUseBudgetCalculation.mock.calls[0]![0] as {
        promptCharacterCount: number;
      };
      expect(budgetInput.promptCharacterCount).toBe(
        promptCharacterCount({
          systemPrompt: buildTurnSystemPrompt({ utcDay: utcDayKey(new Date()) }),
          historyCharacters: 26,
          prompt: defaultInput.value,
        })
      );
    });

    it('folds the stored custom instructions into the measured system prompt', () => {
      mockCustomInstructions.current = 'Answer briefly.';

      renderHook(() => usePromptBudget(defaultInput));

      const budgetInput = mockUseBudgetCalculation.mock.calls[0]![0] as {
        promptCharacterCount: number;
      };
      expect(budgetInput.promptCharacterCount).toBe(
        promptCharacterCount({
          systemPrompt: buildTurnSystemPrompt({
            utcDay: utcDayKey(new Date()),
            customInstructions: 'Answer briefly.',
          }),
          historyCharacters: 0,
          prompt: defaultInput.value,
        })
      );
    });

    it('sizes the previewed storage from the composed message alone', () => {
      // The two counts reaching the core are different measurements of one
      // turn: the provider is sent the whole prompt, but only the message being
      // composed will rest. Handing the composed length here is what makes the
      // preview quote the ceiling the send gate will fit.
      renderHook(() =>
        usePromptBudget({ ...defaultInput, value: 'Hello there', historyCharacters: 4000 })
      );

      expect(mockUseBudgetCalculation).toHaveBeenCalledWith(
        expect.objectContaining({ inputCharacterCount: 'Hello there'.length })
      );
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
            name: 'Model A',
            provider: 'Fictional',
            description: 'Text generation model.',
            modality: 'text',
            supportedParameters: [],
            contextLength: 128_000,
            pricing: { inputPerToken: '10000', outputPerToken: '30000' },
          },
          {
            id: 'model-b',
            name: 'Model B',
            provider: 'Fictional',
            description: 'Text generation model.',
            modality: 'text',
            supportedParameters: [],
            contextLength: 64_000,
            pricing: { inputPerToken: '20000', outputPerToken: '60000' },
          },
        ],
        premiumIds: new Set<string>(),
      };

      renderHook(() => usePromptBudget(defaultInput));

      const budgetInput = mockUseBudgetCalculation.mock.calls[0]![0] as { models: unknown[] };
      expect(budgetInput.models).toHaveLength(2);
    });

    it('hands the budget core the turn options the producer answered', () => {
      const produced = pair(true, true) as { options: unknown };
      mockUseTurnOptions.mockReturnValue(produced);

      renderHook(() => usePromptBudget(defaultInput));

      const budgetInput = mockUseBudgetCalculation.mock.calls[0]![0] as { turnOptions: unknown };
      expect(budgetInput.turnOptions).toBe(produced.options);
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
            name: 'Model A',
            provider: 'Fictional',
            description: 'Text generation model.',
            modality: 'text',
            supportedParameters: [],
            contextLength: 128_000,
            pricing: { inputPerToken: '10000', outputPerToken: '30000' },
          },
          {
            id: 'model-b',
            name: 'Model B',
            provider: 'Fictional',
            description: 'Text generation model.',
            modality: 'text',
            supportedParameters: [],
            contextLength: 64_000,
            pricing: { inputPerToken: '20000', outputPerToken: '60000' },
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
            name: 'Model A',
            provider: 'Fictional',
            description: 'Text generation model.',
            modality: 'text',
            supportedParameters: [],
            contextLength: 128_000,
            pricing: { inputPerToken: '10000', outputPerToken: '30000' },
          },
          {
            id: 'model-b',
            name: 'Model B',
            provider: 'Fictional',
            description: 'Text generation model.',
            modality: 'text',
            supportedParameters: [],
            contextLength: 64_000,
            pricing: { inputPerToken: '20000', outputPerToken: '60000' },
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
            name: 'Test Model',
            provider: 'Fictional',
            description: 'Text generation model.',
            modality: 'text',
            supportedParameters: [],
            contextLength: 128_000,
            pricing: { inputPerToken: '10000', outputPerToken: '30000' },
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

    it('includes the read-only notification when privilege is read', () => {
      const { result } = renderHook(() =>
        usePromptBudget({
          ...defaultInput,
          conversationId: 'conv-1',
          currentUserPrivilege: 'read',
        })
      );

      const hasReadOnlyNotice = result.current.notifications.some(
        (n: { id: string }) => n.id === 'conversation_read_only'
      );
      expect(hasReadOnlyNotice).toBe(true);
    });
  });

  describe('web search cost', () => {
    afterEach(() => {
      mockSearchStore.current = { webSearchEnabled: false };
      mockModelsData.current = {
        models: [
          {
            id: 'test-model',
            name: 'Test Model',
            provider: 'Fictional',
            description: 'Text generation model.',
            modality: 'text',
            supportedParameters: [],
            contextLength: 128_000,
            pricing: { inputPerToken: '10000', outputPerToken: '30000' },
          },
        ],
        premiumIds: new Set<string>(),
      };
    });

    it('enables the core web-search reservation on useBudgetCalculation when web search is on', () => {
      mockSearchStore.current = { webSearchEnabled: true };

      renderHook(() => usePromptBudget(defaultInput));

      const budgetInput = mockUseBudgetCalculation.mock.calls[0]![0] as { webSearch?: boolean };
      // The client passes only the flag; the core adds the worst-case reservation
      // line item (never a mirrored client cost).
      expect(budgetInput.webSearch).toBe(true);
    });

    it('hands the budget the rung the producer took its hold at', () => {
      mockSearchStore.current = { webSearchEnabled: true };
      mockUseTurnOptions.mockReturnValue(pair(true, true, { holdEffort: 'low' }));

      renderHook(() => usePromptBudget(defaultInput));

      const budgetInput = mockUseBudgetCalculation.mock.calls[0]![0] as { loopEffort?: string };
      expect(budgetInput.loopEffort).toBe('low');
    });

    it('hands the budget no rung when the producer took its hold at none', () => {
      mockSearchStore.current = { webSearchEnabled: true };
      mockUseTurnOptions.mockReturnValue(pair(true, true));

      renderHook(() => usePromptBudget(defaultInput));

      const budgetInput = mockUseBudgetCalculation.mock.calls[0]![0] as { loopEffort?: string };
      expect(budgetInput.loopEffort).toBeUndefined();
    });

    it('omits the web-search reservation when web search is disabled', () => {
      mockSearchStore.current = { webSearchEnabled: false };

      renderHook(() => usePromptBudget(defaultInput));

      const budgetInput = mockUseBudgetCalculation.mock.calls[0]![0] as { webSearch?: boolean };
      expect(budgetInput.webSearch).toBeUndefined();
    });

    it('enables the web-search reservation regardless of model (search runs against any text model)', () => {
      // The search tool runs against any text model that supports tool calling.
      // The frontend budget preview must match the backend reservation, not gate
      // on per-model pricing.
      mockSearchStore.current = { webSearchEnabled: true };

      renderHook(() => usePromptBudget(defaultInput));

      const budgetInput = mockUseBudgetCalculation.mock.calls[0]![0] as { webSearch?: boolean };
      expect(budgetInput.webSearch).toBe(true);
    });

    it('omits the web-search reservation for unauthenticated (trial) users even when the toggle is persisted on', () => {
      // The search preference persists across sign-out/expiry (hushbox-search-storage
      // is not cleared by resetForUnauthenticated). Web search is authenticated-only,
      // so a stale `true` must not reserve the worst-case search cost — that would
      // exceed the 1¢ trial cap and block every trial message.
      mockSession.current = { data: null, isPending: false };
      mockSearchStore.current = { webSearchEnabled: true };

      renderHook(() => usePromptBudget(defaultInput));

      const budgetInput = mockUseBudgetCalculation.mock.calls[0]![0] as {
        webSearch?: boolean;
        isAuthenticated: boolean;
      };
      expect(budgetInput.isAuthenticated).toBe(false);
      expect(budgetInput.webSearch).toBeUndefined();
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

    // Both unsettled states block the send. They differ in what the surface
    // owes the user, never in whether money may be spent on a turn nothing has
    // priced.
    it('hasBlockingError is true while a read the turn is priced from is in flight', () => {
      mockUseTurnOptions.mockReturnValue(readStillInFlight());

      const { result } = renderHook(() => usePromptBudget(defaultInput));

      expect(result.current.hasBlockingError).toBe(true);
    });

    it('hasBlockingError is true once that read is exhausted', () => {
      mockUseTurnOptions.mockReturnValue(fundingUnavailable());

      const { result } = renderHook(() => usePromptBudget(defaultInput));

      expect(result.current.hasBlockingError).toBe(true);
    });

    it('hasBlockingError is false once group budget and balance have loaded', () => {
      mockUseConversationBudgets.mockReturnValue({
        data: {
          conversationCapNanoUsd: '10000000000',
          conversationSpentNanoUsd: '2000000000',
          ownerBalanceNanoUsd: '50000000000',
          members: [
            {
              memberId: 'mem-1',
              userId: 'user-1',
              username: 'testuser',
              privilege: 'write',
              capNanoUsd: '5000000000',
              spentNanoUsd: '0',
              effectiveRemainingNanoUsd: '5000000000',
            },
          ],
        },
        isPending: false,
        isLoading: false,
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

  describe('a read the turn is priced from still settling, published as its own flag', () => {
    /**
     * The composer's send affordance needs this state separately from
     * `hasBlockingError`, which cannot answer it: that flag is also true for
     * every refusal. It is published from the same term the send gate reads, so
     * a busy button and a closed gate cannot disagree.
     *
     * It is NOT on its own the question "is a read still settling" — the catalog
     * publishes no rows whether its read is coming or gone, so it is true for an
     * exhausted catalog read too, pinned below. A surface that must tell those
     * apart pairs it with `sendRefusal`.
     */
    it('reports loading while a read the turn is priced from is in flight', () => {
      mockUseTurnOptions.mockReturnValue(readStillInFlight());

      const { result } = renderHook(() => usePromptBudget(defaultInput));

      expect(result.current.isBillingLoading).toBe(true);
    });

    it('reports the funding read as loading while a member waits on the group budget', () => {
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

      expect(result.current.isBillingLoading).toBe(true);
    });

    it('reports the funding read as settled for an owner waiting on nothing', () => {
      const { result } = renderHook(() => usePromptBudget(defaultInput));

      expect(result.current.isBillingLoading).toBe(false);
    });

    it('still reports loading when the catalog read came back exhausted, alongside the refusal', () => {
      // NOT independent seams. An exhausted catalog read raises the refusal AND
      // leaves the produced pair pending, because the pair's pending term is
      // keyed on the ABSENCE of catalog rows and an exhausted read publishes
      // none. Both stubs are moved together because setting one alone builds a
      // state production cannot reach, and asserting against it is how a defect
      // hid behind a green test.
      //
      // The consequence is the reason this pair is pinned rather than tidied:
      // `isBillingLoading` alone cannot mean "still settling", so no surface may
      // use it alone to say so; pairing it with `sendRefusal` can.
      mockCatalogRead.current = { isError: true };
      mockUseTurnOptions.mockReturnValue(readStillInFlight());

      const { result } = renderHook(() => usePromptBudget(defaultInput));

      expect(result.current.sendRefusal).toBe('send_check_unavailable');
      expect(result.current.isBillingLoading).toBe(true);
    });

    it('reports loading while the account instruction read is unresolved', () => {
      // The instruction read prices this turn as much as the catalog does: the
      // system prompt the estimate measures is built from it, and a `null` that
      // has not settled is not the same turn as one with no instruction.
      mockInstructionsStatus.current = 'pending';

      const { result } = renderHook(() => usePromptBudget(defaultInput));

      expect(result.current.isBillingLoading).toBe(true);
      expect(result.current.hasBlockingError).toBe(true);
    });

    it('leaves a queued message queued while the account instruction read is unresolved', () => {
      // The queue drain is the one route to the turn builder with no hold of
      // its own: it re-resolves this gate before every drained send, so what
      // this composition answers is what a queued message gets.
      mockInstructionsStatus.current = 'pending';

      const { result } = renderHook(() => usePromptBudget(defaultInput));

      expect(resolveDrainDecision(result.current)).toEqual({ kind: 'wait' });
    });

    it('reports settled when the instruction read lands on an account that stores none', () => {
      mockInstructionsStatus.current = 'absent';

      const { result } = renderHook(() => usePromptBudget(defaultInput));

      expect(result.current.isBillingLoading).toBe(false);
      expect(result.current.hasBlockingError).toBe(false);
    });

    it('holds nothing for a sender with no account, whose read was never issued', () => {
      // A link guest and a signed-out visitor never start an instruction read,
      // so the store's initial `pending` says nothing about them. Reading it as
      // an outstanding read would disable their composer for the life of the
      // document.
      mockStoreUser.current = null;
      mockInstructionsStatus.current = 'pending';

      const { result } = renderHook(() => usePromptBudget(defaultInput));

      expect(result.current.isBillingLoading).toBe(false);
    });

    it('reports an exhausted FUNDING read as refused rather than loading', () => {
      // The asymmetry with the catalog above is the whole reason the loading
      // term moved: the funding read reports its exhausted arm as its own state,
      // so nothing about the turn is outstanding once it lands, while the
      // catalog has no such arm and its absence reads as pending either way.
      mockUseTurnOptions.mockReturnValue(fundingUnavailable());

      const { result } = renderHook(() => usePromptBudget(defaultInput));

      expect(result.current.sendRefusal).toBe('send_check_unavailable');
      expect(result.current.isBillingLoading).toBe(false);
    });
  });

  describe('media modalities feed per-image / per-second cost into billing', () => {
    afterEach(() => {
      // Restore default text-mode state for subsequent suites.
      mockActiveModality.current = 'text';
      mockImageSelections.current = [];
      mockVideoSelections.current = [];
      mockAudioSelections.current = [];
    });

    it('image modality: passes the core media cost to useResolveBilling, not the text token cost', () => {
      // Two image models at $0.04 each — a BILLABLE wire rate, which the core
      // passes through verbatim and adds storage to (measured: a 40,000,000 rate
      // prices at 184,000,000 against 144,000,000 for a zero rate, so the
      // provider leg is the rate itself). The resulting cents must flow into
      // useResolveBilling so a low-balance user gets the insufficient-balance gate.
      mockActiveModality.current = 'image';
      mockImageSelections.current = [
        { id: 'imagen-4', name: 'Imagen 4' },
        { id: 'imagen-4-fast', name: 'Imagen 4 Fast' },
      ];
      mockModelsData.current = {
        models: [
          {
            id: 'imagen-4',
            name: 'Imagen 4',
            provider: 'Google',
            description: 'Image generation model.',
            modality: 'image',
            supportedParameters: [],
            contextLength: 0,
            pricing: { perImage: '40000000', dearestPerImage: '40000000' },
          },
          {
            id: 'imagen-4-fast',
            name: 'Imagen 4 Fast',
            provider: 'Google',
            description: 'Image generation model.',
            modality: 'image',
            supportedParameters: [],
            contextLength: 0,
            pricing: { perImage: '40000000', dearestPerImage: '40000000' },
          },
        ],
        premiumIds: new Set<string>(),
      };

      renderHook(() => usePromptBudget(defaultInput));

      // A text turn hands the funding path a literal 0n; the media path must
      // hand it two $0.04 images plus storage.
      const lastCall = mockUseResolveBilling.mock.calls.at(-1)![0] as {
        estimatedMinimumCostNanoUsd: bigint;
      };
      // 2 × $0.04 = 8¢ floor; the wire rate is already billable and storage adds
      // to it. Nothing multiplies it — `use-media-cost-estimate.test.ts` pins that.
      expect(lastCall.estimatedMinimumCostNanoUsd).toBeGreaterThan(80_000_000n);
    });

    it('video modality: cost = perSecondByResolution × duration, summed per model', () => {
      mockActiveModality.current = 'video';
      mockVideoSelections.current = [{ id: 'veo-3.1', name: 'Veo 3.1' }];
      mockVideoConfig.current = {
        aspectRatio: '16:9',
        durationSeconds: 5,
        resolution: '720p',
      };
      mockModelsData.current = {
        models: [
          {
            id: 'veo-3.1',
            name: 'Veo 3.1',
            provider: 'Google',
            description: 'Video generation model.',
            modality: 'video',
            supportedParameters: [],
            contextLength: 0,
            pricing: {
              perSecondByResolution: { '720p': '100000000', '1080p': '150000000' },
              dearestPerSecondByResolution: { '720p': '100000000', '1080p': '150000000' },
            },
          },
        ],
        premiumIds: new Set<string>(),
      };

      renderHook(() => usePromptBudget(defaultInput));

      const lastCall = mockUseResolveBilling.mock.calls.at(-1)![0] as {
        estimatedMinimumCostNanoUsd: bigint;
      };
      // 5 seconds × $0.10/s = $0.50 from the wire's already-billable rate. Just
      // the floor here; the exact figure with storage is covered by
      // use-media-cost-estimate.test.
      expect(lastCall.estimatedMinimumCostNanoUsd).toBeGreaterThanOrEqual(500_000_000n);
    });

    it('audio modality: hands the funding path no estimate, because no price kind represents audio', () => {
      mockActiveModality.current = 'audio';
      mockAudioSelections.current = [{ id: 'tts-1', name: 'TTS-1' }];
      mockAudioConfig.current = { format: 'mp3', maxDurationSeconds: 60 };
      mockModelsData.current = {
        models: [
          {
            id: 'tts-1',
            name: 'TTS 1',
            provider: 'OpenAI',
            description: 'Audio generation model.',
            modality: 'audio',
            supportedParameters: [],
            contextLength: 0,
            pricing: {},
          },
        ],
        premiumIds: new Set<string>(),
      };

      renderHook(() => usePromptBudget(defaultInput));

      const lastCall = mockUseResolveBilling.mock.calls.at(-1)![0] as {
        estimatedMinimumCostNanoUsd: bigint | undefined;
      };
      expect(lastCall.estimatedMinimumCostNanoUsd).toBeUndefined();
    });

    it.each([
      { webSearch: 'off', webSearchEnabled: false },
      { webSearch: 'on', webSearchEnabled: true },
    ])(
      'never warns of a shortened reply on a media turn with web search $webSearch, as it produces no text',
      ({ webSearchEnabled }) => {
        mockSearchStore.current = { webSearchEnabled };
        mockActiveModality.current = 'image';
        mockImageSelections.current = [{ id: 'imagen-4', name: 'Imagen 4' }];
        mockModelsData.current = {
          models: [
            {
              id: 'imagen-4',
              name: 'Imagen 4',
              provider: 'Google',
              description: 'Image generation model.',
              modality: 'image',
              supportedParameters: [],
              contextLength: 0,
              pricing: { perImage: '40000000', dearestPerImage: '40000000' },
            },
          ],
          premiumIds: new Set<string>(),
        };
        mockUseResolveBilling.mockReturnValue({ fundingSource: 'personal_balance' });
        // A media row prices no text budget, so the composer's answer share reads zero.
        mockUseBudgetCalculation.mockReturnValue({
          ...baseBudgetResult,
          maxOutputTokens: 0,
          maxAnswerTokens: 0,
          isPriced: false,
        });

        const { result } = renderHook(() => usePromptBudget(defaultInput));

        expect(result.current.notifications.map((notice) => notice.id)).not.toContain(
          'answer_may_be_shortened'
        );
      }
    );
  });

  describe('reasoning effort pricing', () => {
    // Budget-native reasoning model (no effort vocabulary): the shared plan
    // prices every level at its clamped token-budget tier.
    beforeEach(() => {
      mockModelsData.current = {
        models: [
          {
            id: 'test-model',
            name: 'Test Model',
            provider: 'Fictional',
            description: 'Text generation model.',
            modality: 'text',
            supportedParameters: [],
            contextLength: 128_000,
            pricing: { inputPerToken: '10000', outputPerToken: '30000' },
            reasoning: {},
          },
        ],
        premiumIds: new Set<string>(),
      };
    });

    afterEach(() => {
      mockSelectedModels.current = [{ id: 'test-model', name: 'Test Model' }];
      mockModelsData.current = {
        models: [
          {
            id: 'test-model',
            name: 'Test Model',
            provider: 'Fictional',
            description: 'Text generation model.',
            modality: 'text',
            supportedParameters: [],
            contextLength: 128_000,
            pricing: { inputPerToken: '10000', outputPerToken: '30000' },
          },
        ],
        premiumIds: new Set<string>(),
      };
    });

    const budgetCallInput = (): Record<string, unknown> =>
      mockUseBudgetCalculation.mock.calls.at(-1)![0] as Record<string, unknown>;

    it("feeds the shared plan's budget for 'high' into the budget calculation", () => {
      renderHook(() => usePromptBudget({ ...defaultInput, reasoningEffort: 'high' }));

      expect(budgetCallInput()['reasoningBudgetTokens']).toBe(plannedBudget('high'));
    });

    it("feeds a strictly smaller budget for 'low' than for 'high'", () => {
      renderHook(() => usePromptBudget({ ...defaultInput, reasoningEffort: 'low' }));

      expect(budgetCallInput()['reasoningBudgetTokens']).toBe(plannedBudget('low'));
      expect(plannedBudget('low')).toBeLessThan(plannedBudget('high'));
    });

    it("omits the reasoning budget for 'off' (hard off prices reasoning-free)", () => {
      renderHook(() => usePromptBudget({ ...defaultInput, reasoningEffort: 'off' }));

      expect(budgetCallInput()).not.toHaveProperty('reasoningBudgetTokens');
    });

    it('omits the reasoning budget when the selection is absent', () => {
      renderHook(() => usePromptBudget(defaultInput));

      expect(budgetCallInput()).not.toHaveProperty('reasoningBudgetTokens');
    });

    it("omits the reasoning budget for 'auto'", () => {
      // Auto's placeholder reserve is resolved server-side; the display
      // estimate does not mirror it (see the hook's doc comment).
      renderHook(() => usePromptBudget({ ...defaultInput, reasoningEffort: 'auto' }));

      expect(budgetCallInput()).not.toHaveProperty('reasoningBudgetTokens');
    });

    it('uses the largest per-model budget across a multi-model selection', () => {
      mockSelectedModels.current = [
        { id: 'test-model', name: 'Test Model' },
        { id: 'plain-model', name: 'Plain Model' },
      ];
      mockModelsData.current = {
        models: [
          {
            id: 'test-model',
            name: 'Test Model',
            provider: 'Fictional',
            description: 'Text generation model.',
            modality: 'text',
            supportedParameters: [],
            contextLength: 128_000,
            pricing: { inputPerToken: '10000', outputPerToken: '30000' },
            reasoning: {},
          },
          {
            id: 'plain-model',
            name: 'Plain Model',
            provider: 'Fictional',
            description: 'Text generation model.',
            modality: 'text',
            supportedParameters: [],
            contextLength: 128_000,
            pricing: { inputPerToken: '10000', outputPerToken: '30000' },
          },
        ],
        premiumIds: new Set<string>(),
      };

      renderHook(() => usePromptBudget({ ...defaultInput, reasoningEffort: 'medium' }));

      expect(budgetCallInput()['reasoningBudgetTokens']).toBe(plannedBudget('medium'));
    });

    it('omits the reasoning budget when no selected model offers the level', () => {
      mockModelsData.current = {
        models: [
          {
            id: 'test-model',
            name: 'Test Model',
            provider: 'Fictional',
            description: 'Text generation model.',
            modality: 'text',
            supportedParameters: [],
            contextLength: 128_000,
            pricing: { inputPerToken: '10000', outputPerToken: '30000' },
            // Single enumerated level → the positional ladder offers only High.
            reasoning: { supportedEfforts: ['high'] },
          },
        ],
        premiumIds: new Set<string>(),
      };

      renderHook(() => usePromptBudget({ ...defaultInput, reasoningEffort: 'low' }));

      expect(budgetCallInput()).not.toHaveProperty('reasoningBudgetTokens');
    });
  });

  describe('Smart Model affordability', () => {
    // A priceable text model the shared gate can pool, plus the synthetic Smart
    // Model row (excluded from the pool). The gate prices Smart Model at the
    // classifier reserve + cheapest floor — NOT the $0-tracking headline-min the
    // catalog exposes — so client and server refuse the same $0 sends.

    function withSmartModelSelected(): void {
      mockSelectedModels.current = [{ id: SMART_MODEL_ID, name: 'Smart Model' }];
      mockModelsData.current = {
        models: [
          {
            id: SMART_MODEL_ID,
            name: 'Smart Model',
            provider: 'HushBox',
            description: 'Text generation model.',
            modality: 'text',
            supportedParameters: [],
            isSmartModel: true,
            contextLength: 128_000,
            // The catalog exposes the cheapest pool rate as headline pricing.
            pricing: { inputPerToken: '10000', outputPerToken: '30000' },
          },
          {
            id: 'cheap/text',
            name: 'Cheap Text',
            provider: 'Fictional',
            description: 'Text generation model.',
            modality: 'text',
            supportedParameters: [],
            contextLength: 128_000,
            pricing: { inputPerToken: '10000', outputPerToken: '30000' },
          },
        ],
        premiumIds: new Set<string>(),
      };
    }

    it('hands the budget core the Smart Model row, which marks the slot that cannot carry the search tool', () => {
      // The catalog serves the slot as a priced row, so the budget core would
      // otherwise reserve web search for an answer that structurally cannot run
      // the tool, and the composer would quote a price the send never costs.
      withSmartModelSelected();
      mockSelectedModels.current = [
        { id: SMART_MODEL_ID, name: 'Smart Model' },
        { id: 'cheap/text', name: 'Cheap' },
      ];

      renderHook(() => usePromptBudget(defaultInput));

      const budgetInput = mockUseBudgetCalculation.mock.calls[0]![0] as {
        models?: readonly { isSmartModel?: boolean }[];
      };
      expect(budgetInput.models?.map((row) => row.isSmartModel === true)).toEqual([true, false]);
    });

    it('sizes the turn through the budget core scoped to that same conversation', () => {
      withSmartModelSelected();
      renderHook(() =>
        usePromptBudget({
          ...defaultInput,
          conversationId: 'conv-1',
          currentUserPrivilege: 'write',
        })
      );

      expect(mockUseBudgetCalculation).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'conv-1' })
      );
    });
  });

  describe('usePromptBudget — the hold-versus-balance pair', () => {
    beforeEach(() => {
      mockUseTurnOptions.mockReturnValue(pair(true, true));
    });

    it('a HOLD blocks the send with the wait reason, distinct from a money refusal', () => {
      // Funds are actually held. That — not the gap between the two sets — is
      // what makes this a hold: paying would not help, so the notice must not
      // offer it, and waiting is the action that becomes true.
      mockUseTurnOptions.mockReturnValue(
        pair(true, false, { refusal: 'insufficient_funds', heldNanoUsd: 40_000_000n })
      );

      const { result } = renderHook(() => usePromptBudget(defaultInput));

      expect(result.current.sendRefusal).toBe('funds_held_by_run');
      expect(result.current.hasBlockingError).toBe(true);
    });

    it('a zero-hold PROMPT_TOO_LONG renders the length reason, never the hold reason', () => {
      // The two sets differ in TWO inputs — funding AND basis — so the middle
      // state is NOT necessarily a hold. A long history alone puts the turn
      // outside `admissible` while `affordable` (empty basis) still sends.
      // Telling that user to wait for a reply that is not running is a false
      // action: their fix is to shorten the message.
      mockUseTurnOptions.mockReturnValue(pair(true, false, { refusal: 'prompt_too_long' }));

      const { result } = renderHook(() => usePromptBudget(defaultInput));

      expect(result.current.sendRefusal).toBe('prompt_too_long');
    });

    it('does NOT gate a media turn on the TOKEN producer, which declines to price it', () => {
      // `turn-core.ts` returns `modality_not_priceable` for every non-text
      // modality, so consuming the token `admissible` here would impose a
      // refusal that says only "this is not a token turn" — and `PromptInput`
      // is the media composer, so it disabled image and video generation
      // outright. The per-unit producer answers this arm, and it sends here.
      mockActiveModality.current = 'image';
      mockUseMediaTurnOptions.mockReturnValue(mediaPair(true));
      mockUseTurnOptions.mockReturnValue(pair(false, false, { refusal: 'modality_not_priceable' }));

      const { result } = renderHook(() => usePromptBudget(defaultInput));

      expect(result.current.sendRefusal).toBeUndefined();
      expect(result.current.hasBlockingError).toBe(false);
    });

    it('still gates a TEXT turn on `admissible`', () => {
      // The other half of the same rule: narrowing to text must not weaken text.
      mockActiveModality.current = 'text';
      mockUseTurnOptions.mockReturnValue(pair(false, false, { refusal: 'insufficient_funds' }));

      const { result } = renderHook(() => usePromptBudget(defaultInput));

      expect(result.current.sendRefusal).toBe('insufficient_funds');
      expect(result.current.hasBlockingError).toBe(true);
    });

    it("an OWNER-funded turn says the owner pays, never the member's own allowance", () => {
      // Before the served payer was consulted, a member in an owner-funded
      // conversation read "This message uses your free daily allowance" — while
      // the owner's budget paid and they were charged nothing at all.
      mockActiveModality.current = 'text';
      mockUseTurnOptions.mockReturnValue(
        pair(true, true, { refusal: 'insufficient_funds', heldNanoUsd: 0n, payer: 'owner' })
      );
      mockUseConversationBudgets.mockReturnValue({
        data: { members: [{ capNanoUsd: '1000000000000' }] },
        isPending: false,
      });

      const { result } = renderHook(() =>
        usePromptBudget({
          ...defaultInput,
          conversationId: 'conv-1',
          currentUserPrivilege: 'write',
        })
      );

      expect(result.current.fundingSource).toBe('owner_balance');
      expect(result.current.notifications.map((n) => n.id)).toContain('group_budget_pays');
      expect(result.current.notifications.map((n) => n.id)).not.toContain('free_allowance_pays');
    });

    it('an owner-funded turn is NOT blocked by the premium lock on the member own wallet', () => {
      // §Funding Decision Matrix priority 1: "Conversation owner pays, PREMIUM
      // ALLOWED." The premise is taken from the REAL resolver rather than
      // invented — a free-tier member selecting a premium model genuinely
      // resolves to a denial when only their own wallet is considered.
      const selfOnly = resolveClientBilling({
        tier: 'free',
        purchasedBalanceNanoUsd: 0n,
        spendableNanoUsd: 0n,
        isPremiumModel: true,
        estimatedMinimumCostNanoUsd: 0n,
      });
      expect(selfOnly.fundingSource).toBe('denied');

      // That exact denial must not survive the server saying the owner pays:
      // the premium lock is a statement about the SELF wallet and does not
      // apply when it is not the wallet paying. The picker on the same screen
      // already marks the row available, because the served tier is the
      // owner's.
      mockActiveModality.current = 'text';
      mockUseResolveBilling.mockReturnValue(selfOnly);
      mockUseTurnOptions.mockReturnValue(pair(true, true, { payer: 'owner' }));
      mockUseConversationBudgets.mockReturnValue({
        data: { members: [{ capNanoUsd: '1000000000000' }] },
        isPending: false,
      });

      const { result } = renderHook(() =>
        usePromptBudget({
          ...defaultInput,
          conversationId: 'conv-1',
          currentUserPrivilege: 'write',
        })
      );

      expect(result.current.fundingSource).toBe('owner_balance');
      expect(result.current.hasBlockingError).toBe(false);
    });

    it('an owner-funded turn is NOT blocked by a negative balance on the member own wallet', () => {
      // Same shape, the other denial arm: `client-billing.ts` guards the
      // caller's own balance, which is the wrong wallet entirely when the
      // owner pays.
      const selfOnly = resolveClientBilling({
        tier: 'paid',
        purchasedBalanceNanoUsd: -1_000_000_000n,
        spendableNanoUsd: -1_000_000_000n,
        isPremiumModel: false,
        estimatedMinimumCostNanoUsd: 10_000_000n,
      });
      expect(selfOnly.fundingSource).toBe('denied');

      mockActiveModality.current = 'text';
      mockUseResolveBilling.mockReturnValue(selfOnly);
      mockUseTurnOptions.mockReturnValue(pair(true, true, { payer: 'owner' }));
      mockUseConversationBudgets.mockReturnValue({
        data: { members: [{ capNanoUsd: '1000000000000' }] },
        isPending: false,
      });

      const { result } = renderHook(() =>
        usePromptBudget({
          ...defaultInput,
          conversationId: 'conv-1',
          currentUserPrivilege: 'write',
        })
      );

      expect(result.current.fundingSource).toBe('owner_balance');
      expect(result.current.hasBlockingError).toBe(false);
    });

    it('discloses the payer switch when the server funds a group turn from the member', () => {
      // §Notices 5: switching who pays is not a detail to discover from a
      // balance later. The server said `self` on a GROUP conversation — that is
      // the fall-through, and it must be disclosed before sending.
      mockActiveModality.current = 'text';
      mockUseTurnOptions.mockReturnValue(
        pair(true, true, { refusal: 'insufficient_funds', heldNanoUsd: 0n, payer: 'self' })
      );
      mockUseConversationBudgets.mockReturnValue({
        data: { members: [{ capNanoUsd: '1000000000000' }] },
        isPending: false,
      });

      const { result } = renderHook(() =>
        usePromptBudget({
          ...defaultInput,
          conversationId: 'conv-1',
          currentUserPrivilege: 'write',
        })
      );

      expect(result.current.notifications.map((n) => n.id)).toContain('payer_switched_to_personal');
    });

    it('publishes the payer switch as a value, not only as a sentence', () => {
      // The queue has to compare the payer it was accepted under against the one
      // resolved when it finally sends, and reading that out of a rendered
      // notice list would make the comparison depend on the wording.
      mockActiveModality.current = 'text';
      mockUseTurnOptions.mockReturnValue(
        pair(true, true, { refusal: 'insufficient_funds', heldNanoUsd: 0n, payer: 'self' })
      );
      mockUseConversationBudgets.mockReturnValue({
        data: { members: [{ capNanoUsd: '1000000000000' }] },
        isPending: false,
      });

      const { result } = renderHook(() =>
        usePromptBudget({
          ...defaultInput,
          conversationId: 'conv-1',
          currentUserPrivilege: 'write',
        })
      );

      expect(result.current.payerSwitch).toBe('group_headroom_insufficient');
    });

    it('publishes no payer switch when the owner funds the turn', () => {
      mockActiveModality.current = 'text';
      mockUseTurnOptions.mockReturnValue(pair(true, true, { heldNanoUsd: 0n, payer: 'owner' }));
      mockUseConversationBudgets.mockReturnValue({
        data: { members: [{ capNanoUsd: '1000000000000' }] },
        isPending: false,
      });

      const { result } = renderHook(() =>
        usePromptBudget({
          ...defaultInput,
          conversationId: 'conv-1',
          currentUserPrivilege: 'write',
        })
      );

      expect(result.current.payerSwitch).toBeUndefined();
    });

    it('discloses NOTHING about payers on a solo conversation', () => {
      // Self-funding alone is not a switch; only a group turn that fell through
      // is. A solo composer must not be told its payer changed.
      mockActiveModality.current = 'text';
      mockUseTurnOptions.mockReturnValue(
        pair(true, true, { refusal: 'insufficient_funds', heldNanoUsd: 0n, payer: 'self' })
      );

      const { result } = renderHook(() => usePromptBudget(defaultInput));

      expect(result.current.notifications.map((n) => n.id)).not.toContain(
        'payer_switched_to_personal'
      );
    });

    it('CASE C: low balance + long history, nothing held → LENGTH, never the hold wording', () => {
      // The case that shipped twice. A free user's whole daily allowance is 5¢
      // (FREE_ALLOWANCE_CENTS_VALUE), so `insufficient_funds` with a long history
      // and `heldNanoUsd = 0` is an ordinary free-tier state, not a corner.
      // `affordable` sends because it is evaluated against the EMPTY basis — that
      // says nothing about a hold. Telling this user to wait is a false action:
      // nothing is running and waiting never helps. §Notices 4 routes it to
      // length, because the funding covers a minimum answer and the prompt is
      // what makes the turn infeasible.
      mockUseTurnOptions.mockReturnValue(
        pair(true, false, { refusal: 'insufficient_funds', heldNanoUsd: 0n })
      );

      const { result } = renderHook(() => usePromptBudget(defaultInput));

      expect(result.current.sendRefusal).toBe('prompt_too_long');
    });

    it('CASE D: the same refusal WITH funds actually held → the hold wording', () => {
      mockUseTurnOptions.mockReturnValue(
        pair(true, false, { refusal: 'insufficient_funds', heldNanoUsd: 100_000_000_000n })
      );

      const { result } = renderHook(() => usePromptBudget(defaultInput));

      expect(result.current.sendRefusal).toBe('funds_held_by_run');
    });

    it('a BALANCE shortfall names money, not waiting', () => {
      // Outside both sets — the picker greys too, and the action is to pay.
      mockUseTurnOptions.mockReturnValue(pair(false, false));

      const { result } = renderHook(() => usePromptBudget(defaultInput));

      expect(result.current.sendRefusal).toBe('insufficient_funds');
    });

    it('the two reasons render DIFFERENT copy, so one condition never borrows the other', () => {
      expect(noticeText('funds_held_by_run')).not.toBe(noticeText('insufficient_funds'));
      // The hold's action is waiting; offering payment for a hold is a false path.
      expect(noticeText('funds_held_by_run')).toContain('Wait');
      expect(noticeText('insufficient_funds')).toContain('Add credit');
    });

    it('a sendable turn carries no refusal', () => {
      const { result } = renderHook(() => usePromptBudget(defaultInput));

      expect(result.current.sendRefusal).toBeUndefined();
    });
  });

  describe('the composer notice stack', () => {
    const lowBalanceBudget: BudgetCalculationResult = {
      ...baseBudgetResult,
      maxAnswerTokens: LOW_BALANCE_OUTPUT_TOKEN_THRESHOLD - 1,
    };

    it('shows the money refusal alone when a low balance would also warn of a shortened answer', () => {
      mockUseResolveBilling.mockReturnValue({ fundingSource: 'personal_balance' });
      mockUseBudgetCalculation.mockReturnValue(lowBalanceBudget);
      mockUseTurnOptions.mockReturnValue(pair(false, false, { refusal: 'insufficient_funds' }));

      const { result } = renderHook(() => usePromptBudget(defaultInput));

      expect(result.current.notifications.map((notice) => notice.id)).toEqual([
        'answer_may_be_shortened',
      ]);
      expect(result.current.notices.map((notice) => notice.id)).toEqual(['insufficient_funds']);
    });

    it('keeps the too-long refusal and its copy with no warning beside it', () => {
      mockUseResolveBilling.mockReturnValue({ fundingSource: 'personal_balance' });
      mockUseBudgetCalculation.mockReturnValue({ ...lowBalanceBudget, capacityPercent: 18 });
      mockUseTurnOptions.mockReturnValue(
        pair(true, false, { refusal: 'insufficient_funds', heldNanoUsd: 0n })
      );

      const { result } = renderHook(() => usePromptBudget(defaultInput));

      expect(result.current.notices.map((notice) => notice.id)).toEqual(['prompt_too_long']);
      expect(result.current.notices[0]?.message).toBe(noticeText('prompt_too_long'));
    });

    describe('a signed-in payer whose balance is below zero', () => {
      const overdrawnNanoUsd = -2_500_000_000n;

      /** The verdict the real resolver gives this payer, never one written by hand. */
      function overdrawnVerdict(isPremiumModel: boolean): ResolveBillingResult {
        return resolveClientBilling({
          tier: 'free',
          purchasedBalanceNanoUsd: overdrawnNanoUsd,
          spendableNanoUsd: 0n,
          isPremiumModel,
          estimatedMinimumCostNanoUsd: 10_000_000n,
        });
      }

      beforeEach(() => {
        mockTierInfo.current = {
          tier: 'free',
          purchasedBalanceNanoUsd: overdrawnNanoUsd,
          freeAllowanceNanoUsd: 0n,
        };
      });

      it('shows the negative balance as the one blocking notice on a premium model', () => {
        mockModelsData.current = {
          ...mockModelsData.current,
          premiumIds: new Set<string>(['test-model']),
        };
        mockUseResolveBilling.mockReturnValue(overdrawnVerdict(true));
        mockUseTurnOptions.mockReturnValue(
          pair(false, false, { refusal: 'premium_requires_credit' })
        );

        const { result } = renderHook(() => usePromptBudget(defaultInput));

        const errors = result.current.notices.filter((notice) => notice.type === 'error');
        expect(errors.map((notice) => notice.id)).toEqual(['balance_negative']);
        expect(result.current.hasBlockingError).toBe(true);
      });

      it('shows the negative balance as the one blocking notice on a basic model', () => {
        mockUseResolveBilling.mockReturnValue(overdrawnVerdict(false));

        const { result } = renderHook(() => usePromptBudget(defaultInput));

        const errors = result.current.notices.filter((notice) => notice.type === 'error');
        expect(errors.map((notice) => notice.id)).toEqual(['balance_negative']);
        expect(result.current.hasBlockingError).toBe(true);
      });
    });
  });

  describe('which blocks outlast the reply in flight', () => {
    // Quantified over the refusal vocabulary rather than over examples of it,
    // and the expectation is READ FROM the declaration: a code added tomorrow
    // is covered on the day it is added, and a code reclassified tomorrow moves
    // this test with it instead of leaving it asserting the old answer.
    it('reads persistence off the declaration for every refusal the turn arithmetic can produce', () => {
      for (const refusal of REFUSAL_CODES) {
        mockUseTurnOptions.mockReturnValue(pair(false, false, { refusal }));

        const { result } = renderHook(() => usePromptBudget(defaultInput));

        expect(result.current.sendRefusal).toBe(refusal);
        expect(result.current.hasBlockingError).toBe(true);
        expect(result.current.hasPersistentBlockingError).toBe(!isTransientBlock(refusal));
      }
    });

    it('leaves a held-funds block non-persistent, because the run holding the funds ends on its own', () => {
      mockUseTurnOptions.mockReturnValue(
        pair(true, false, { refusal: 'insufficient_funds', heldNanoUsd: 40_000_000n })
      );

      const { result } = renderHook(() => usePromptBudget(defaultInput));

      expect(result.current.sendRefusal).toBe('funds_held_by_run');
      expect(isTransientBlock('funds_held_by_run')).toBe(true);
      expect(result.current.hasBlockingError).toBe(true);
      expect(result.current.hasPersistentBlockingError).toBe(false);
    });

    it('reads an exhausted funding read off its declaration, which leaves its block non-persistent', () => {
      mockUseTurnOptions.mockReturnValue(fundingUnavailable());

      const { result } = renderHook(() => usePromptBudget(defaultInput));

      expect(result.current.sendRefusal).toBe('send_check_unavailable');
      expect(isTransientBlock('send_check_unavailable')).toBe(true);
      expect(result.current.hasBlockingError).toBe(true);
      expect(result.current.hasPersistentBlockingError).toBe(false);
    });

    // The queue exists for the window a reply is in flight, and a funding read
    // is in flight for part of that same window. A load is the ABSENCE of an
    // answer, not a refusing one: it blocks the send because nothing may be
    // spent on an unread figure, and it ends on the next read with nothing asked
    // of the user.
    it('leaves a read still in flight non-persistent, because it ends without the user', () => {
      mockUseTurnOptions.mockReturnValue(readStillInFlight());

      const { result } = renderHook(() => usePromptBudget(defaultInput));

      expect(result.current.sendRefusal).toBeUndefined();
      expect(result.current.hasBlockingError).toBe(true);
      expect(result.current.hasPersistentBlockingError).toBe(false);
    });

    it('leaves a group budget still loading non-persistent for a member', () => {
      mockUseConversationBudgets.mockReturnValue({ data: undefined, isPending: true });

      const { result } = renderHook(() =>
        usePromptBudget({
          ...defaultInput,
          conversationId: 'conv-1',
          currentUserPrivilege: 'write',
        })
      );

      expect(result.current.hasBlockingError).toBe(true);
      expect(result.current.hasPersistentBlockingError).toBe(false);
    });

    // The other half of the split above, and the reason it is a split rather
    // than a blanket transient default: these two blocks are ANSWERS about the
    // turn, they name no refusal to read a declaration off, and no reply
    // finishing changes either.
    it('keeps a denial persistent, because no reply finishing reopens the funding door', () => {
      mockUseResolveBilling.mockReturnValue({
        fundingSource: 'denied',
        reason: 'insufficient_balance',
      });

      const { result } = renderHook(() => usePromptBudget(defaultInput));

      expect(result.current.sendRefusal).toBeUndefined();
      expect(result.current.hasPersistentBlockingError).toBe(true);
    });

    it('keeps an over-capacity prompt persistent, because only the user can shorten it', () => {
      mockUseBudgetCalculation.mockReturnValue({ ...baseBudgetResult, capacityPercent: 150 });

      const { result } = renderHook(() => usePromptBudget(defaultInput));

      expect(result.current.sendRefusal).toBeUndefined();
      expect(result.current.hasPersistentBlockingError).toBe(true);
    });

    it('reports no persistent block when nothing blocks the send', () => {
      const { result } = renderHook(() => usePromptBudget(defaultInput));

      expect(result.current.hasBlockingError).toBe(false);
      expect(result.current.hasPersistentBlockingError).toBe(false);
    });
  });

  describe('the media turn the composer is holding', () => {
    afterEach(() => {
      mockActiveModality.current = 'text';
      mockImageSelections.current = [];
    });

    function composeImageTurn(): void {
      mockActiveModality.current = 'image';
      mockImageSelections.current = [{ id: 'image-model', name: 'Image Model' }];
    }

    it("prices the media pair on the composer's real basis, never the empty one", () => {
      // The producer substitutes the empty basis for the `affordable` set
      // itself. A caller that passes one drops the input-storage leg from the
      // SEND gate, in the permissive direction, and nothing throws.
      composeImageTurn();

      renderHook(() => usePromptBudget({ value: 'a media prompt', historyCharacters: 120 }));

      const basis = (
        mockUseMediaTurnOptions.mock.calls[0]?.[0] as {
          basis: { inputChars: number; systemChars: number };
        }
      ).basis;
      expect(basis.inputChars).toBe('a media prompt'.length);
      expect(basis).toEqual(
        expect.objectContaining({ historyChars: 120, systemChars: expect.any(Number) })
      );
      expect(basis.systemChars).toBeGreaterThan(0);
    });

    it('obtains no funding verdict while no media model is selected', () => {
      // The dangerous half of the same state. A zero estimate is not a cheap
      // turn: the funding core clears any minimum at or below headroom, so a
      // payer with funds would read as FUNDED for a turn that cannot be priced.
      composeImageTurn();
      mockImageSelections.current = [];
      mockSpendable.current = {
        data: { spendableNanoUsd: '10000000000', heldNanoUsd: '0' },
        isPending: false,
      };

      renderHook(() => usePromptBudget(defaultInput));

      // The absence is what reaches the resolver; that the resolver answers
      // `no_verdict` for it — against the real funding core — is pinned in
      // `use-resolve-billing.test.ts`, where the core is not mocked.
      expect(mockUseResolveBilling).toHaveBeenCalledWith(
        expect.objectContaining({ estimatedMinimumCostNanoUsd: undefined })
      );
    });

    it('obtains no funding verdict for a media model the catalog prices no unit of', () => {
      // The catalog HAS the row, so the token-rate predicate passes and the turn
      // looks priceable — but the row carries no per-image rate. A missing media
      // rate turned into `0n` prices the turn at storage alone, which any
      // headroom clears, so the composer reads FUNDED for a turn nobody could
      // price while the send is refused elsewhere.
      mockActiveModality.current = 'image';
      mockImageSelections.current = [{ id: 'rateless/image', name: 'Rateless' }];
      const ratelessImage: Model = {
        id: 'rateless/image',
        name: 'Rateless',
        provider: 'Fictional',
        description: 'Image generation model.',
        modality: 'image',
        supportedParameters: [],
        contextLength: 0,
        pricing: {},
      };
      // Parsing the row pins the premise this guard rests on: the wire contract
      // refuses an image row carrying no per-image rate, so no endpoint can emit
      // one and the hook is being handed input only a bug could produce. Should
      // the contract ever admit such a row, this fails instead of the guard
      // quietly going idle.
      expect(modelSchema.safeParse(ratelessImage).success).toBe(false);
      mockModelsData.current = { models: [ratelessImage], premiumIds: new Set<string>() };
      mockSpendable.current = {
        data: { spendableNanoUsd: '10000000000', heldNanoUsd: '0' },
        isPending: false,
      };

      renderHook(() => usePromptBudget(defaultInput));

      expect(mockUseResolveBilling).toHaveBeenCalledWith(
        expect.objectContaining({ estimatedMinimumCostNanoUsd: undefined })
      );
    });

    it('obtains no funding verdict while the catalog has not delivered a selected model', () => {
      // The still-loading catalog used to substitute zero rates and a zero
      // context length for the missing row, which prices a storage-only minimum
      // — understated, and cleared by any headroom.
      mockActiveModality.current = 'image';
      mockImageSelections.current = [{ id: 'not-in-catalog', name: 'Absent' }];
      mockSpendable.current = {
        data: { spendableNanoUsd: '10000000000', heldNanoUsd: '0' },
        isPending: false,
      };

      renderHook(() => usePromptBudget(defaultInput));

      expect(mockUseResolveBilling).toHaveBeenCalledWith(
        expect.objectContaining({ estimatedMinimumCostNanoUsd: undefined })
      );
    });

    it('asks the money layer to price nothing while no media model is selected', () => {
      // The store defaults every media selection to empty, so this state is one
      // modality switch away — and the money layer REFUSES to price a turn with
      // no model, synchronously during render. Sending it an empty selection is
      // an error boundary, not a zero.
      mockActiveModality.current = 'image';
      mockImageSelections.current = [];

      const { result } = renderHook(() => usePromptBudget(defaultInput));

      expect(mockUseBudgetCalculation).toHaveBeenCalledWith(
        expect.objectContaining({ models: undefined })
      );
      expect(result.current.hasBlockingError).toBe(false);
    });

    it('hands the produced pair on for the panel to grey from', () => {
      composeImageTurn();

      const { result } = renderHook(() => usePromptBudget(defaultInput));

      expect(result.current.mediaOptions?.affordable.sendable).toBe(true);
    });

    it("refuses the send with the media producer's own refusal", () => {
      composeImageTurn();
      mockUseMediaTurnOptions.mockReturnValue(mediaPair(false, 'model_not_priceable'));

      const { result } = renderHook(() => usePromptBudget(defaultInput));

      expect(result.current.sendRefusal).toBe('model_not_priceable');
      expect(result.current.hasBlockingError).toBe(true);
    });

    it('refuses a media turn whose funding cannot cover it', () => {
      composeImageTurn();
      mockUseMediaTurnOptions.mockReturnValue(mediaPair(false));

      const { result } = renderHook(() => usePromptBudget(defaultInput));

      expect(result.current.sendRefusal).toBe('insufficient_funds');
    });

    it('refuses nothing while the media verdict has not arrived', () => {
      composeImageTurn();
      mockUseMediaTurnOptions.mockReturnValue(mediaPending());

      const { result } = renderHook(() => usePromptBudget(defaultInput));

      expect(result.current.sendRefusal).toBeUndefined();
    });

    it('leaves a text turn to the token producer', () => {
      // The adapter answers a text turn with no per-unit verdict at all (there
      // is no per-unit price for one), which is the state this arm must not
      // read a refusal out of.
      mockUseMediaTurnOptions.mockReturnValue({
        isPending: false,
        isFundingUnavailable: false,
        options: undefined,
      });

      const { result } = renderHook(() => usePromptBudget(defaultInput));

      expect(result.current.sendRefusal).toBeUndefined();
      expect(result.current.mediaOptions).toBeUndefined();
    });
  });
  describe('the effort pin and the graded set it produces', () => {
    /** A model with a real ladder, so an effort selection exists to pin. */
    function reasoningCatalog(): void {
      mockSelectedModels.current = [{ id: 'reasoner', name: 'Reasoner' }];
      mockModelsData.current = {
        models: [
          {
            id: 'reasoner',
            name: 'Reasoner',
            provider: 'Fictional',
            description: 'Text generation model.',
            modality: 'text',
            supportedParameters: [],
            contextLength: 128_000,
            maxOutputTokens: 64_000,
            reasoning: { supportedEfforts: ['low', 'medium', 'high'] },
            pricing: { inputPerToken: '10000', outputPerToken: '30000' },
          },
        ],
        premiumIds: new Set<string>(),
      };
    }

    /** The produced pair carrying a graded effort dimension. */
    function pairWithEffort(enabled: readonly string[], offered: readonly string[]): unknown {
      const set = {
        sendable: true,
        turnDimensions: [
          {
            dimensionId: 'effort',
            options: offered.map((optionId) => ({
              optionId,
              label: optionId,
              availability: enabled.includes(optionId)
                ? { available: true }
                : { available: false, reason: 'insufficient_funds' },
            })),
          },
        ],
      };
      return {
        isPending: false,
        heldNanoUsd: 0n,
        payerSpendableNanoUsd: 0n,
        payer: 'self',
        isFundingUnavailable: false,
        options: { affordable: set, admissible: set },
      };
    }

    it('hands the producer the effort the reasoning hook resolved', () => {
      reasoningCatalog();
      useReasoningEffortStore.setState({ preferredReasoningEffort: 'high' });

      renderHook(() => usePromptBudget(defaultInput));

      expect(mockUseTurnOptions).toHaveBeenCalledWith(expect.objectContaining({ effort: 'high' }));
    });

    /** The composer: this hook's verdict reaching the control that greys from it. */
    function Composer(): React.ReactElement {
      const budget = usePromptBudget({ ...defaultInput, conversationId: 'conv-payer' });
      return React.createElement(ReasoningEffortMenu, {
        effortDimension: budget.effortDimension,
      });
    }

    /** A gate: a live instance of the hook with no effort control under it. */
    function Gate(props: Readonly<{ conversationId?: string }>): React.ReactElement {
      usePromptBudget({ value: '', historyCharacters: 0, ...props });
      return React.createElement('span');
    }

    it('does not publish the graded set — a gate instance never writes the effort store', () => {
      reasoningCatalog();
      useReasoningEffortStore.setState({ preferredReasoningEffort: 'high' });
      mockUseTurnOptions.mockReturnValue(
        pairWithEffort(['low', 'medium'], ['low', 'medium', 'high'])
      );

      renderHook(() => usePromptBudget(defaultInput));

      expect(useReasoningEffortStore.getState().enabledEffortChoices).toBeUndefined();
    });

    it('leaves the store to the composer while gates at other scopes are mounted beside it', () => {
      // The shape that render-looped: the regenerate gate scopes to the FIRST
      // MESSAGE's conversation and omits the field entirely on an empty list,
      // so it grades a different wallet at scope `null` and holds a full
      // verdict against funds that are not the payer's. Two writers alternate
      // forever; one writer cannot.
      reasoningCatalog();
      useReasoningEffortStore.setState({ preferredReasoningEffort: 'high' });
      mockUseTurnOptions.mockImplementation((received: unknown) =>
        (received as { conversationId?: string | null }).conversationId === 'conv-payer'
          ? pairWithEffort(['low', 'medium'], ['low', 'medium', 'high'])
          : pairWithEffort(['low'], ['low', 'medium', 'high'])
      );

      render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(Composer, { key: 'composer' }),
          React.createElement(Gate, { key: 'regenerate' }),
          React.createElement(Gate, { key: 'drain', conversationId: 'conv-other' })
        )
      );

      expect(useReasoningEffortStore.getState().enabledEffortChoices).toEqual(['low', 'medium']);
    });

    it('settles: lowering the pin downstream of the greying does not move the greying', () => {
      // The pin feeds the producer and the producer's verdict lowers the pin.
      // That closes a loop, and it converges because the ONLY pin-sensitive
      // term is auto-vs-pinned, which moves monotonically: dropping the pin
      // opens the axis and buys the classifier reserve, so it can only ever
      // shrink the enabled set. This double reproduces exactly that asymmetry.
      reasoningCatalog();
      useReasoningEffortStore.setState({ preferredReasoningEffort: 'high' });
      mockUseTurnOptions.mockImplementation((received: unknown) => {
        const pin = (received as { effort?: string }).effort;
        const enabled = pin === undefined || pin === 'auto' ? ['low'] : ['low', 'medium'];
        return pairWithEffort(enabled, ['low', 'medium', 'high']);
      });

      render(React.createElement(Composer));

      expect(useReasoningEffortStore.getState().enabledEffortChoices).toEqual(['low', 'medium']);
      const settledPin = (mockUseTurnOptions.mock.calls.at(-1)![0] as { effort?: string }).effort;
      expect(settledPin).toBe('medium');
    });
  });
});
