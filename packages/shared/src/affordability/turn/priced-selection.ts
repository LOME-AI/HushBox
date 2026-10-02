import type { ModelId } from '../model/model-id.ts';

/** A catalog split against the ids a turn selected. */
export interface PricedSelection<Model> {
  /** The selected models the catalog prices, in the order the turn selected them. */
  readonly priced: readonly Model[];
  /** The selected ids it does not — every one of which the request still carries. */
  readonly unpriceableIds: readonly ModelId[];
}

/**
 * The one answer to "which selected ids could not be priced", asked by both
 * cores over their own projection. A projection leaves a row OUT when it cannot
 * price it, so absence from the catalog IS unpriceability — there is nothing
 * else to consult and no caller to be told it by.
 *
 * Deriving it here rather than taking it from the caller is what closes the
 * escape: a stored selection outlives the catalog it was made against, and the
 * request body carries every stored id either way, so an id read off the
 * surviving rows alone falls out of the price while it still generates and still
 * bills. A caller that answered this for itself was a second route to one
 * question, and only one of the two ever had to drift.
 */
export function pricedSelection<Model extends { readonly modelId: ModelId }>(
  catalog: readonly Model[],
  selectedIds: readonly ModelId[]
): PricedSelection<Model> {
  const byId = new Map(catalog.map((model) => [model.modelId, model]));
  const priced: Model[] = [];
  const unpriceableIds: ModelId[] = [];
  for (const id of selectedIds) {
    const model = byId.get(id);
    if (model === undefined) unpriceableIds.push(id);
    else priced.push(model);
  }
  return { priced, unpriceableIds };
}
