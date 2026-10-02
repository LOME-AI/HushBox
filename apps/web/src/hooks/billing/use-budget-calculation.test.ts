import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  type GetBalanceResponse,
  LOW_BALANCE_OUTPUT_TOKEN_THRESHOLD,
  PREMIUM_RECENCY_MS,
  isOverContextCapacity,
  getTurnOptions,
  nanoUSD,
  poolModelFromWire,
} from '@hushbox/shared';
import { textTurnBudget } from '@hushbox/shared/affordability';
import { makeBalance } from '@/test-utils/balance-fixture';
import { useBudgetCalculation } from '@/hooks/billing/use-budget-calculation';
import * as billingHooks from '@/hooks/billing/billing';
import { useFundingRead, type FundingRead } from '@/hooks/billing/use-spendable';
import type { UseQueryResult } from '@tanstack/react-query';
import type { GetSpendableResponse, Model } from '@hushbox/shared';
import type { TextTurnBudget, TextTurnBudgetInput } from '@hushbox/shared/affordability';
import type { TurnOptions } from '@hushbox/shared';

const { mockLinkGuestKey } = vi.hoisted(() => ({
  mockLinkGuestKey: { current: null as string | null },
}));

vi.mock('@/hooks/billing/billing', () => ({
  useBalance: vi.fn(),
}));

// One controllable fact drives both the sender's tier and whether a funding
// door exists, exactly as production does — a guest credential is the only
// thing that makes an unauthenticated caller a payer's reader.
vi.mock('@/lib/auth/link-guest-auth', () => ({
  getLinkGuestAuth: () => mockLinkGuestKey.current,
}));

// The read's own classification is pinned in `use-spendable.test.ts`; here it
// is a double stating what is KNOWN about the payer's funding. The doorless
// arm mirrors the real rule rather than only its authenticated half, because a
// link guest inside a conversation has a door too and the gate under test is
// exactly what a door-holder without a snapshot must do.
vi.mock('@/hooks/billing/use-spendable', () => ({
  useFundingRead: vi.fn(),
}));

const mockUseBalance = vi.mocked(billingHooks.useBalance);
const mockUseFundingRead = vi.mocked(useFundingRead);

/** The trial: no funding door to read at all, so its absence is permanent and gates nothing. */
function noSpendable(): FundingRead {
  return { status: 'no-door', snapshot: undefined };
}

/** Served funding snapshot fixture, as GET /billing/spendable returns it. */
function makeSpendable(
  spendableNanoUsd: string,
  payer: GetSpendableResponse['payer'] = 'self',
  payerTier: GetSpendableResponse['payerTier'] = 'paid'
): FundingRead {
  return {
    status: 'served',
    snapshot: {
      spendableNanoUsd,
      heldNanoUsd: '0',
      payerTier,
      payer,
      ownerFundingLimit: payer === 'owner' ? 'member_allocation' : null,
    },
  };
}

/** A served text row at billable nano rates: $0.00001 input, $0.00003 output per token. */
const SERVED_ROW: Model = {
  id: 'vendor/base',
  name: 'Vendor Base',
  provider: 'vendor',
  modality: 'text',
  contextLength: 128_000,
  pricing: { inputPerToken: '10000', outputPerToken: '30000' },
  description: 'a text model',
  supportedParameters: [],
};

/**
 * The shared producer's answer for the same turn. The hook's job is to resolve
 * WHO pays and at what tier and then delegate; the arithmetic is pinned in the
 * producer's own suite, so the expectations here name the payer facts under
 * test and read the figure back from the one authority.
 */
function sharedBudget(overrides: Partial<TextTurnBudgetInput> = {}): TextTurnBudget {
  const budget = textTurnBudget({
    models: [SERVED_ROW],
    turnOptions: undefined,
    promptChars: 1000,
    inputChars: 1000,
    payerTier: 'paid',
    payerSpendableNanoUsd: 0n,
    webSearch: false,
    loopEffort: undefined,
    reasoningBudgetTokens: 0,
    ...overrides,
  });
  if (budget === undefined) throw new Error('expected the served row to price');
  return budget;
}

/** The shared producer's priced output figure for the same turn. */
function sharedOutputTokens(overrides: Partial<TextTurnBudgetInput> = {}): number {
  const tokens = sharedBudget(overrides).maxOutputTokens;
  if (tokens === undefined) throw new Error('expected a priced answer');
  return tokens;
}

