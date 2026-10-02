import { SMART_MODEL_ID } from '@hushbox/shared';
import type { Model } from '@hushbox/shared';

/** The catalog's real models: the Smart Model routes to them, so it is not one of them. */
export function catalogModels(models: readonly Model[]): Model[] {
  return models.filter((model) => model.id !== SMART_MODEL_ID);
}
