import { MAX_SELECTED_MODELS, nanoUnitPriceUsd, shortenModelName } from '@hushbox/shared';
import { formatContextLength } from '@hushbox/shared';
import { priceDisplayOf, SMART_MODEL_ROLE } from '@/lib/chat/model-info-facts';

import type { PickerMode } from '@/stores/model';
import type { Model, ChatModality } from '@hushbox/shared';

export type SortField = 'price' | 'context' | null;
export type SortDirection = 'asc' | 'desc';

export function filterBySearch(models: Model[], query: string): Model[] {
  if (!query.trim()) {
    return models;
  }
  const lowerQuery = query.toLowerCase();
  return models.filter(
    (model) =>
      model.name.toLowerCase().includes(lowerQuery) ||
      model.provider.toLowerCase().includes(lowerQuery)
  );
}

export function resolveModality(activeModality: ChatModality | undefined): ChatModality {
  return activeModality ?? 'text';
}

// The price a row is sorted by, from the one display producer: a text row's
// base input rate, an image row's per-image rate, a video row's cheapest
// per-second rate. Rates are billable — fees are baked into every catalog rate
// at ingestion — so this already IS the customer-facing price. `undefined` is a
// row with no price in the sorted modality's unit — an absence, not a rate of
// zero; an audio row has none, so every audio row ties.
function priceSortKey(model: Model, modality: ChatModality): bigint | undefined {
  if (model.modality !== modality) return undefined;
  const display = priceDisplayOf(model);
  return modality === 'text' ? display.inputNanoUsd : display.sortKeyNanoUsd;
}

function compareBigint(a: bigint, b: bigint): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * Price ordering. An unpriced model sorts last in BOTH directions: with no rate
 * it is neither the cheapest nor the dearest, and the direction is applied only
 * to the priced pair so reversing the order cannot move it to an end. This is
 * display order alone — no funding decision reads it.
 */
function comparePrices(
  a: Model,
  b: Model,
  modality: ChatModality,
  direction: SortDirection
): number {
  const keyA = priceSortKey(a, modality);
  const keyB = priceSortKey(b, modality);
  if (keyA === undefined || keyB === undefined) {
    if (keyA === undefined && keyB === undefined) return 0;
    return keyA === undefined ? 1 : -1;
  }
  const comparison = compareBigint(keyA, keyB);
  return direction === 'asc' ? comparison : -comparison;
}

export function sortModels(
  models: Model[],
  sortField: SortField,
  sortDirection: SortDirection,
  activeModality: ChatModality
): Model[] {
  if (!sortField) {
    return models;
  }
  return [...models].toSorted((a, b) => {
    if (sortField === 'price') return comparePrices(a, b, activeModality, sortDirection);
    const comparison = a.contextLength - b.contextLength;
    return sortDirection === 'asc' ? comparison : -comparison;
  });
}

// Default-view ordering: most-used models first. `popularityRank` is 0-based
// (lower = more used); unranked models (undefined, e.g. media) sort last.
// `toSorted` is stable, so equal or both-undefined ranks keep input order.
export function sortByPopularity(models: Model[]): Model[] {
  const rankOf = (model: Model): number => model.popularityRank ?? Infinity;
  return models.toSorted((a, b) => rankOf(a) - rankOf(b));
}

// Surface the available rows that have no greyed row to pair with above the
// interleaved available/greyed pairs, so a user sees what they can use first
// rather than trailing at the bottom; a greyed surplus falls below the pairs.
// Both lists keep the order they arrived in.
function zipAvailableFirst(available: Model[], greyed: Model[]): Model[] {
  const leftoverAvailable = available.slice(greyed.length);
  const pairs: Model[] = [];
  for (const [index, greyedModel] of greyed.entries()) {
    const availableModel = available[index];
    if (availableModel) pairs.push(availableModel);
    pairs.push(greyedModel);
  }
  return [...leftoverAvailable, ...pairs];
}

