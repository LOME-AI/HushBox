/** Content modality — shared across AIClient and model discovery. */
export type Modality = 'text' | 'image' | 'audio' | 'video';

/**
 * Raw model data merged from the AI Gateway's authenticated `/config` endpoint
 * (typed by `@ai-sdk/gateway`) and its unauthenticated public `/v1/models`
 * endpoint (not SDK-typed, source of media pricing).
 */
export interface RawModel {
  id: string;
  name: string;
  description: string;
  modality: Modality;
  context_length: number;
  pricing: {
    /** Per-input-token USD from `/config`. "0" for non-language models. */
    prompt: string;
    /** Per-output-token USD from `/config`. "0" for non-language models. */
    completion: string;
    /** Per-web-search-call USD from `/config`. Set only when provider charges separately. */
    web_search?: string;
    /** Flat per-image USD from `/v1/models` pricing.image. Absent for image models that use variable pricing. */
    per_image?: string;
    /**
     * Per-second USD by resolution, from `/v1/models` pricing.video_duration_pricing.
     * Prefers the audio:true entry per resolution (HushBox always requests audio when supported).
     * Absent for video models that use per-token pricing.
     */
    per_second_by_resolution?: Record<string, string>;
    /**
     * Flat per-second USD for audio (TTS) models, from `/v1/models` pricing.
     * Audio is single-price (no per-resolution split). Absent for audio models
     * that use variable or token-based pricing.
     */
    per_second?: string;
  };
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
