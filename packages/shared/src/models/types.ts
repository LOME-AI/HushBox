/** Content modality — shared across AIClient and model discovery. */
export type Modality = 'text' | 'image' | 'audio' | 'video';

/** Raw model data mapped from the AI Gateway model metadata. */
export interface RawModel {
  id: string;
  name: string;
  description: string;
  context_length: number;
  pricing: { prompt: string; completion: string; web_search?: string };
  supported_parameters: string[];
  created: number;
  architecture: {
    input_modalities: string[];
    output_modalities: string[];
  };
}

/** Result of processing models */
export interface ProcessedModels {
  models: import('../schemas/api/models.js').Model[];
  premiumIds: string[];
}
