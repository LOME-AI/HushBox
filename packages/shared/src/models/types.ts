/** Raw model data from OpenRouter API */
export interface OpenRouterModel {
  id: string;
  name: string;
  description: string;
  context_length: number;
  pricing: { prompt: string; completion: string };
  supported_parameters: string[];
  created: number;
  architecture: {
    input_modalities: string[];
    output_modalities: string[];
  };
}

/**
 * Entry from OpenRouter's /endpoints/zdr endpoint.
 * Represents a model/provider combo that supports Zero Data Retention.
 */
export interface ZdrEndpoint {
  model_id: string;
  model_name: string;
  provider_name: string;
  context_length: number;
  pricing: { prompt: string; completion: string };
}

/** Result of processing models */
export interface ProcessedModels {
  models: import('../schemas/api/models.js').Model[];
  premiumIds: string[];
}
