import { createEnvUtilities, type EnvContext } from '@hushbox/shared';
import type { OpenRouterClient } from './types.js';
import { createMockOpenRouterClient } from './mock.js';
import { createOpenRouterClient, type EvidenceConfig } from './openrouter.js';

export type {
  ChatMessage,
  ChatCompletionRequest,
  ChatCompletionResponse,
  GenerationStats,
  ModelInfo,
  MockOpenRouterClient,
  OpenRouterClient,
  ToolCall,
  ToolDefinition,
  ZdrEndpoint,
} from './types.js';

export type { EvidenceConfig } from './openrouter.js';

export { createMockOpenRouterClient } from './mock.js';
export { createOpenRouterClient, fetchModels, fetchZdrModelIds, getModel } from './openrouter.js';

interface OpenRouterEnv extends EnvContext {
  OPENROUTER_API_KEY?: string;
}

/**
 * Get the appropriate OpenRouter client based on environment.
 *
 * - Local dev: Returns mock client (silent)
 * - CI E2E: Returns mock client (E2E tests UI flows, not OpenRouter integration)
 * - CI Integration/Production: Requires real credentials, fails fast if missing
 */
export function getOpenRouterClient(
  env: OpenRouterEnv,
  evidenceConfig?: EvidenceConfig
): OpenRouterClient {
  const { isLocalDev, isE2E } = createEnvUtilities(env);

  // E2E tests use mocks - they test UI flows, not OpenRouter integration
  if (isLocalDev || isE2E) {
    return createMockOpenRouterClient();
  }

  if (!env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY required in CI/production');
  }

  return createOpenRouterClient(env.OPENROUTER_API_KEY, evidenceConfig);
}
