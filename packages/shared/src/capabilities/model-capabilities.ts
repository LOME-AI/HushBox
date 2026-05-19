import { MODEL_FEATURES, type ModelFeatureId } from './types.js';
import type { Model } from '../schemas/api/models.js';

export function getModelFeatures(model: Model): ModelFeatureId[] {
  const supportedParams = new Set(model.supportedParameters);

  return Object.values(MODEL_FEATURES)
    .filter((feat) => feat.requiredParameters.every((p) => supportedParams.has(p)))
    .map((feat) => feat.id);
}

export function modelHasFeature(model: Model, featureId: ModelFeatureId): boolean {
  const feat = MODEL_FEATURES[featureId];
  const supportedParams = new Set(model.supportedParameters);
  return feat.requiredParameters.every((p) => supportedParams.has(p));
}
