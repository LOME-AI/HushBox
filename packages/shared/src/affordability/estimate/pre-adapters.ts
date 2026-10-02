/**
 * Pre-adapters for the canonical estimator: the nano-USD cushion and
 * spendable-funds math that client and server both consult — the server's
 * admission gate and turn context read {@link spendableFundsNanoUsd}, as does the
 * shared funding decision — plus the effective-balance and prompt-capacity
 * readings the shared producers build the composer's figures on. They sit
 * outside the price core's cost curves, which price token counts at rates.
 */

import {
  MAX_ALLOWED_NEGATIVE_BALANCE_CENTS,
  MINIMUM_OUTPUT_TOKENS,
  TRIAL_MESSAGE_COST_CAP_NANO_USD,
} from '../constants.ts';
import { NANO_USD_PER_CENT } from '../money/nano-usd.ts';
import { getUserTier } from '../money/tiers.ts';
import { inputTokensOf } from '../price/quantities.ts';
import type { UserTier } from '../money/tiers.ts';

/**
 * The paid negative-balance cushion in nano-USD ($0.50), derived from the same
 * cents constant as the rest of the balance math so the two never drift.
 */
export const PAID_CUSHION_NANO_USD: bigint =
  BigInt(MAX_ALLOWED_NEGATIVE_BALANCE_CENTS) * NANO_USD_PER_CENT;

/**
 * The negative-balance cushion a PURCHASED balance carries, in nano-USD. It is
 * keyed on the balance rather than on a tier the caller derives: the tier IS a
 * function of the balance ({@link getUserTier}), and while callers derived it
 * themselves they disagreed — the wallet-type derivation granted a purchased
 * wallet the cushion at any balance, the balance derivation withheld it at zero,
 * and the same wallet was then worth $0.50 more on one path than the other.
 *
 * Only a purchased balance may be passed. A daily free allowance is a budget
 * scope, not a balance that may go negative, so it is never cushioned and never
 * reaches here.
 */
export function getCushionNano(purchasedBalanceNanoUsd: bigint): bigint {
  const { tier } = getUserTier({ purchasedBalanceNanoUsd, freeAllowanceNanoUsd: 0n });
  return tier === 'paid' ? PAID_CUSHION_NANO_USD : 0n;
}

/**
 * THE answer to "what can this wallet spend": a purchased balance plus the
 * cushion it carries. Every caller that needs the figure consults this one —
 * the group headroom's owner term, the send path's frozen payer funding, the
 * admission balance gate and the served figure — so no two of them can price
 * the same wallet differently.
 */
export function spendableFundsNanoUsd(purchasedBalanceNanoUsd: bigint): bigint {
  return purchasedBalanceNanoUsd + getCushionNano(purchasedBalanceNanoUsd);
}

/**
 * Effective balance the affordability reducer gates against, in nano-USD:
 *  - trial: a fixed per-message ceiling, because a trial session has no funding
 *    endpoint to read (§Affordability 8)
 *  - free: the daily free allowance only, no cushion
 *  - paid: the wallet balance plus the negative-balance cushion
 *
 * `guest` is excluded from the parameter by type, not by a branch: a link guest
 * HAS a funding door and is owner-funded, so its effective balance is the
 * payer's served figure and never this fixed ceiling. Passing one here is the
 * conflation the exclusion exists to make unwritable (§Funding, §User Tiers).
 */
export function getEffectiveBalanceNano(
  tier: Exclude<UserTier, 'guest'>,
  balanceNanoUsd: bigint,
  freeAllowanceNanoUsd: bigint
): bigint {
  switch (tier) {
    case 'trial': {
      return TRIAL_MESSAGE_COST_CAP_NANO_USD;
    }
    case 'free': {
      return freeAllowanceNanoUsd;
    }
    case 'paid': {
      return spendableFundsNanoUsd(balanceNanoUsd);
    }
  }
}

interface PromptCapacity {
  /** Estimated context usage in tokens: input tokens + the minimum output reserve. */
  currentUsage: number;
  /** The limiting model context length in tokens. */
  maxCapacity: number;
  /** Usage as a percentage of context (0 when the context length is unknown). */
  capacityPercent: number;
}

interface PromptCapacityInput {
  /** Total prompt characters: system prompt + history + user message. */
  promptCharacterCount: number;
  /** The most restrictive selected model's context length in tokens. */
  modelContextLength: number;
}

/**
 * Context-window capacity for the composer meter. Capacity is NOT a money
 * figure, and is reported separately from affordability so the two concerns
 * stay uncoupled; it reads the prompt through the same input conversion.
 */
export function computePromptCapacity(input: PromptCapacityInput): PromptCapacity {
  const capacityInputTokens = inputTokensOf(input.promptCharacterCount);
  const currentUsage = capacityInputTokens + MINIMUM_OUTPUT_TOKENS;
  const capacityPercent =
    input.modelContextLength > 0 ? (currentUsage / input.modelContextLength) * 100 : 0;
  return { currentUsage, maxCapacity: input.modelContextLength, capacityPercent };
}