describe('useBudgetCalculation', () => {
  const defaultInput = {
    promptCharacterCount: 1000,
    inputCharacterCount: 1000,
    models: [SERVED_ROW],
    turnOptions: undefined,
    isAuthenticated: true,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    mockUseBalance.mockReturnValue({
      data: makeBalance('10000000000', '5000000000'),
      isPending: false,
    } as UseQueryResult<GetBalanceResponse>);
    mockUseFundingRead.mockReturnValue(makeSpendable('10500000000'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mockLinkGuestKey.current = null;
  });

  describe('initial state', () => {
    it('returns math result before debounce completes', () => {
      const { result } = renderHook(() => useBudgetCalculation(defaultInput));

      expect(result.current.maxOutputTokens).toBeGreaterThan(0);
      expect(result.current.estimatedInputTokens).toBeGreaterThan(0);
      expect(result.current.capacityPercent).toBeGreaterThanOrEqual(0);
    });
  });

  describe('input estimation at every payer tier', () => {
    it('estimates a trial caller’s input at 3 characters per token', () => {
      // No endpoint exists for a trial caller, so no snapshot names a payer.
      mockUseFundingRead.mockReturnValue(noSpendable());

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

      // ceil(4000 / 3) = 1334 tokens
      expect(result.current.estimatedInputTokens).toBe(1334);
    });

    it('estimates a paid user’s input at 3 characters per token', () => {
      mockUseBalance.mockReturnValue({
        data: makeBalance('10000000000', '0'),
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

      // ceil(4000 / 3) = 1334 tokens
      expect(result.current.estimatedInputTokens).toBe(1334);
    });

    it('estimates a zero-balance user’s input at 3 characters per token', () => {
      mockUseBalance.mockReturnValue({
        data: makeBalance('0', '5000000000'),
        isPending: false,
      } as UseQueryResult<GetBalanceResponse>);
      mockUseFundingRead.mockReturnValue(makeSpendable('500000000', 'self', 'free'));

      const { result } = renderHook(() =>
        useBudgetCalculation({
          ...defaultInput,
          promptCharacterCount: 4000,
        })
      );

      act(() => {
        vi.advanceTimersByTime(200);
      });

      // ceil(4000 / 3) = 1334 tokens
      expect(result.current.estimatedInputTokens).toBe(1334);
    });
  });

  describe('synchronous tier flush', () => {
    it('synchronously updates result when balance data loads without waiting for debounce', () => {
      mockUseBalance.mockReturnValue({
        data: undefined,
        isPending: true,
      } as UseQueryResult<GetBalanceResponse>);
      mockUseFundingRead.mockReturnValue(noSpendable());

      const { result, rerender } = renderHook(() => useBudgetCalculation(defaultInput));

      // Initial: trial tier, low maxOutputTokens (the stale state that flashes).
      expect(result.current.maxOutputTokens).toBeLessThan(LOW_BALANCE_OUTPUT_TOKEN_THRESHOLD);

      mockUseBalance.mockReturnValue({
        data: makeBalance('10000000000', '5000000000'),
        isPending: false,
      } as UseQueryResult<GetBalanceResponse>);
      mockUseFundingRead.mockReturnValue(makeSpendable('10500000000'));

      // Rerender WITHOUT advancing timers — debounce has NOT fired.
      rerender();

      expect(result.current.maxOutputTokens).toBeGreaterThan(LOW_BALANCE_OUTPUT_TOKEN_THRESHOLD);
    });

    it('does not loop when the balance query returns a fresh data object every render', () => {
      mockUseBalance.mockImplementation(
        () =>
          ({
            data: makeBalance('10000000000', '5000000000'),
            isPending: false,
          }) as UseQueryResult<GetBalanceResponse>
      );

      const { rerender } = renderHook(() => useBudgetCalculation(defaultInput));

      expect(() => {
        rerender();
      }).not.toThrow();
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

      rerender({ count: 2000 });

      expect(result.current).toStrictEqual(initialResult);

      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(result.current.estimatedInputTokens).toBeGreaterThan(0);
    });

    it('still debounces when only promptCharacterCount changes', () => {
      const { result, rerender } = renderHook(
        ({ count }: { count: number }) =>
          useBudgetCalculation({
            ...defaultInput,
            promptCharacterCount: count,
          }),
        { initialProps: { count: 1000 } }
      );

      const initialTokens = result.current.estimatedInputTokens;

      rerender({ count: 5000 });

      expect(result.current.estimatedInputTokens).toBe(initialTokens);

      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(result.current.estimatedInputTokens).toBeGreaterThan(initialTokens);
    });
  });

  describe('budget calculation', () => {
    it('calculates input tokens based on character count', () => {
      mockUseBalance.mockReturnValue({
        data: makeBalance('10000000000', '0'),
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

      // ceil(4000 / 3) = 1334 tokens
      expect(result.current.estimatedInputTokens).toBe(1334);
    });

    it('prices storage over the new message it is handed, not the whole prompt', () => {
      mockUseBalance.mockReturnValue({
        data: makeBalance('10000000000', '0'),
        isPending: false,
      } as UseQueryResult<GetBalanceResponse>);

      const { result } = renderHook(() =>
        useBudgetCalculation({
          ...defaultInput,
          promptCharacterCount: 4000,
          inputCharacterCount: 400,
        })
      );

      act(() => {
        vi.advanceTimersByTime(200);
      });

      // The whole prompt still sets the input TOKENS, while storage prices the
      // message being composed — which is all the send will newly store.
      expect(result.current.estimatedInputTokens).toBe(1334);
      expect(result.current.maxOutputTokens).toBe(
        sharedBudget({ promptChars: 4000, inputChars: 400, payerSpendableNanoUsd: 10_500_000_000n })
          .maxOutputTokens
      );
      expect(result.current.maxOutputTokens).not.toBe(
        sharedBudget({
          promptChars: 4000,
          inputChars: 4000,
          payerSpendableNanoUsd: 10_500_000_000n,
        }).maxOutputTokens
      );
    });

    it('prices a searching turn’s loop at the rung it is handed', () => {
      const { result } = renderHook(() =>
        useBudgetCalculation({ ...defaultInput, webSearch: true, loopEffort: 'low' })
      );

      expect(result.current.maxOutputTokens).toBe(
        sharedBudget({ webSearch: true, loopEffort: 'low', payerSpendableNanoUsd: 10_500_000_000n })
          .maxOutputTokens
      );
      expect(result.current.maxOutputTokens).toBeGreaterThan(
        sharedOutputTokens({ webSearch: true, payerSpendableNanoUsd: 10_500_000_000n })
      );
    });

    it('returns positive maxOutputTokens when balance covers minimum cost', () => {
      mockUseBalance.mockReturnValue({
        data: makeBalance('10000000000', '0'),
        isPending: false,
      } as UseQueryResult<GetBalanceResponse>);

      const { result } = renderHook(() => useBudgetCalculation(defaultInput));

      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(result.current.maxOutputTokens).toBeGreaterThan(0);
    });

    it('returns zero maxOutputTokens when the served spendable is insufficient', () => {
      mockUseBalance.mockReturnValue({
        data: makeBalance('0', '0'),
        isPending: false,
      } as UseQueryResult<GetBalanceResponse>);
      // Free tier (zero balance): allowance 0 is the gate; spendable is unused.
      mockUseFundingRead.mockReturnValue(makeSpendable('500000000'));

      const { result } = renderHook(() =>
        useBudgetCalculation({
          ...defaultInput,
          promptCharacterCount: 100_000,
          models: [
            { ...SERVED_ROW, pricing: { inputPerToken: '1000000', outputPerToken: '30000' } },
          ],
        })
      );

      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(result.current.maxOutputTokens).toBe(0);
    });

    it('renders an unpriced composer when no model is selected, without pricing one', () => {
      // The money layer REFUSES to price a turn with no model (it throws), and
      // this hook runs synchronously during render — so asking it here is a
      // render crash, not a fallback. The composer has no turn to price yet,
      // which is a UI state rather than a money verdict of zero.
      const { result } = renderHook(() => useBudgetCalculation({ ...defaultInput, models: [] }));

      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(result.current.isPriced).toBe(false);
      expect(result.current.maxOutputTokens).toBe(0);
      expect(result.current.estimatedInputTokens).toBe(0);
      expect(result.current.currentUsage).toBe(0);
      expect(result.current.capacityPercent).toBe(0);
    });

    it('marks the absent-rates composer unpriced, so no figure of its can be compared', () => {
      // The catalog has not delivered a selected model's row. Zero rates would
      // size an answer for a turn nobody can price; the absence arrives as an
      // absence and carries `isPriced: false` out with it.
      const { result } = renderHook(() =>
        useBudgetCalculation({ ...defaultInput, models: undefined })
      );

      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(result.current.isPriced).toBe(false);
      expect(result.current.maxOutputTokens).toBe(0);
    });

    it('marks a composer whose selected row serves no price unpriced, rather than pricing it free', () => {
      const halfPriced: Model = { ...SERVED_ROW, pricing: { inputPerToken: '10000' } };
      const { result } = renderHook(() =>
        useBudgetCalculation({ ...defaultInput, models: [halfPriced] })
      );

      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(result.current.isPriced).toBe(false);
      expect(result.current.maxOutputTokens).toBe(0);
    });

    it('carries no price for an unpriced composer', () => {
      const { result } = renderHook(() => useBudgetCalculation({ ...defaultInput, models: [] }));

      expect(Object.keys(result.current).toSorted((a, b) => a.localeCompare(b))).toEqual([
        'capacityPercent',
        'currentUsage',
        'estimatedInputTokens',
        'isPriced',
        'maxAnswerTokens',
        'maxOutputTokens',
      ]);
    });

    it('reads the Smart slot’s figure from the turn options it is handed', () => {
      const smartRow: Model = { ...SERVED_ROW, id: 'smart-model', isSmartModel: true };
      const candidate: Model = { ...SERVED_ROW, id: 'vendor/candidate', created: 0 };
      const candidateModel = poolModelFromWire(candidate);
      if (candidateModel === undefined) throw new Error('expected the candidate to price');
      const turnOptions: TurnOptions = getTurnOptions(
        {
          spendableNanoUsd: nanoUSD(10_500_000_000n),
          heldNanoUsd: nanoUSD(0n),
          payerTier: 'paid',
          payer: 'self',
        },
        {
          systemChars: 0,
          instructionChars: 0,
          historyChars: 0,
          inputChars: 1000,
          attachmentBytes: 0,
        },
        {
          answerSources: { models: [], smartSlot: true },
          modality: 'text',
          pinned: {},
          webSearch: false,
        },
        // At the epoch's recency edge: no premium leg confounds the money verdict.
        { models: [candidateModel], nowMs: PREMIUM_RECENCY_MS }
      );

      const { result } = renderHook(() =>
        useBudgetCalculation({ ...defaultInput, models: [smartRow], turnOptions })
      );

      expect(result.current.maxOutputTokens).toBe(
        sharedBudget({ models: [smartRow], turnOptions }).maxOutputTokens
      );
    });

    describe('a Smart-slot composer whose turn options have not arrived', () => {
      /** A Smart row whose 1,000-token context the 4,000-character prompt overfills. */
      const smallSmartRow: Model = {
        ...SERVED_ROW,
        id: 'smart-model',
        isSmartModel: true,
        contextLength: 1000,
      };
      const overlong = {
        ...defaultInput,
        promptCharacterCount: 4000,
        inputCharacterCount: 4000,
        models: [smallSmartRow],
        turnOptions: undefined,
      };

      it('marks its answer unpriced', () => {
        const { result } = renderHook(() => useBudgetCalculation(overlong));

        expect(result.current.isPriced).toBe(false);
      });

      it('keeps its capacity, which does not wait on the turn producer', () => {
        const { result } = renderHook(() => useBudgetCalculation(overlong));

        expect(result.current.capacityPercent).toBe(
          sharedBudget({
            models: [smallSmartRow],
            promptChars: 4000,
            inputChars: 4000,
          }).capacityPercent
        );
      });

      it('reads as over capacity when its prompt overfills the context', () => {
        const { result } = renderHook(() => useBudgetCalculation(overlong));

        expect(isOverContextCapacity(result.current.capacityPercent)).toBe(true);
      });
    });

    it('marks a priced turn priced', () => {
      const { result } = renderHook(() => useBudgetCalculation(defaultInput));

      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(result.current.isPriced).toBe(true);
    });

    it('calculates capacity percentage correctly', () => {
      mockUseBalance.mockReturnValue({
        data: makeBalance('10000000000', '0'),
        isPending: false,
      } as UseQueryResult<GetBalanceResponse>);

      const { result } = renderHook(() =>
        useBudgetCalculation({
          ...defaultInput,
          promptCharacterCount: 4000,
          models: [{ ...defaultInput.models[0]!, contextLength: 10_000 }],
        })
      );

      act(() => {
        vi.advanceTimersByTime(200);
      });

      // currentUsage = capacityInputTokens (ceil(4000/3) = 1334) + MINIMUM_OUTPUT_TOKENS (1000)
      // capacityPercent = 2334 / 10000 * 100 = 23.34%
      expect(result.current.capacityPercent).toBe(23.34);
    });
  });

  describe("the payer's numbers, not the sender's (BILLING §Group Funding 1)", () => {
    /** A free-tier sender: zero purchased balance, zero daily allowance left. */
    function freeTierSender(): void {
      mockUseBalance.mockReturnValue({
        data: makeBalance('0', '0'),
        isPending: false,
      } as UseQueryResult<GetBalanceResponse>);
    }

    it('asks the served read for the payer of the conversation it composes in', () => {
      renderHook(() => useBudgetCalculation({ ...defaultInput, conversationId: 'conv-1' }));

      expect(mockUseFundingRead).toHaveBeenCalledWith(true, 'conv-1');
    });

    it('estimates an owner-funded turn’s input as the shared budget does', () => {
      freeTierSender();
      mockUseFundingRead.mockReturnValue(makeSpendable('4000000000', 'owner', 'paid'));

      const { result } = renderHook(() =>
        useBudgetCalculation({
          ...defaultInput,
          promptCharacterCount: 4000,
          conversationId: 'conv-1',
        })
      );

      act(() => {
        vi.advanceTimersByTime(200);
      });

      // One ratio serves every payer, so the owner's read and the sender's own
      // read estimate the same count.
      expect(result.current.estimatedInputTokens).toBe(
        sharedBudget({ payerTier: 'paid', promptChars: 4000 }).estimatedInputTokens
      );
    });

    it("solves affordability against the PAYER's remaining, not the sender's allowance", () => {
      freeTierSender();
      const servedSpendable = 4_000_000_000n;
      mockUseFundingRead.mockReturnValue(
        makeSpendable(servedSpendable.toString(), 'owner', 'paid')
      );

      const { result } = renderHook(() =>
        useBudgetCalculation({
          ...defaultInput,
          promptCharacterCount: 4000,
          conversationId: 'conv-1',
        })
      );

      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(result.current.maxOutputTokens).toBe(
        sharedBudget({
          payerTier: 'paid',
          promptChars: 4000,
          payerSpendableNanoUsd: servedSpendable,
        }).maxOutputTokens
      );
    });
  });

  describe('served spendable as THE paid affordability input', () => {
    it('gates paid affordability on the served spendable, not the raw balance', () => {
      // Raw balance $10 but served spendable 0 (e.g. holds ate it): affordability
      // must refuse — the client never re-derives spendable from the balance.
      mockUseBalance.mockReturnValue({
        data: makeBalance('10000000000', '0'),
        isPending: false,
      } as UseQueryResult<GetBalanceResponse>);
      mockUseFundingRead.mockReturnValue(makeSpendable('0'));

      const { result } = renderHook(() => useBudgetCalculation(defaultInput));

      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(result.current.maxOutputTokens).toBe(0);
    });

    it('funds exactly the served spendable — the baked cushion is never re-added', () => {
      // The served number already includes the $0.50 cushion exactly once.
      // Expected tokens = the shared affordability solve at EXACTLY the served
      // figure; a double-cushion bug would fund strictly more.
      mockUseBalance.mockReturnValue({
        data: makeBalance('1000000000', '0'),
        isPending: false,
      } as UseQueryResult<GetBalanceResponse>);
      const servedSpendable = 1_500_000_000n;
      mockUseFundingRead.mockReturnValue(makeSpendable(servedSpendable.toString()));

      const { result } = renderHook(() =>
        useBudgetCalculation({ ...defaultInput, promptCharacterCount: 4000 })
      );

      act(() => {
        vi.advanceTimersByTime(200);
      });

      const atServed = { promptChars: 4000, payerSpendableNanoUsd: servedSpendable };
      expect(result.current.maxOutputTokens).toBe(sharedBudget(atServed).maxOutputTokens);
      expect(
        sharedBudget({ ...atServed, payerSpendableNanoUsd: servedSpendable + 500_000_000n })
          .maxOutputTokens
      ).toBeGreaterThan(result.current.maxOutputTokens);
    });

    it('gates free-tier affordability on the served allowance', () => {
      // A depleted daily allowance refuses. The served figure IS the allowance
      // remaining for a free payer, so there is nothing else to consult.
      mockUseBalance.mockReturnValue({
        data: makeBalance('0', '0'),
        isPending: false,
      } as UseQueryResult<GetBalanceResponse>);
      mockUseFundingRead.mockReturnValue(makeSpendable('0', 'self', 'free'));

      const { result } = renderHook(() => useBudgetCalculation(defaultInput));

      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(result.current.maxOutputTokens).toBe(0);
    });

    it('sizes a free-tier turn on the HOLD-AWARE served allowance, not the balance endpoint', () => {
      // The two endpoints disagree by design while a run is in flight:
      // /billing/balance reports the day's allowance hold-blind (50¢), while
      // /billing/spendable subtracts the 40¢ this payer's own run reserved and
      // serves 10¢ — the figure admission gates on. Sizing from the hold-blind
      // number offers a longer answer than the payer can currently start.
      mockUseBalance.mockReturnValue({
        data: makeBalance('0', '500000000'),
        isPending: false,
      } as UseQueryResult<GetBalanceResponse>);
      mockUseFundingRead.mockReturnValue(makeSpendable('100000000', 'self', 'free'));

      const { result } = renderHook(() => useBudgetCalculation(defaultInput));

      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(result.current.maxOutputTokens).toBe(
        sharedBudget({ payerTier: 'free', payerSpendableNanoUsd: 100_000_000n }).maxOutputTokens
      );
    });

    it('keeps the client-side fixed arm for unauthenticated users (no endpoint exists)', () => {
      mockUseBalance.mockReturnValue({
        data: undefined,
        isPending: false,
      } as UseQueryResult<GetBalanceResponse>);
      mockUseFundingRead.mockReturnValue(noSpendable());

      const { result } = renderHook(() =>
        useBudgetCalculation({ ...defaultInput, isAuthenticated: false })
      );

      act(() => {
        vi.advanceTimersByTime(200);
      });

      // Exactly the shared trial fixed-1¢ solve — no served number involved.
      const expected = sharedBudget({ payerTier: 'trial' });
      expect(result.current.maxOutputTokens).toBe(expected.maxOutputTokens);
    });
  });

  describe('web search', () => {
    it('prices the web-search loop into the answer when webSearch is enabled', () => {
      const { result: withoutSearch } = renderHook(() =>
        useBudgetCalculation({ ...defaultInput, promptCharacterCount: 4000 })
      );
      const { result: withSearch } = renderHook(() =>
        useBudgetCalculation({ ...defaultInput, promptCharacterCount: 4000, webSearch: true })
      );

      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(withSearch.current.maxOutputTokens).toBe(
        sharedBudget({ promptChars: 4000, webSearch: true, payerSpendableNanoUsd: 10_500_000_000n })
          .maxOutputTokens
      );
      expect(withSearch.current.maxOutputTokens).toBeLessThan(
        withoutSearch.current.maxOutputTokens
      );
    });

    it('prices no web-search loop by default', () => {
      const { result } = renderHook(() =>
        useBudgetCalculation({ ...defaultInput, promptCharacterCount: 4000 })
      );

      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(result.current.maxOutputTokens).toBe(
        sharedBudget({ promptChars: 4000, payerSpendableNanoUsd: 10_500_000_000n }).maxOutputTokens
      );
    });
  });

  describe('reasoning budget', () => {
    const answerTokensFor = (reasoningBudgetTokens?: number): number => {
      const { result } = renderHook(() =>
        useBudgetCalculation({
          ...defaultInput,
          promptCharacterCount: 4000,
          ...(reasoningBudgetTokens !== undefined && { reasoningBudgetTokens }),
        })
      );
      act(() => {
        vi.advanceTimersByTime(200);
      });
      return result.current.maxAnswerTokens;
    };

    it('leaves a larger reasoning budget fewer answer tokens than a smaller one', () => {
      expect(answerTokensFor(8192)).toBeLessThan(answerTokensFor(2048));
    });

    it('takes exactly the reasoning budget out of the answer tokens', () => {
      expect(answerTokensFor(4096)).toBe(answerTokensFor() - 4096);
    });

    it('treats a zero reasoning budget identically to an absent one', () => {
      expect(answerTokensFor(0)).toBe(answerTokensFor());
    });
  });
});
