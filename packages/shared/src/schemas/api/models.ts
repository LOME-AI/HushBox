import { z } from 'zod';

export const modelCapabilitySchema = z.enum(['internet-search']);

export type ModelCapability = z.infer<typeof modelCapabilitySchema>;

export const modelModalitySchema = z.enum(['text', 'image', 'audio', 'video']);

export type ModelModality = z.infer<typeof modelModalitySchema>;

/**
 * Schema for an AI model available through the AI Gateway.
 */
export const modelSchema = z
  .object({
    /** Unique model identifier (e.g., "openai/gpt-4-turbo") */
    id: z.string().min(1),

    /** Human-readable model name (e.g., "GPT-4 Turbo") */
    name: z.string().min(1),

    /** Provider name (e.g., "OpenAI", "Anthropic") */
    provider: z.string().min(1),

    /** Output modality of the model (text or image). Defaults to text for back-compat. */
    modality: modelModalitySchema.default('text'),

    /** Maximum context window in tokens (text models); for image models this is 0 or irrelevant. */
    contextLength: z.number().int().nonnegative(),

    /** Cost per input token in USD (text models); 0 for image models */
    pricePerInputToken: z.number().nonnegative(),

    /** Cost per output token in USD (text models); 0 for image models */
    pricePerOutputToken: z.number().nonnegative(),

    /** Cost per image in USD (image models); 0 for text models */
    pricePerImage: z.number().nonnegative().default(0),

    /**
     * Cost per second of output in USD, keyed by resolution (video models).
     * Empty for non-video models. Populated from the gateway's
     * `video_duration_pricing` array, preferring the `audio: true` entry
     * per resolution since HushBox always requests audio when supported.
     */
    pricePerSecondByResolution: z.record(z.string(), z.number().nonnegative()).default({}),

    /**
     * Flat per-second cost in USD for audio (TTS) models. 0 for non-audio
     * models. Audio is priced per-second of generated speech (no resolution
     * split, unlike video).
     */
    pricePerSecond: z.number().nonnegative().default(0),

    /** Model capabilities */
    capabilities: z.array(modelCapabilitySchema),

    /** Human-readable description of the model */
    description: z.string().min(1),

    /**
     * AI Gateway API parameters supported by this model.
     * Used to determine which capabilities can be enabled.
     * Example: ['tools', 'temperature', 'top_p', 'max_tokens']
     */
    supportedParameters: z.array(z.string()).default([]),

    /** Per-search cost in USD from AI Gateway model metadata */
    webSearchPrice: z.number().nonnegative().optional(),

    /** Unix timestamp when the model was created */
    created: z.number().optional(),

    /** Whether this model is the synthetic Smart Model router */
    isSmartModel: z.boolean().optional(),

    /** Minimum input price per token across the Smart Model's pool (for price range display) */
    minPricePerInputToken: z.number().nonnegative().optional(),

    /** Minimum output price per token across the Smart Model's pool (for price range display) */
    minPricePerOutputToken: z.number().nonnegative().optional(),

    /** Maximum input price per token across the Smart Model's pool (for price range display) */
    maxPricePerInputToken: z.number().nonnegative().optional(),

    /** Maximum output price per token across the Smart Model's pool (for price range display) */
    maxPricePerOutputToken: z.number().nonnegative().optional(),
  })
  .refine((model) => (model.modality === 'text' ? model.contextLength > 0 : true), {
    message: 'Text models must have a positive contextLength',
    path: ['contextLength'],
  });

export type Model = z.infer<typeof modelSchema>;

/**
 * Response from GET /models endpoint.
 */
export interface ModelsListResponse {
  models: Model[];
  premiumModelIds: string[];
}
