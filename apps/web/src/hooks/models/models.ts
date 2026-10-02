import { useQuery } from '@tanstack/react-query';
import { SMART_MODEL_ID } from '@hushbox/shared';
import { client, fetchJson } from '@/lib/api-client.js';
import { priceDisplayOf } from '@/lib/chat/model-info-facts';
import type { Model, ChatModality } from '@hushbox/shared';

export interface ModelsData {
  models: Model[];
  premiumIds: Set<string>;
}

export const modelKeys = {
  all: ['models'] as const,
  list: () => [...modelKeys.all, 'list'] as const,
  detail: (id: string) => [...modelKeys.all, id] as const,
};

/** Reusable query options for models list. Shared by hooks and route loaders. */
export function modelsQueryOptions(): {
  queryKey: readonly ['models', 'list'];
  queryFn: () => Promise<ModelsData>;
  staleTime: number;
} {
  return {
    queryKey: modelKeys.list(),
    queryFn: async (): Promise<ModelsData> => {
      const response = await fetchJson(client.models.$get());
      return {
        models: response.models,
        premiumIds: new Set(response.premiumModelIds),
      };
    },
    staleTime: 1000 * 60 * 60,
  };
}

export function useModels(): ReturnType<typeof useQuery<ModelsData, Error>> {
  return useQuery(modelsQueryOptions());
}

const NO_PINS = { strongestId: '', valueId: '' } as const;

/**
 * Text-only strongest/value quick-select pins, derived from popularity.
 *
 * The tier-selectable text models (paid = all text; trial/free = non-premium
 * text; the Smart Model is never a pin) are ranked by `popularityRank` and the
 * most-popular half is kept; within that half the priciest model is "Strongest"
 * and the cheapest is "Value" (price is the combined fee-inclusive base rate a
 * row is displayed at). This keeps a rarely-used but expensive model from being
 * surfaced as the day-to-day pick. A row in that half the catalog serves no rate
 * for is neither pick: an unpriced row is not the cheapest, and pricing it at
 * zero would crown it the best value.
 *
 * Media modalities (image/video/audio) get no pins. A candidate set that is
 * empty or entirely unranked yields no pins — with no popularity signal there is
 * no basis for a "top half" pick.
 *
 * Candidacy is exactly the list handed in. Nothing is graded here — the tier
 * gate below answers "can this payer reach premium at all", never "does this row
 * send" — so a surface that greys rows on a per-row verdict drops its refused
 * ones before calling, or it crowns a row that answers the pick with a refusal.
 */
export function getAccessibleModelIds(
  models: Model[],
  premiumIds: Set<string>,
  canAccessPremium: boolean,
  modality: ChatModality = 'text'
): { strongestId: string; valueId: string } {
  if (modality !== 'text') return { ...NO_PINS };

  const candidate = models.filter(
    (m) =>
      m.modality === 'text' &&
      m.id !== SMART_MODEL_ID &&
      (canAccessPremium || !premiumIds.has(m.id))
  );
  if (candidate.length === 0) return { ...NO_PINS };
  if (candidate.every((m) => m.popularityRank === undefined)) return { ...NO_PINS };

  const sorted = candidate.toSorted(
    (a, b) => (a.popularityRank ?? Infinity) - (b.popularityRank ?? Infinity)
  );
  const topHalf = sorted.slice(0, Math.ceil(sorted.length / 2));

  const priced = topHalf.flatMap((model) => {
    const key = priceDisplayOf(model).sortKeyNanoUsd;
    return key === undefined ? [] : [{ model, key }];
  });
  const first = priced[0];
  if (first === undefined) return { ...NO_PINS };

  let strongest = first;
  let value = first;
  for (const entry of priced) {
    // Strict comparisons keep the first-encountered model on price ties.
    if (entry.key > strongest.key) strongest = entry;
    if (entry.key < value.key) value = entry;
  }

  return { strongestId: strongest.model.id, valueId: value.model.id };
}
