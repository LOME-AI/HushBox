/**
 * A model's answer room, published as answers rather than as the ceiling
 * machinery behind them (`docs/BILLING.md` §Where the Code Lives): the server's
 * compile refuses and sizes a turn with the same arithmetic the composer grades
 * `model_output_cap_too_low` with, so the two cannot disagree on which sends
 * leave a model room for a minimum answer.
 */

import { cheapestEffortOption } from '../dimensions/effort.ts';
import { RESOLVED_REASONING_EFFORTS } from '../reasoning-effort.ts';
import { feasible, maxCallCostTokens } from './turn-arithmetic.ts';
import type { PriceableModel } from '../model/priceable-model.ts';
import type { ResolvedReasoningEffort } from '../reasoning-effort.ts';

/**
 * `min(providerCap, contextHeadroom)` for a prompt of `inputTokens`: what the
 * model can emit and what the prompt leaves free, with no money bound. Zero
 * when the prompt overruns the context window.
 */
export function answerRoomTokens(model: PriceableModel, inputTokens: number): number {
  return maxCallCostTokens(model, inputTokens);
}

/**
 * Whether the model's answer room for a prompt of `inputTokens` holds the
 * reasoning budget of `effort` plus a minimum answer. `off`, and an absent
 * effort (a model that reasons at no rung), reserve no budget, so the room must
 * hold a minimum answer alone. `effort` must be a rung the model offers.
 */
export function effortFitsAnswerRoom(
  model: PriceableModel,
  effort: ResolvedReasoningEffort | undefined,
  inputTokens: number
): boolean {
  return feasible(model, effort, answerRoomTokens(model, inputTokens));
}

/**
 * The effort the composer grades a model at when the send pins no rung: `off`
 * for a model that can turn reasoning off, the cheapest rung for one that
 * cannot, and absent for a model that does not reason. A server model with no
 * resolved reasoning entry is held to this, so a mandatory-reasoning model must
 * fit its cheapest rung plus a minimum answer on both sides.
 */
export function unpinnedEffortOf(model: PriceableModel): ResolvedReasoningEffort | undefined {
  const option = cheapestEffortOption(model);
  return RESOLVED_REASONING_EFFORTS.find((effort) => effort === option);
}
