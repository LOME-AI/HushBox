import * as React from 'react';
import { useModels } from '@/hooks/models/models';
import { assignModelSwatches, modelSwatch } from '@/lib/utils/model-color';
import type { ModelSwatch } from '@hushbox/shared/design-tokens';

interface UsageModelLabels {
  name: (modelId: string) => string;
  swatch: (modelId: string) => ModelSwatch;
}

/** The models the usage page's blocks show for the current range; empty outside the page. */
export const UsageModelSet = React.createContext<readonly string[]>([]);

/**
 * How the usage page names and colours a model, the same in every block. The
 * swatches are assigned once over the models the page shows, sorted, so no two
 * of them share a colour while swatches last; assigning per block could give
 * one model two colours, since the assignment moves a colliding model within
 * its own set. A model's colour can change with the range.
 */
export function useUsageModelLabels(): UsageModelLabels {
  const { data: catalog } = useModels();
  const pageModels = React.use(UsageModelSet);

  const names = React.useMemo(
    () => new Map(catalog?.models.map((model) => [model.id, model.name])),
    [catalog]
  );
  const swatches = React.useMemo(
    () => assignModelSwatches(pageModels.toSorted((a, b) => a.localeCompare(b))),
    [pageModels]
  );

  return React.useMemo(
    () => ({
      name: (modelId) => names.get(modelId) ?? modelId,
      swatch: (modelId) => swatches.get(modelId) ?? modelSwatch(modelId),
    }),
    [names, swatches]
  );
}
