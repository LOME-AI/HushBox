import { createEnvUtilities, type EnvContext } from '@hushbox/shared';
import type { AIClient } from './types.js';
import { createMockAIClient } from './mock.js';
import { createRealAIClient } from './real.js';

export type {
  AIClient,
  AIMessage,
  AudioRequest,
  ImageRequest,
  InferenceEvent,
  InferenceRequest,
  InferenceStream,
  MessageContentPart,
  MockAIClient,
  Modality,
  ModelCapability,
  ModelInfo,
  ModelPricing,
  ProviderMetadata,
  TextRequest,
  ToolDefinition,
  VideoRequest,
} from './types.js';

export { createMockAIClient } from './mock.js';

interface AIClientEnv extends EnvContext {
  AI_GATEWAY_API_KEY?: string;
}

/**
 * Get the appropriate AIClient based on environment.
 *
 * - Local dev / test: Returns mock client
 * - E2E: Returns mock client (E2E tests UI flows, not AI gateway integration)
 * - CI integration / production: Requires real credentials, fails fast if missing
 *
 * Note: The real AIClient implementation (real.ts) will be added in Step 3
 * when we migrate from OpenRouter to the Vercel AI SDK.
 */
export function getAIClient(env: AIClientEnv): AIClient {
  const { isLocalDev, isE2E } = createEnvUtilities(env);

  if (isLocalDev || isE2E) {
    return createMockAIClient();
  }

  if (!env.AI_GATEWAY_API_KEY) {
    throw new Error('AI_GATEWAY_API_KEY required in CI/production');
  }

  return createRealAIClient(env.AI_GATEWAY_API_KEY);
}
