import { buildSmartModelCandidates } from './candidates.js';
import { TRIAL_MESSAGE_COST_CAP_NANO_USD } from './trial-eligibility.js';
import type { SmartModelCandidates } from './candidates.js';
import type { CanonicalReasoningEffort, ModelDescriptor } from '@hushbox/shared';

/**
 * The Smart Model candidate menu for one TRIAL send.
 *
 * It is the PAID derivation at the trial tier, and nothing else: same producer,
 * same pool projection, same grading, with the fixed per-message ceiling
 * (`TRIAL_MESSAGE_COST_CAP_NANO_USD`) standing in for the wallet balance a trial
 * sender does not have. The tier carries the rest — the producer withholds a
 * premium row from a trial payer and drops every storage term because a trial
 * turn persists nothing.
 *
 * Deriving it separately is what this replaced. A menu of its own could only
 * re-state the producer's feasibility rule, and by omission it did not: it asked
 * whether a candidate could RESOLVE the turn's pinned rung but never whether the
 * candidate's own ceiling could hold that rung's budget beside a minimum answer,
 * nor whether the ceiling could fund it — so the trial menu admitted rows the
 * client's own picker, which grades trial through this producer, greyed.
 *
 * An empty menu is the caller's refusal signal: `null`, the same signal the paid
 * arm gives, which the trial route reads as a send too expensive for the trial.
 */

interface TrialSmartModelCandidatesInput {
  /** The exposed catalog (`listDescriptors`' already-filtered set). */
  readonly descriptors: readonly ModelDescriptor[];
  /** The reference clock the premium-recency leg is measured from. */
  readonly nowMs: number;
  /**
   * The character count the SEND carries — system prompt, custom instructions,
   * history and the new input — as the route measured it for the turn budget.
   *
   * A count, not the text, and it arrives from the caller rather than being
   * recomputed here. Recomputing it locally is exactly the defect this replaced:
   * this file could see the system prompt, the history and the input, but NOT the
   * custom instructions, so the gate priced less than the definition it gates and
   * admitted sends over the per-message cap.
   */
  readonly promptCharacterCount: number;
  /**
   * The reasoning level the sender pinned, when the turn pins one. It grades the
   * menu: a row that cannot resolve the rung, or cannot fit its budget beside a
   * minimum viable answer, is not a candidate — so a pinned trial turn cannot
   * bind a model that would answer at some other rung. Absent leaves the axis
   * open, which is the `auto` turn's menu.
   */
  readonly effortPin?: CanonicalReasoningEffort;
}

export function buildTrialSmartModelCandidates(
  input: TrialSmartModelCandidatesInput
): SmartModelCandidates | null {
  return buildSmartModelCandidates({
    descriptors: input.descriptors,
    balanceNanoUsd: TRIAL_MESSAGE_COST_CAP_NANO_USD,
    tier: 'trial',
    promptChars: input.promptCharacterCount,
    // The STORAGE basis. A trial turn persists nothing, so the tier already
    // drops every storage term; zero states that rather than leaning on it.
    inputChars: 0,
    // A trial send is the slot alone: the trial route compiles no pinned
    // sibling and carries no web-search tool.
    pinnedModelIds: [],
    webSearch: false,
    nowMs: input.nowMs,
    ...(input.effortPin === undefined ? {} : { effortPin: input.effortPin }),
  });
}
