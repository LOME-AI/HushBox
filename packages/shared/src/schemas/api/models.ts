import { z } from 'zod';

export const modelCapabilitySchema = z.enum(['vision', 'functions', 'json-mode', 'streaming']);

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
});

export type Model = z.infer<typeof modelSchema>;

export const MOCK_MODELS: Model[] = [
  {
    id: 'openai/gpt-4-turbo',
    name: 'GPT-4 Turbo',
    provider: 'OpenAI',
    contextLength: 128000,
    pricePerInputToken: 0.00001,
    pricePerOutputToken: 0.00003,
    capabilities: ['vision', 'functions', 'json-mode', 'streaming'],
    description:
      "OpenAI's most capable model. Excels at complex reasoning, creative writing, and following nuanced instructions with high accuracy.",
    supportedParameters: [
      'temperature',
      'top_p',
      'max_tokens',
      'tools',
      'tool_choice',
      'response_format',
    ],
  },
  {
    id: 'anthropic/claude-3.5-sonnet',
    name: 'Claude 3.5 Sonnet',
    provider: 'Anthropic',
    contextLength: 200000,
    pricePerInputToken: 0.000003,
    pricePerOutputToken: 0.000015,
    capabilities: ['vision', 'functions', 'streaming'],
    description:
      "Anthropic's most intelligent model. Excels at complex reasoning, coding, and nuanced content creation with strong safety guardrails.",
    supportedParameters: ['temperature', 'top_p', 'max_tokens', 'tools', 'tool_choice'],
  },
  {
    id: 'google/gemini-pro-1.5',
    name: 'Gemini Pro 1.5',
    provider: 'Google',
    contextLength: 1000000,
    pricePerInputToken: 0.0000005,
    pricePerOutputToken: 0.0000015,
    capabilities: ['vision', 'functions', 'json-mode', 'streaming'],
    description:
      "Google's flagship model with the largest context window. Ideal for processing long documents, codebases, and multi-turn conversations.",
    supportedParameters: ['temperature', 'top_p', 'max_tokens', 'tools', 'tool_choice'],
  },
  {
    id: 'meta-llama/llama-3.1-70b-instruct',
    name: 'Llama 3.1 70B',
    provider: 'Meta',
    contextLength: 131072,
    pricePerInputToken: 0.00000059,
    pricePerOutputToken: 0.00000079,
    capabilities: ['functions', 'streaming'],
    description:
      "Meta's open-weight model offering excellent performance at low cost. Great for general tasks where budget efficiency matters.",
    supportedParameters: ['temperature', 'top_p', 'max_tokens'],
  },
];
