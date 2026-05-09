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
 * Cached mock client. The mock holds per-test-suite state via
 * `setClassifierResolution` / `setClassifierFailure` / `addFailingModel` —
 * if `getAIClient` returned a fresh instance per request, that state would
 * never survive past the request that set it. Caching at module scope means
 * one mock per Worker isolate, so dev-endpoint calls in E2E persist into the
 * subsequent chat request. E2E suites reset state in `afterEach`.
 */
let mockClientCache: ReturnType<typeof createMockAIClient> | null = null;

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
    mockClientCache ??= createMockAIClient();
    return mockClientCache;
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
