/**
 * The dimension registries — one per modality, each holding one entry per
 * cost-affecting dimension of that modality, validated at
 * registration so a declaration cannot be internally inconsistent
 * (`docs/BILLING.md` §Extending the System — "Add a dimension" is one registry
 * entry, and everything else is derived).
 *
 * The registry is code, not data in a table: it holds functions, so it can never
 * be the persisted `ParamSpec` (a `z.strictObject` inside the jsonb descriptor).
 * It REFERENCES a per-model parameter spec for its option values instead, which
 * is what keeps option domains single-sourced without inventing a second one.
 */

import { EFFORT_DIMENSION } from './effort.ts';
import { MODEL_DIMENSION } from './model.ts';
import { DIMENSION_IDS } from './types.ts';
import type {
  AnyDimensionId,
  DimensionId,
  DimensionModel,
  DimensionSpec,
  DimensionSpecOf,
  OpenDimension,
} from './types.ts';

/** A declaration the registry refuses. Always a code defect, never runtime data. */
export class DimensionRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DimensionRegistrationError';
  }
}

/**
 * Validate one declaration. Each rule catches a way a dimension author could
 * declare something the derivations would then silently mis-price:
 *
 * - an enum domain with no values has no option domain at all;
 * - `resource: 'none'` and `costClass: 'free'` are the same fact stated twice, so
 *   they must agree — otherwise "skips affordability entirely" and "has a
 *   requirement" are both declared;
 * - a `multiplicative` dimension shrinks the delivered ceiling by construction
 *   (the hold precedes its resolution), so it cannot claim to deliver at the
 *   hold ceiling;
 * - an axis with no sentence cannot generate a prompt section.
 */
export function defineDimension<M extends DimensionModel>(
  spec: DimensionSpec<M>
): DimensionSpec<M> {
  if (spec.param.type === 'enum' && (spec.param.values ?? []).length === 0) {
    throw new DimensionRegistrationError(
      `dimension '${spec.id}': an enum option domain must declare values`
    );
  }
  if ((spec.resource === 'none') !== (spec.costClass === 'free')) {
    throw new DimensionRegistrationError(
      `dimension '${spec.id}': resource 'none' and cost class 'free' must be declared together`
    );
  }
  if (spec.costClass === 'multiplicative' && spec.deliversAtHoldCeiling) {
    throw new DimensionRegistrationError(
      `dimension '${spec.id}': a multiplicative dimension cannot deliver at the hold ceiling`
    );
  }
  if (spec.promptDescription.trim().length === 0) {
    throw new DimensionRegistrationError(`dimension '${spec.id}': promptDescription is empty`);
  }
  return spec;
}

/**
 * Build ONE modality's registry: every declaration validated, exactly one per id
 * of that modality's closed set. A missing id would leave a pinnable key with no
 * pricing rule; a duplicate would make which entry wins depend on array order.
 *
 * Generic over both the id set and the model projection because a modality
 * registers its own dimensions over its own projection — the token path over
 * `PriceableModel`, media over `MediaModel` — and one registry per modality is
 * what keeps each id set closed without forcing a media dimension onto a text
 * turn.
 *
 * Each declaration's id is constrained to that set: a foreign id passes both
 * runtime guards below (nothing is missing, nothing is duplicated) while making
 * the returned record's declared key type a lie about its own contents, so the
 * type is where it has to be refused.
 */
export function defineDimensions<Id extends AnyDimensionId, M extends DimensionModel>(
  ids: readonly Id[],
  specs: readonly DimensionSpecOf<NoInfer<Id>, M>[]
): Readonly<Record<Id, DimensionSpec<M>>> {
  const byId = new Map<AnyDimensionId, DimensionSpec<M>>();
  for (const spec of specs) {
    if (byId.has(spec.id)) {
      throw new DimensionRegistrationError(`dimension '${spec.id}' is declared twice`);
    }
    byId.set(spec.id, defineDimension(spec));
  }
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new DimensionRegistrationError(`dimension registry is missing '${missing.join(', ')}'`);
  }
  return Object.freeze(Object.fromEntries(byId) as Record<Id, DimensionSpec<M>>);
}

export const DIMENSIONS = defineDimensions(DIMENSION_IDS, [MODEL_DIMENSION, EFFORT_DIMENSION]);

export function dimensionFor(id: DimensionId): DimensionSpec {
  return DIMENSIONS[id];
}

/**
 * Register a dimension as OPEN — classifier-selectable. This is the registration
 * a non-enumerable dimension is refused at: only a finite option set can be
 * presented as a closed choice, so a continuous dimension may be pinned but
 * never handed to a classifier. Quantizing it makes it classifiable.
 *
 * Openness itself is not a declared field — a dimension is pinned or open purely
 * according to whether the user fixed it — so the guard sits on the constructor
 * of the open form, and `OpenDimension` is obtainable nowhere else.
 */
export function openDimension<M extends DimensionModel>(spec: DimensionSpec<M>): OpenDimension<M> {
  if (!spec.enumerable) {
    throw new DimensionRegistrationError(
      `dimension '${spec.id}' is not enumerable and cannot be opened`
    );
  }
  return { spec };
}
