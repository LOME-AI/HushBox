import * as React from 'react';

import {
  filterBySearch,
  sortModels,
  sortByPopularity,
  interlaceModels,
  buildModelResultList,
  type SortField,
  type SortDirection,
} from '@/components/chat/model-selector/model-selector-helpers';
import type { Model, ChatModality } from '@hushbox/shared';

interface UseFilteredModelsOptions {
  models: Model[];
  searchQuery: string;
  sortField: SortField;
  sortDirection: SortDirection;
  /**
   * Whether a row is selectable, and nothing more: the ordering needs a
   * per-row yes or no, never the funding, tier or effort arithmetic that
   * produced it. The modal owns the verdict and is its single source, so this
   * is threaded in rather than recomputed here.
   */
  isModelAvailable: (modelId: string) => boolean;
  strongestId: string;
  valueId: string;
  /** Only show models matching this modality. Defaults to 'text'. */
  activeModality?: ChatModality | undefined;
}

export interface FilteredModels {
  /** The rows to render, after modality, search, sort and pinning. */
  models: Model[];
  /**
   * No model carries the active modality AT ALL — the capability is missing,
   * not narrowed. Read before the search filter, which is the whole point: an
   * empty `models` reached by a search that matched nothing is user error and
   * must never be reported as a missing capability.
   */
  modalityIsEmpty: boolean;
}

export function useFilteredModels({
  models,
  searchQuery,
  sortField,
  sortDirection,
  isModelAvailable,
  strongestId,
  valueId,
  activeModality = 'text',
}: UseFilteredModelsOptions): FilteredModels {
  return React.useMemo(() => {
    const isDefault = sortField === null && !searchQuery.trim();

    // Filter to models matching the active modality. Smart Model is text-only.
    const modalityFiltered = models.filter((m) => m.modality === activeModality);
    const smartModel =
      activeModality === 'text' ? modalityFiltered.find((m) => m.isSmartModel === true) : undefined;
    const nonSmartModels = modalityFiltered.filter((m) => m.isSmartModel !== true);

    const result = filterBySearch(nonSmartModels, searchQuery);
    const ordered = isDefault
      ? sortByPopularity(result)
      : sortModels(result, sortField, sortDirection, activeModality);
    const interlaced = interlaceModels(ordered, isModelAvailable);

    return {
      models: buildModelResultList({ interlaced, smartModel, strongestId, valueId }),
      modalityIsEmpty: modalityFiltered.length === 0,
    };
  }, [
    models,
    searchQuery,
    sortField,
    sortDirection,
    isModelAvailable,
    strongestId,
    valueId,
    activeModality,
  ]);
}
