/**
 * One classifier answer, resolved against what a turn actually presented: the
 * effort options its prompt offered and the candidates its slot may bind.
 *
 * The model and the effort resolve together because they are one decision. The
 * two ride separate lines of the answer, so an answer can bind a candidate at a
 * rung that candidate cannot answer at; the effort is then clamped down against
 * the bound candidate, never refused (`docs/BILLING.md` §Reasoning Effort 8):
 * the classifier cannot fail into an infeasible state. Composing both axes in
 * one producer keeps the parse, the per-dimension matchers and the declared
 * fallbacks behind the wall (§Where the Code Lives).
 */

import { dimensionOptionNamedBy } from '../dimensions/derive.ts';
import { EFFORT_DIMENSION, effortDomainOptions } from '../dimensions/effort.ts';
import { MODEL_DIMENSION } from '../dimensions/model.ts';
import { parseClassifierAnswer } from './effort-dimension.ts';
import type { DimensionOption } from '../dimensions/types.ts';
import type { ClassifierEffortLevel } from './effort-dimension.ts';

/** A candidate the answer may bind, with the presented rungs it answers at. */
export interface ClassifierCandidate {
  readonly id: string;
  readonly answerableRungs: readonly string[];
}

export interface ClassifierResolution {
  /**
   * The candidate the turn binds: the one the answer named, else the first on
   * the list, which is the declared fallback. `undefined` only when the turn
   * listed no candidate.
   */
  readonly modelId: string | undefined;
  /**
   * The rung the turn runs at: what the answer named when the turn presented
   * it, else the cheapest option it did present, clamped down to the highest
   * rung at or below that which the bound candidate answers at. `undefined` only
   * when the turn presented no option at all: the axis was closed, so there is
   * nothing to resolve and no rung to invent.
   */
  readonly effort: ClassifierEffortLevel | undefined;
}

export function resolveClassifierAnswer(
  answer: string,
  presentedEfforts: readonly string[],
  candidates: readonly ClassifierCandidate[]
): ClassifierResolution {
  const presented = effortDomainOptions().filter((option) =>
    presentedEfforts.includes(option.optionId)
  );
  // Whether the effort axis was opened AT ALL is exactly whether the prompt
  // presented options on it, so the split rule is read off the presented set
  // rather than told to this function a second time. With both axes open an
  // unlabelled answer belongs to neither; with one open it can only be that
  // one's.
  const parts = parseClassifierAnswer(answer, { model: true, effort: presented.length > 0 });
  const bound = namedCandidate(parts.modelText, candidates) ?? candidates[0];
  const effort = namedEffort(parts.effortText, presented);
  return {
    modelId: bound?.id,
    effort: bound === undefined ? effort : clampedEffort(effort, presented, bound),
  };
}

/**
 * The highest presented rung at or below `effort` that the candidate answers at.
 * A candidate that answers at none of them leaves the rung as it was, so its
 * slot refuses the binding as the defect it is rather than this resolver
 * inventing a rung: a candidate's rungs always include the lowest the turn
 * presented.
 */
function clampedEffort(
  effort: ClassifierEffortLevel | undefined,
  presented: readonly DimensionOption[],
  candidate: ClassifierCandidate
): ClassifierEffortLevel | undefined {
  if (effort === undefined) return undefined;
  // Ascending domain order, so the slice through `effort` is every rung at or below it.
  const atOrBelow = presented.slice(
    0,
    presented.findIndex((option) => option.optionId === effort) + 1
  );
  const answerable = atOrBelow.filter((option) =>
    candidate.answerableRungs.includes(option.optionId)
  );
  return (answerable.at(-1)?.optionId ?? effort) as ClassifierEffortLevel;
}

/**
 * The rung the answer named among those presented, else the cheapest presented
 * one (§Reasoning Effort 8 — the fallback is the cheapest PRESENTED option, not
 * the axis's own cheapest, so an answer naming an unpresented rung and an answer
 * naming nothing land in the same place).
 */
function namedEffort(
  effortText: string,
  presented: readonly DimensionOption[]
): ClassifierEffortLevel | undefined {
  const named = dimensionOptionNamedBy(EFFORT_DIMENSION, presented, effortText);
  return (named ?? presented[0]?.optionId) as ClassifierEffortLevel | undefined;
}

/**
 * The candidate the answer named, read exactly as every other dimension is: the
 * registry's declared matching rule for a catalog domain, over the ids that were
 * presented. Label and id are one and the same for a candidate, so no display
 * word enters.
 */
function namedCandidate(
  modelText: string,
  candidates: readonly ClassifierCandidate[]
): ClassifierCandidate | undefined {
  const presented = candidates.map((candidate) => ({
    optionId: candidate.id,
    label: candidate.id,
  }));
  const named = dimensionOptionNamedBy(MODEL_DIMENSION, presented, modelText);
  return candidates.find((candidate) => candidate.id === named);
}
