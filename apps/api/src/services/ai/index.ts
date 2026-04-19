import { createEnvUtilities, type EnvContext } from '@hushbox/shared';
import type { Database } from '@hushbox/db';
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
  PUBLIC_MODELS_URL?: string;
}

/**
 * Optional evidence-recording dependencies. When both are provided, the real
 * AI client records `SERVICE_NAMES.AI_GATEWAY` evidence after each successful
 * gateway call so CI integration tests can verify the integration ran.
 */
export interface AIClientOptions {
  db?: Database;
  isCI?: boolean;
}

/**
 * Get the appropriate AIClient based on environment.
 *
 * - Local dev / test: Returns mock client
 * - E2E: Returns mock client (E2E tests UI flows, not AI gateway integration)
 * - CI integration / production: Requires real credentials, fails fast if missing.
 *   If `options.db` and `options.isCI === true` are supplied, the real client
 *   records evidence after each successful call.
 */
export function getAIClient(env: AIClientEnv, options: AIClientOptions = {}): AIClient {
  const { isLocalDev, isE2E } = createEnvUtilities(env);

  if (isLocalDev || isE2E) {
    return createMockAIClient();
  }

  if (!env.AI_GATEWAY_API_KEY) {
    throw new Error('AI_GATEWAY_API_KEY required in CI/production');
  }
  if (!env.PUBLIC_MODELS_URL) {
    throw new Error('PUBLIC_MODELS_URL required in CI/production');
  }

  const evidence =
    options.db && options.isCI !== undefined ? { db: options.db, isCI: options.isCI } : undefined;

  return createRealAIClient({
    apiKey: env.AI_GATEWAY_API_KEY,
    publicModelsUrl: env.PUBLIC_MODELS_URL,
    ...(evidence !== undefined && { evidence }),
  });
}
