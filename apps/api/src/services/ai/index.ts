import { createEnvUtilities, type EnvContext } from '@hushbox/shared';
import { createMockAIClient } from './mock.js';
import { createRealAIClient } from './real.js';
import { requireGatewayConfig } from '../../lib/gateway-config.js';
import type { AIClient } from './types.js';
import type { Database } from '@hushbox/db';
import type { Bindings } from '../../types.js';

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
  RecordedInferenceRequest,
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

  // The only non-test caller of requireGatewayConfig: every route now reads
  // model data via aiClient.listRawModels(), so the env fork above is the
  // single point that decides mock vs real. Missing AI_GATEWAY_API_KEY only
  // fails the request when the runtime is past the mock branch (i.e. CI
  // Vitest or production), which matches the env config's intent.
  const { apiKey, publicModelsUrl } = requireGatewayConfig(env as Bindings);

  const evidence =
    options.db && options.isCI !== undefined ? { db: options.db, isCI: options.isCI } : undefined;

  return createRealAIClient({
    apiKey,
    publicModelsUrl,
    ...(evidence !== undefined && { evidence }),
  });
}
