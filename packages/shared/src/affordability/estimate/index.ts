/**
 * The estimator's published surface, not a directory barrel.
 *
 * `docs/BILLING.md` §Where the Code Lives keeps the pricing machinery itself
 * unexported — rates, manifests, the two reducers, the per-candidate ceiling
 * solvers, the reasoning-budget ladder, the characters-per-token ratios and the
 * clamps. Those units are therefore absent here rather than absent one level
 * up: a name this file does not carry cannot reach either entry point,
 * whichever of them stars it. What is published is the vocabulary a caller legitimately names — the
 * fail-closed result channel, the funding pre-adapters, the storage rates and
 * the byte estimate they price, the wire fragment, the reasoning-plan
 * producers, and the display formatters.
 *
 * The plan producers are published while the LADDER they compute from is not,
 * and the split is the point: a caller may ask what a model's plan at an effort
 * IS, and cannot read the budget table to work one out itself. Withholding the
 * producers while four of their siblings were already published bought nothing
 * — it only pushed callers into re-deriving `B + H`, a mirrored formula
 * `docs/CODE-RULES.md` bans.
 */

export * from './storage-rate.ts';
export * from './output-bytes.ts';
export * from './format.ts';
export { estimateErr, estimateOk } from './types.ts';
export type { EstimateError, EstimateErrorCode, EstimateResult } from './types.ts';
export {
  getCushionNano,
  getEffectiveBalanceNano,
  PAID_CUSHION_NANO_USD,
  spendableFundsNanoUsd,
} from './pre-adapters.ts';
export { outputTokensOf } from './run-ceiling.ts';
export type { CallUsage } from './run-ceiling.ts';
export {
  REASONING_OFF_WIRE,
  ReasoningWire,
  planReasoning,
  planReasoningOff,
  reasoningBudgetForWire,
  reasoningPlanModelFrom,
} from './reasoning-plan.ts';
export type { ReasoningPlanDescriptorInput, ReasoningPlanModel } from './reasoning-plan.ts';
export type { EffortChoice } from './effort-options.ts';
// The coarse producers a surface asks its question through. Each takes a turn's
// own inputs and returns the decision, so the manifest, the reducers, the token
// ratios and the effort ladder stay behind the wall: a caller that assembled
// any of them would be a second estimator, and
// the composer's figures would drift from admission's the first time either
// side changed (`docs/BILLING.md` §Where the Code Lives).
export { effortSelectionForTurn } from './effort-options.ts';
export type { TurnEffortSelectionInput } from './effort-options.ts';
export { reasoningBudgetForTurn } from './reasoning-budget-turn.ts';
export type { ReasoningBudgetInput, ReasoningBudgetModel } from './reasoning-budget-turn.ts';
export { mediaTurnCostNanoUsd } from './media-turn-cost.ts';
export type { MediaTurnCostInput } from './media-turn-cost.ts';
export { textTurnBudget } from './text-turn-budget.ts';
export type { TextTurnBudget, TextTurnBudgetInput } from './text-turn-budget.ts';
