import { createEnvUtilities, type EnvContext } from '@hushbox/shared';
import { createMockAIClient } from './mock.js';
import { createRealAIClient } from './real.js';
import { requireCatalogConfig, requireInferenceConfig } from '../../lib/gateway-config.js';
import type { AIClient, MockAIClientConfig } from './types.js';
import type { EvidenceConfig } from '@hushbox/db';
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
  MockAIClientConfig,
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
 * Optional evidence-recording config bundle. When supplied, the real AI client
 * records `SERVICE_NAMES.AI_GATEWAY` evidence after each successful gateway
 * call so CI integration tests can verify the integration ran.
 *
 * `mockConfig` carries per-request mock overrides decoded from `x-mock-*`
 * request headers; only consulted in dev / E2E builds.
 */
export interface AIClientOptions {
  evidence?: EvidenceConfig;
  mockConfig?: MockAIClientConfig;
  /**
   * Optional fetch implementation. The HTTP cassette layer passes a recording
   * fetch here for CI integration tests; production omits this and the SDK
   * uses `globalThis.fetch`. Ignored by the mock client.
   */
  fetch?: typeof globalThis.fetch;
}

/**
 * Get the appropriate AIClient based on environment.
 *
 * - Local dev / E2E: Returns a fresh mock client configured from
 *   `options.mockConfig` (sourced from request headers). Stateless — no
 *   module cache, no cross-request bleed.
 * - CI integration / production: Returns the real client. Requires real
 *   credentials; fails fast if missing. Evidence recording optional.
 */
export function getAIClient(env: AIClientEnv, options: AIClientOptions = {}): AIClient {
  const { isLocalDev, isE2E } = createEnvUtilities(env);

  if (isLocalDev || isE2E) {
    // Echo typewriter paints visibly only on a running dev server. E2E and
    // vitest both land here with isLocalDev=false so they stay instant.
    const defaultTextDelayMs = isLocalDev && !isE2E ? 60 : 0;
    const mockConfig: MockAIClientConfig = {
      ...options.mockConfig,
      textDelayMs: options.mockConfig?.textDelayMs ?? defaultTextDelayMs,
    };
    return createMockAIClient(mockConfig);
  }

  return createRealAIClient({
    ...requireInferenceConfig(env as Bindings),
    ...requireCatalogConfig(env as Bindings),
    ...(options.evidence !== undefined && { evidence: options.evidence }),
    ...(options.fetch !== undefined && { fetch: options.fetch }),
  });
}
