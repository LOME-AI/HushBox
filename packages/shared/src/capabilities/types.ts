/**
 * Model feature IDs — high-level capabilities derived from a model's
 * `supportedParameters` (e.g. "this model can run code because it supports
 * the 'tools' parameter"). Distinct from the input parameter axes
 * (`supportedAspectRatios`, `supportedResolutions`, etc. in
 * `@hushbox/shared/models`) which describe what input *values* a model
 * accepts, not what high-level *things* it can do.
 */
export type ModelFeatureId = 'python-execution' | 'javascript-execution' | 'vision';

export interface ModelFeature {
  id: ModelFeatureId;
  name: string;
  description: string;

  /**
   * AI Gateway model parameters required for this feature.
   * Feature is only available if all parameters are in the model's supported_parameters.
   */
  requiredParameters: string[];
}

export const MODEL_FEATURES: Record<ModelFeatureId, ModelFeature> = {
  'python-execution': {
    id: 'python-execution',
    name: 'Python Execution',
    description: 'Run Python code in a secure sandbox',
    requiredParameters: ['tools'],
  },
  'javascript-execution': {
    id: 'javascript-execution',
    name: 'JavaScript Execution',
    description: 'Run JavaScript code in a secure sandbox',
    requiredParameters: ['tools'],
  },
  vision: {
    id: 'vision',
    name: 'Vision',
    description: 'Analyze and understand images',
    requiredParameters: [],
  },
};

export const MODEL_FEATURE_IDS = Object.keys(MODEL_FEATURES) as ModelFeatureId[];
