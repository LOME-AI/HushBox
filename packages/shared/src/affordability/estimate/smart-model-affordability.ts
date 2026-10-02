/**
 * The Smart Model classifier's pre-reserve. Its input size is derived once, by
 * {@link classifierReserveChars}, and its output is capped at
 * {@link CLASSIFIER_OUTPUT_TOKEN_CAP}, so every pricer of a classifier call
 * sizes it by the same derivation; which pricer reads it, and how, is stated on
 * {@link classifierWorstCaseNanoUsd}.
 *
 * The per-candidate affordability gate that used to live beside it is gone: the
 * turn core is now the single producer of which models a turn may draw on and
 * what each may spend, for the server and the client alike, so a second gate
 * here would be a second answer to a question that has one.
 */

import {
  computeClassifierPromptOverhead,
  MAX_CLASSIFIER_CONTEXT_CHARS,
} from '../smart-model/prompts.ts';
import { CLASSIFIER_OUTPUT_TOKEN_CAP } from '../smart-model/eligible-models.ts';
import { costAt, textCallCurve } from '../price/curve.ts';
import { inputTokensOf } from '../price/quantities.ts';
import type { NanoUSD } from '../money/nano-usd.ts';
import type { CallQuantities, CostCurve } from '../price/curve.ts';
import type { TokenPricing } from '../price/schedule.ts';

/**
 * The classifier's worst-case input char count: the truncation budget plus the
 * worst-case prompt overhead for the supplied model list, which the reserve
 * converts to its input tokens.
 *
 * It lives here rather than in the price core: the reserve is the PROMPT's own
 * size, so reading it is a call down into the renderer, and a price-core module
 * that made that call would put the money layer above the dimension registry the
 * renderer reads — the loop that made this whole directory's load order a thing
 * to reason about.
 *
 * Both legs are upper bounds by construction rather than by measurement, which
 * is what `reserve ⊇ bill` needs of them:
 *
 * - the excerpt leg is the whole {@link MAX_CLASSIFIER_CONTEXT_CHARS} budget,
 *   and the emitter that fills it counts its own section labels and separators
 *   inside that same budget, so the message it produces never exceeds what is
 *   priced here;
 * - the template leg renders the real template with every description at its
 *   declared maximum, so no catalog text can render longer than what is priced.
 *
 * The list must be the one the classifier will be PROMPTED with. Pricing a
 * different list — the whole catalog, say — leaves the error's sign undecided
 * rather than merely generous, and an unsigned error is not a bound.
 */
export function classifierReserveChars(promptedModels: readonly { readonly id: string }[]): number {
  return MAX_CLASSIFIER_CONTEXT_CHARS + computeClassifierPromptOverhead(promptedModels);
}

/**
 * The Smart-Model classifier pre-reserve, in nano-USD: the provider cost of one
 * bounded classifier call on the reserve side, each token at the ceiling of the
 * classifier's billable rate, priced as an ordinary call that does not persist.
 * Its input is the classifier's full truncated-context budget plus the
 * exact prompt overhead (rendered against the candidate list — an upper bound on
 * what the classifier sees once affordability shrinks the list), and its output
 * is {@link CLASSIFIER_OUTPUT_TOKEN_CAP}, at the classifier's rates. Every
 * reader outside admission, the client turn producer whose figure the server's
 * hold is compared against among them, reads the reserve through this function.
 * Admission holds the classifier call on one of two paths. A chat turn's
 * classifier is its own `classify` model call, stamped with the input-token
 * count this reserve derives for the list the call is prompted with and capped
 * at the same output, then priced as an ordinary non-persisting call with each
 * count clamped to the classifier model's own limits. A smartModel slot that
 * classifies for itself prices {@link classifierReserveCurve}.
 *
 * The reserve carries no storage on any tier, because the classifier's prompt
 * and answer never rest, and nothing about it scales with the turn's output.
 */
export function classifierWorstCaseNanoUsd(
  classifier: { readonly pricing: TokenPricing },
  // Only id + description are read (the classifier prompt line), so this accepts
  // the estimator's stamped candidate list as well as full descriptors.
  textCatalog: readonly { readonly id: string; readonly description?: string | undefined }[]
): NanoUSD {
  return costAt(classifierReserveCurve(classifier, textCatalog).curve, CLASSIFIER_OUTPUT_TOKEN_CAP);
}

/**
 * The classifier call the reserve prices, as its quantities and its cost curve
 * up to {@link CLASSIFIER_OUTPUT_TOKEN_CAP}: a call that stores nothing, over the
 * classifier's reserve characters.
 */
export function classifierReserveCurve(
  classifier: { readonly pricing: TokenPricing },
  textCatalog: readonly { readonly id: string }[]
): { readonly quantities: CallQuantities; readonly curve: CostCurve } {
  const reserveChars = classifierReserveChars(textCatalog.map((entry) => ({ id: entry.id })));
  const quantities: CallQuantities = {
    promptTokens: inputTokensOf(reserveChars),
    persists: false,
    newMessageChars: 0,
  };
  return {
    quantities,
    curve: textCallCurve(classifier.pricing, 'reserve', quantities, CLASSIFIER_OUTPUT_TOKEN_CAP),
  };
}
