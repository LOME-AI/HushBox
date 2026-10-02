/**
 * The classifier engine: the cheapest model of a priceable pool, ordered on its
 * combined per-token rate with an identifier tiebreak.
 *
 * The order is deliberately BASIS-INDEPENDENT. A prompt-weighted order (the
 * candidate order of §Smart Model 1) could pick a different engine for the two
 * option-set passes, and a cheaper engine on the `spendable` pass would let the
 * admissible ceiling exceed its affordable counterpart — breaking
 * `admissible ⊆ affordable`. Whoever moves this onto `maxCallCost` must keep the
 * engine choice basis-independent or re-derive that invariant.
 *
 * The tiebreak is load-bearing rather than tidy: a catalog read is a whole-table
 * select, so without it row order would decide which model classifies every
 * `auto` turn (§Smart Model 1).
 *
 * It sits apart from the turn core because the server's classifier pick and the
 * core's own reserve must name the SAME engine; two derivations of "cheapest"
 * would let a turn reserve for one model and prompt another.
 */

import { combinedRateNanoUsd } from './money/premium.ts';
import type { PriceableModel } from './model/priceable-model.ts';

export function classifierEngineOf(pool: readonly PriceableModel[]): PriceableModel | undefined {
  let cheapest: PriceableModel | undefined;
  for (const model of pool) {
    if (cheapest === undefined) {
      cheapest = model;
      continue;
    }
    const rate = combinedRateNanoUsd(model);
    const best = combinedRateNanoUsd(cheapest);
    if (rate < best || (rate === best && model.modelId < cheapest.modelId)) cheapest = model;
  }
  return cheapest;
}
