import * as React from 'react';
import { textTurnBudget } from '@hushbox/shared/affordability';

import { useUserTierInfo } from '@/hooks/billing/use-user-tier-info.js';
import { useFundingRead } from '@/hooks/billing/use-spendable.js';
import type { Model, ResolvedReasoningEffort, TurnOptions } from '@hushbox/shared';
import type { TextTurnBudget } from '@hushbox/shared/affordability';

const DEBOUNCE_MS = 150;

/**
 * What a composer with no budget at all displays: a meter at zero and no
 * answer size. These are display placeholders and nothing else — `isPriced:
 * false` rides beside them so no caller can mistake a placeholder for a priced
 * answer, and the funding path is handed an absence rather than any of these
 * numbers.
 *
 * The state exists because the money layer REFUSES to price a turn with no
 * model (`textTurnBudget` throws) and this hook runs it synchronously during
 * render: every media modality starts with an empty selection, so handing it one
 * is a render crash. A selected model the catalog has not delivered yet is the
 * same state, and so is a selected row that serves no price, for which the
 * producer answers no budget — pricing either at zero rates understates the turn
 * instead of refusing it.
 */
const UNPRICED_COMPOSER: Omit<BudgetCalculationResult, 'isPriced'> = {
  maxOutputTokens: 0,
  maxAnswerTokens: 0,
  estimatedInputTokens: 0,
  currentUsage: 0,
  capacityPercent: 0,
};

interface UseBudgetCalculationInput {
  /** Character count for: system prompt + history + current message */
  promptCharacterCount: number;
  /**
   * The current message on its own — the storage basis. The send stores one new
   * user message; the system prompt and the resent history rest nowhere new, so
   * pricing storage over the whole prompt understates the answer the payer's
   * funds buy and diverges from the send gate beside it.
   */
  inputCharacterCount: number;
  /**
   * The served rows of the selected models, or `undefined` when there is NO turn
   * to price — no model selected, or a selected model the catalog has not
   * delivered. Absence is passed as absence: substituting zero rates prices an
   * unpriceable turn as a cheap one.
   */
  models: readonly Model[] | undefined;
  /**
   * The turn producer's pair for the same selection, or `undefined` while it has
   * not answered. A selection with the Smart slot reads the slot's figure from
   * it, so such a composer is unpriced until it arrives.
   */
  turnOptions: TurnOptions | undefined;
  /** Whether the user is authenticated */
  isAuthenticated: boolean;
  /**
   * The conversation being composed in, which is what names the PAYER: an
   * owner-funded group turn is sized from the owner's funds at the owner's tier
   * (BILLING §Group Funding 1). Omit or null for a solo composer.
   */
  conversationId?: string | null;
  /** Whether the web-search tool is enabled (adds the core's worst-case reservation). */
  webSearch?: boolean;
  /**
   * The rung whose tool loop a searching turn prices: the one the turn producer
   * took its hold at. Absent prices the ceiling loop, the turn with no ladder.
   */
  loopEffort?: ResolvedReasoningEffort;
  /**
   * Reasoning token budget B from the shared reasoning plan (0/absent =
   * reasoning-free), taken out of the output-token pool before the answer's
   * share.
   */
  reasoningBudgetTokens?: number;
}

/**
 * Hook to calculate budget math in real-time with debouncing.
 *
 * Pure math only — no billing decisions or notifications. Billing decisions are
 * handled by `useResolveBilling()`; notifications by `generateNotifications()`.
 *
 * Computes the initial result synchronously to avoid a flash of empty state on
 * mount; subsequent updates are debounced to avoid excessive recalculation
 * during typing.
 */
export interface BudgetCalculationResult extends Omit<
  TextTurnBudget,
  'maxOutputTokens' | 'maxAnswerTokens'
> {
  readonly maxOutputTokens: number;
  readonly maxAnswerTokens: number;
  /**
   * False when there was no turn to price, no price to price it at, or a
   * Smart-slot answer still waiting on the turn producer. The answer figures are
   * then display placeholders: a zero answer size means no answer yet, not one
   * the funds cannot buy. A Smart-slot turn waiting on the producer keeps its
   * real capacity figures; every other unpriced composer shows the zero meter.
   */
  readonly isPriced: boolean;
}

/** What the composer shows for the budget `textTurnBudget` answered, or for none. */
function composerResult(budget: TextTurnBudget | undefined): BudgetCalculationResult {
  if (budget === undefined) return { ...UNPRICED_COMPOSER, isPriced: false };
  const { maxOutputTokens, maxAnswerTokens } = budget;
  if (maxOutputTokens === undefined || maxAnswerTokens === undefined) {
    return { ...budget, maxOutputTokens: 0, maxAnswerTokens: 0, isPriced: false };
  }
  return { ...budget, maxOutputTokens, maxAnswerTokens, isPriced: true };
}

export function useBudgetCalculation(input: UseBudgetCalculationInput): BudgetCalculationResult {
  const tierInfo = useUserTierInfo(input.isAuthenticated);
  // The payer's served funding snapshot — hold-aware spendable at the payer's
  // tier, exactly what admission gates on (BILLING §Affordability 1). The
  // client never re-derives either figure: not the balance (the cushion is
  // baked in once server-side) and not the payer's tier (the server resolves
  // who pays from fresh rows).
  const funding = useFundingRead(input.isAuthenticated, input.conversationId ?? null);

  const spendableNanoUsd = funding.snapshot ? BigInt(funding.snapshot.spendableNanoUsd) : 0n;
  // Only the trial holds no wallet and no funding door, so only it falls back
  // to the client-side arm; every served snapshot names the PAYER's tier, which
  // is what sizes an owner-funded turn — a group member's or a guest's alike.
  const payerTier = funding.snapshot?.payerTier ?? tierInfo.tier;

  const { models, turnOptions } = input;
  const computeResult = React.useCallback(
    (): TextTurnBudget | undefined =>
      models === undefined || models.length === 0
        ? undefined
        : textTurnBudget({
            models,
            turnOptions,
            promptChars: input.promptCharacterCount,
            inputChars: input.inputCharacterCount,
            payerTier,
            payerSpendableNanoUsd: spendableNanoUsd,
            webSearch: input.webSearch === true,
            loopEffort: input.loopEffort,
            reasoningBudgetTokens: input.reasoningBudgetTokens ?? 0,
          }),
    [
      models,
      turnOptions,
      input.promptCharacterCount,
      input.inputCharacterCount,
      input.webSearch,
      input.loopEffort,
      input.reasoningBudgetTokens,
      payerTier,
      spendableNanoUsd,
    ]
  );

  const [debouncedResult, setDebouncedResult] = React.useState<TextTurnBudget | undefined>(
    computeResult
  );

  // Synchronously flush when the tier's *values* change (e.g. balance loaded).
  // Compared by value, not by reference: the balance query can hand back a fresh
  // object with identical values on every render (access-revoked flows
  // repeatedly invalidate it), and a reference compare would setState every
  // render → "Maximum update depth exceeded".
  const tierKey = `${payerTier}:${spendableNanoUsd.toString()}`;
  const [previousTierKey, setPreviousTierKey] = React.useState(tierKey);
  if (previousTierKey !== tierKey) {
    setPreviousTierKey(tierKey);
    setDebouncedResult(computeResult());
  }

  React.useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedResult(computeResult());
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [computeResult]);

  return composerResult(debouncedResult);
}
