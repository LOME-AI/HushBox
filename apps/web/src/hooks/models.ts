import { useQuery } from '@tanstack/react-query';
import type { Model, ModelsListResponse, Modality } from '@hushbox/shared';
import {
  STRONGEST_TEXT_MODEL_ID,
  VALUE_TEXT_MODEL_ID,
  STRONGEST_IMAGE_MODEL_ID,
  VALUE_IMAGE_MODEL_ID,
  STRONGEST_VIDEO_MODEL_ID,
  VALUE_VIDEO_MODEL_ID,
  SMART_MODEL_ID,
  getModelCostPer1k,
} from '@hushbox/shared';
import { client, fetchJson } from '../lib/api-client.js';

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
      const response = await fetchJson<ModelsListResponse>(client.api.models.$get());
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

/**
 * Fallback for non-premium text users: derive strongest (most expensive basic)
 * and value (cheapest basic) from the actual models list.
 */
function findStrongestAndValueBasicTextModels(
  models: Model[],
  premiumIds: Set<string>
): { strongestId: string; valueId: string } {
  const basicModels = models.filter(
    (m) => m.modality === 'text' && !premiumIds.has(m.id) && m.id !== SMART_MODEL_ID
  );
  if (basicModels.length === 0) {
    const fallback = models.find((m) => m.modality === 'text')?.id ?? '';
    return { strongestId: fallback, valueId: fallback };
  }

  const sorted = [...basicModels].toSorted((a, b) => {
    const priceA = getModelCostPer1k(a.pricePerInputToken, a.pricePerOutputToken);
    const priceB = getModelCostPer1k(b.pricePerInputToken, b.pricePerOutputToken);
    return priceB - priceA;
  });

  return {
    strongestId: sorted[0]?.id ?? '',
    valueId: sorted.at(-1)?.id ?? '',
  };
}

const PREMIUM_PINS: Record<Modality, { strongestId: string; valueId: string }> = {
  text: { strongestId: STRONGEST_TEXT_MODEL_ID, valueId: VALUE_TEXT_MODEL_ID },
  image: { strongestId: STRONGEST_IMAGE_MODEL_ID, valueId: VALUE_IMAGE_MODEL_ID },
  video: { strongestId: STRONGEST_VIDEO_MODEL_ID, valueId: VALUE_VIDEO_MODEL_ID },
  audio: { strongestId: '', valueId: '' },
};

/**
 * Per-modality strongest/value quick-select pins.
 *
 * Premium (paid) users get the hard-coded per-modality pins. Non-premium users
 * can't access media modalities at all (all media models are classified as
 * premium in `processModels`), so only the text fallback matters — it derives
 * strongest/value from the user's accessible basic-tier text models.
 */
export function getAccessibleModelIds(
  models: Model[],
  premiumIds: Set<string>,
  canAccessPremium: boolean,
  modality: Modality = 'text'
): { strongestId: string; valueId: string } {
  if (canAccessPremium) return PREMIUM_PINS[modality];
  if (modality === 'text') return findStrongestAndValueBasicTextModels(models, premiumIds);
  return { strongestId: '', valueId: '' };
}
