/**
 * Every rung a set of ANSWER SOURCES declares on the effort axis, in the
 * domain's own ascending order — §Reasoning Effort 4's "the union of all
 * selected models' offered levels".
 *
 * ONE rule, two readers, which is why it is neither of their files. The engine
 * asks it of the arrangements it presents, so every rung the menu shows is one
 * some model on the wire could honour (`turn/turn-core.ts`). The selection
 * authority asks it of the sources a composer holds, so a preference resolves
 * against what the selection can serve before any balance is known
 * (`estimate/effort-options.ts`). A second copy of this union is exactly how a
 * surface comes to offer — or to hold — a rung the gate has no answer source
 * for.
 *
 * It reads MEMBERSHIP alone, which the selection fixes, so the set carries no
 * funding term: a rung cannot appear and disappear as the balance moves, and an
 * unsendable turn still has rows to grey.
 *
 * The input is the reasoning-plan projection rather than the full priceable
 * model, because that is the shape both readers can produce: the composer holds
 * catalog rows and never sees a rate. The domain guard `dimensionSupportFor`
 * adds is not lost with it — every option `effortSupportOf` can produce is a
 * canonical ladder label or the off rung, and those ARE the declared domain.
 */

import { EFFORT_OPTION_IDS, effortSupportOf } from '../dimensions/effort.ts';
import type { DimensionOption, OptionId } from '../dimensions/types.ts';
import type { ReasoningPlanModel } from '../estimate/reasoning-plan.ts';

export function offeredEffortRungs(
  sources: readonly ReasoningPlanModel[]
): readonly DimensionOption[] {
  const byOption = new Map<OptionId, DimensionOption>();
  for (const source of sources) {
    for (const option of effortSupportOf(source).options) {
      byOption.set(option.optionId, option);
    }
  }
  return EFFORT_OPTION_IDS.flatMap((optionId) => {
    const option = byOption.get(optionId);
    return option === undefined ? [] : [option];
  });
}
