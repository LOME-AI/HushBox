/**
 * Rival continuations asked for by the surface that lists them.
 *
 * Sized from the list rather than from the model: the rendered list holds only
 * rivals to the inline completion, and past four rows it stops being scannable
 * at a glance — so three is what a surface can use. Every other surface asks
 * for none, which is not a detail: the rivals come from a batched sampling
 * pass costing a multiple of the cached greedy one, on a CPU model, on a
 * phone, and a composer that cannot draw a list must not pay for one.
 *
 * Shaping folds rivals that collapse into the completion or into each other,
 * so a shown list holds between one and three rows.
 */
export const SUGGESTION_LIST_ALTERNATIVE_COUNT = 3;