/**
 * Splits on the row's availability verdict — the one fact that greys a row —
 * never on premium membership. The two coincided only while premium was the
 * sole thing that could refuse a row: an effort cap, a funding shortfall or an
 * unpriceable rate greys a row no tier locks, and greys rows for a payer whose
 * tier reaches every premium model.
 */
export function interlaceModels(
  models: Model[],
  isAvailable: (modelId: string) => boolean
): Model[] {
  const available = models.filter((m) => isAvailable(m.id));
  const greyed = models.filter((m) => !isAvailable(m.id));
  return zipAvailableFirst(available, greyed);
}

export function modelSubtitle(model: Model): string {
  if (model.isSmartModel === true) {
    return SMART_MODEL_ROLE;
  }
  switch (model.modality) {
    case 'text': {
      return `${model.provider} • Capacity: ${formatContextLength(model.contextLength)}`;
    }
    case 'image': {
      const perImage = priceDisplayOf(model).perImageNanoUsd;
      return perImage === undefined
        ? model.provider
        : `${model.provider} • ${nanoUnitPriceUsd(perImage, 3)}/image`;
    }
    case 'video': {
      // A video row's sort key is its cheapest per-second rate, the figure shown.
      const cheapest = priceDisplayOf(model).sortKeyNanoUsd;
      return cheapest === undefined
        ? model.provider
        : `${model.provider} • ${nanoUnitPriceUsd(cheapest, 2)}/s`;
    }
    case 'audio': {
      // Audio carries no wire pricing dimension; show the provider only.
      return model.provider;
    }
  }
}

export function expandedRowButtonLabel(
  pickerMode: PickerMode,
  isSelected: boolean,
  modelName: string
): string {
  if (pickerMode === 'single') return `Use ${shortenModelName(modelName)}`;
  if (isSelected) return 'Remove from selection';
  return 'Add to selection';
}

/**
 * Assembles the final model list: Smart Model first (when present), then the
 * pinned quick-select models, then the remaining interlaced list. Pinning is
 * view-independent — a search or a sort reorders what reaches this stage, never
 * whether the pins are hoisted — so a pin the search excluded is simply absent.
 * Keeps `useFilteredModels` focused on filtering/sorting.
 */
export function buildModelResultList(params: {
  interlaced: Model[];
  smartModel: Model | undefined;
  strongestId: string;
  valueId: string;
}): Model[] {
  const { interlaced, smartModel, strongestId, valueId } = params;
  const smartPrefix = smartModel ? [smartModel] : [];
  const pinnedIds = [...new Set([strongestId, valueId])];
  const pinned = pinnedIds
    .map((id) => interlaced.find((m) => m.id === id))
    .filter((m): m is Model => m !== undefined);
  const remaining = interlaced.filter((m) => !pinnedIds.includes(m.id));
  return [...smartPrefix, ...pinned, ...remaining];
}

export function getPinnedLabelForModel(
  modelId: string,
  strongestId: string,
  valueId: string
): string | undefined {
  if (modelId === strongestId) return 'Strongest';
  if (modelId === valueId) return 'Best value';
  return undefined;
}

export function toggleSortDirection(direction: SortDirection): SortDirection {
  return direction === 'asc' ? 'desc' : 'asc';
}

export function buildSelectedEntries(
  selectedIds: Set<string>,
  models: Model[]
): { id: string; name: string }[] {
  return [...selectedIds]
    .map((id) => {
      const model = models.find((m) => m.id === id);
      return model ? { id: model.id, name: model.name } : null;
    })
    .filter((entry): entry is { id: string; name: string } => entry !== null);
}

export function updateSelectedIds(previous: Set<string>, modelId: string): Set<string> {
  const next = new Set(previous);
  if (next.has(modelId)) {
    next.delete(modelId);
  } else {
    if (next.size >= MAX_SELECTED_MODELS) return previous;
    next.add(modelId);
  }
  return next;
}

export function initialFocusedId(selectedIds: Set<string>, models: Model[]): string {
  const firstSelected = selectedIds.values().next().value;
  if (firstSelected !== undefined) return firstSelected;
  return models[0]?.id ?? '';
}
