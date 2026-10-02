/**
 * The reasoning token budget B a turn prices, across every model it draws on.
 *
 * It is the largest feasible per-level budget among the selected models, which
 * is what the server's minimum gate counts on top of the minimum answer. Taking
 * the max is the whole reason this is a producer rather than a loop at each
 * surface: a caller reducing per-model plans itself decides which model's budget
 * the turn is sized by, and two callers reducing differently price the same turn
 * two ways.
 *
 * Only an explicit canonical level prices a budget. `off` is the hard off
 * (B = 0) and `auto`'s placeholder reserve resolves server-side, so neither is
 * mirrored here — the estimate shows the reasoning-free floor until a level is
 * explicit. A model that does not offer the level contributes nothing: the
 * effort menu greys the option and the server refuses the send, and a
 * substituted nearer level would price a turn that never runs.
 */

import { planReasoning } from './reasoning-plan.ts';
import type { ReasoningPlanModel } from './reasoning-plan.ts';
import type { CanonicalReasoningEffort, ReasoningEffortSelection } from '../reasoning-effort.ts';

/** A catalog row as this producer reads it: the plan's slice, plus the id to match on. */
export interface ReasoningBudgetModel extends ReasoningPlanModel {
  readonly id: string;
}

export interface ReasoningBudgetInput {
  readonly selection: ReasoningEffortSelection | undefined;
  /** The turn's selected model ids, in any order. */
  readonly selectedIds: readonly string[];
  /** The served catalog, or `undefined` while it is unresolved. */
  readonly catalog: readonly ReasoningBudgetModel[] | undefined;
}

/**
 * The budget in tokens, or `undefined` when the turn prices none — the two
 * absences the caller owes the user the same thing for: no level is pinned, and
 * no selected model offers the pinned one.
 *
 * The answer headroom passed to the plan is one whole token: this asks whether a
 * budget FITS at all, and the affordability sizing that consumes it is taken by
 * the estimator, not here.
 */
export function reasoningBudgetForTurn(input: ReasoningBudgetInput): number | undefined {
  const { selection, selectedIds, catalog } = input;
  if (selection === undefined || selection === 'auto' || selection === 'off') return undefined;
  const level: CanonicalReasoningEffort = selection;

  let largest = 0;
  for (const id of selectedIds) {
    const model = catalog?.find((row) => row.id === id);
    // A selected id the catalog has not delivered is unresolved, not
    // reasoning-free: it contributes nothing rather than capping the max at zero.
    if (model === undefined) continue;
    const planned = planReasoning(model, level, 1);
    if (planned.feasible) largest = Math.max(largest, planned.plan.reasoningBudgetTokens);
  }
  return largest > 0 ? largest : undefined;
}
