import { z } from 'zod';

export const modelCapabilitySchema = z.enum(['internet-search']);

export type ModelCapability = z.infer<typeof modelCapabilitySchema>;

/**
 * Schema for an AI model available through OpenRouter.
 */
export const modelSchema = z.object({
  /** Unique model identifier (e.g., "openai/gpt-4-turbo") */
  id: z.string().min(1),

  /** Human-readable model name (e.g., "GPT-4 Turbo") */
  name: z.string().min(1),

  /** Provider name (e.g., "OpenAI", "Anthropic") */
  provider: z.string().min(1),

  /** Maximum context window in tokens */
  contextLength: z.number().int().positive(),

  /** Cost per input token in USD */
  pricePerInputToken: z.number().nonnegative(),

  /** Cost per output token in USD */
  pricePerOutputToken: z.number().nonnegative(),

  /** Model capabilities */
  capabilities: z.array(modelCapabilitySchema),

  /** Human-readable description of the model */
  description: z.string().min(1),

  /**
   * OpenRouter API parameters supported by this model.
   * Used to determine which capabilities can be enabled.
   * Example: ['tools', 'temperature', 'top_p', 'max_tokens']
   */
  supportedParameters: z.array(z.string()).default([]),

  /** Per-search cost in USD from OpenRouter metadata */
  webSearchPrice: z.number().nonnegative().optional(),

  /** Unix timestamp when the model was created */
  created: z.number().optional(),

  /** Whether this model is the auto-router (Smart Model) */
  isAutoRouter: z.boolean().optional(),

  /** Minimum input price per token across the auto-router's model pool (for price range display) */
  minPricePerInputToken: z.number().nonnegative().optional(),

  /** Minimum output price per token across the auto-router's model pool (for price range display) */
  minPricePerOutputToken: z.number().nonnegative().optional(),

  /** Maximum input price per token across the auto-router's model pool (for price range display) */
  maxPricePerInputToken: z.number().nonnegative().optional(),

  /** Maximum output price per token across the auto-router's model pool (for price range display) */
  maxPricePerOutputToken: z.number().nonnegative().optional(),
});

export type Model = z.infer<typeof modelSchema>;

/**
 * Response from GET /models endpoint.
 */
export interface ModelsListResponse {
  models: Model[];
  premiumModelIds: string[];
}
