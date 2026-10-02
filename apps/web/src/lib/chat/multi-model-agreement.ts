/**
 * Cross-model capability agreement.
 *
 * Multi-model media requests dispatch the same `imageConfig` / `videoConfig`
 * to every selected model. The UI can only honestly expose a value when ALL
 * selected models support it — otherwise we'd silently route a request that
 * one of the providers will reject (`UNSUPPORTED_RESOLUTION`, etc.).
 *
 * `agreedAxis` computes that intersection for one axis (resolution, aspect
 * ratio, duration, …) and says which of three states it is; `agreedOptions` is
 * its flattening for callers with nothing to say about an absent choice.
 * `snapToNearest` is the companion for the duration slider — Veo's discrete
 * duration set is non-uniform (`{4, 6, 8}` for 3.1, `{5, 6, 7, 8}` for 3.0) so
 * native HTML range `step` can't enforce it.
 */

interface SelectedModelEntry {
  readonly id: string;
}

/**
 * What one axis's selected models jointly permit.
 *
 * The three states are kept apart in the TYPE because two of them used to
 * arrive as the same empty answer, and a surface cannot tell them apart from
 * the value: `unconstrained` means the composer may offer the axis' whole
 * presentation range, while `conflict` means every value the composer could
 * send is refused by at least one selected model, so offering any of them at
 * all builds a turn that can never leave the client.
 */
export type AxisAgreement<T extends string | number> =
  /** No selected model imposes a readable domain, so nothing narrows the axis. */
  | { readonly kind: 'unconstrained' }
  /** The models that declare a domain share these, in first-model order. */
  | { readonly kind: 'agreed'; readonly options: readonly T[] }
  /** Domains are declared, but no value satisfies every one of them. */
  | { readonly kind: 'conflict' };

/**
 * Intersects the `pluck`-extracted option sets across all selected models,
 * preserving the first-model ordering, and names which of the three states the
 * result is.
 *
 * A model missing from the catalog, or one returning `undefined` (or an empty
 * array — the catalog's way of saying it declared nothing) from `pluck`,
 * contributes no domain: we cannot fail closed on what we cannot read, and an
 * undeclared axis is unconstrained rather than forbidden. Only sets that were
 * actually declared can conflict.
 */
export function agreedAxis<TModel extends { id: string }, T extends string | number>(
  selectedModels: readonly SelectedModelEntry[],
  modelCatalog: readonly TModel[] | undefined,
  pluck: (model: TModel) => readonly T[] | undefined
): AxisAgreement<T> {
  if (modelCatalog === undefined) return { kind: 'unconstrained' };

  const declaredSets: (readonly T[])[] = [];
  for (const selected of selectedModels) {
    const catalogEntry = modelCatalog.find((m) => m.id === selected.id);
    if (!catalogEntry) return { kind: 'unconstrained' };
    const supported = pluck(catalogEntry);
    if (supported === undefined || supported.length === 0) continue;
    declaredSets.push(supported);
  }

  const [firstSet, ...rest] = declaredSets;
  if (firstSet === undefined) return { kind: 'unconstrained' };

  const options = firstSet.filter((option) => rest.every((set) => set.includes(option)));
  if (options.length === 0) return { kind: 'conflict' };
  return { kind: 'agreed', options };
}

/**
 * The options an agreement offers, with both no-option states flattened to the
 * empty list — what a control renders once it has already decided how to treat
 * the state it is in.
 */
export function agreedOptions<T extends string | number>(
  agreement: AxisAgreement<T>
): readonly T[] {
  return agreement.kind === 'agreed' ? agreement.options : [];
}

/**
 * Snap `raw` to the nearest entry in `allowed`. Ties resolve toward the lower
 * value (floor). Out-of-range values clamp to the nearest boundary. Returns
 * `undefined` when `allowed` is empty.
 */
export function snapToNearest(allowed: readonly number[], raw: number): number | undefined {
  const first = allowed[0];
  if (first === undefined) return undefined;

  let best = first;
  let bestDistance = Math.abs(raw - best);
  for (let index = 1; index < allowed.length; index++) {
    const candidate = allowed[index];
    /* v8 ignore next -- `index` iterates valid indices of `allowed`, so `candidate` is never undefined; this guard is unreachable. */
    if (candidate === undefined) continue;
    const distance = Math.abs(raw - candidate);
    // Strict `<` keeps the earlier (typically lower) value on ties — floor on tie.
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}
