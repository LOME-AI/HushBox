/**
 * The derivation of a model's effective completion cap for the turn's priced
 * bounds — the client's affordability preflight, the server's admission holds
 * and the turn's stamped answer cap. Each of them asks "how many tokens can
 * this model emit at all" through this function, so none of them can start
 * from a different cap.
 *
 * The reasoning budget clamps through here too (`clampBudget` in
 * `estimate/reasoning-plan.ts`), so a priced bound's ceiling term and its
 * reasoning term cannot read different ceilings for one model.
 *
 * The quantity is not baked into the catalog row: media rows and the synthetic
 * Smart Model row legitimately carry no completion ceiling, and a stored value
 * would have to invent one for them. The absence therefore survives to this
 * function, which resolves it for the bounds above.
 *
 * Pure arithmetic: no rate, no money, no clock.
 */

/**
 * The facts the cap derives from. `contextLength` is required — a row without
 * one is not priceable at all and is refused upstream. `providerCap` is the
 * catalog's ingested completion ceiling (`limits.maxOutputTokens`), absent on
 * every row whose provider declares none.
 */
interface CompletionCapModel {
  readonly contextLength: number;
  readonly providerCap?: number | undefined;
}

/**
 * `min(contextLength, providerCap ?? contextLength)` — strict tightening: a
 * declared ceiling only ever narrows the context window, and an absent one
 * leaves the window alone. A declared zero is a declaration, not an absence.
 */
export function effectiveCompletionCap(model: CompletionCapModel): number {
  return Math.min(model.contextLength, model.providerCap ?? model.contextLength);
}

/**
 * The output ceiling a model call declares: its `maxOutputTokens` param when
 * that is a positive integer, bounded by the model's effective completion cap,
 * and otherwise the cap itself — the full-context worst case for an uncapped
 * model. It only ever SHRINKS the bound: an invalid declaration falls back to
 * the cap rather than under-reserving. A model with no context length has no cap
 * to fall back to, so it refuses; a caller pricing one refuses it first.
 */
export function callOutputCeilingTokens(
  params: Readonly<Record<string, unknown>>,
  descriptor: { readonly limits: Readonly<Record<string, number>> }
): number {
  const contextLength = descriptor.limits['contextLength'];
  if (contextLength === undefined) {
    throw new RangeError('callOutputCeilingTokens: the model declares no context length');
  }
  const cap = effectiveCompletionCap({
    contextLength,
    providerCap: descriptor.limits['maxOutputTokens'],
  });
  const declared = params['maxOutputTokens'];
  if (typeof declared === 'number' && Number.isSafeInteger(declared) && declared > 0) {
    return Math.min(cap, declared);
  }
  return cap;
}
