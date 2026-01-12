import { createEnvUtils, type EnvContext } from '@lome-chat/shared';
import type { OpenRouterClient } from './types.js';
import { createMockOpenRouterClient } from './mock.js';
import { createOpenRouterClient } from './openrouter.js';

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
} from './types.js';

export { createMockOpenRouterClient } from './mock.js';
export { createOpenRouterClient, clearModelCache, fetchModels, getModel } from './openrouter.js';

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
export function getOpenRouterClient(env: OpenRouterEnv): OpenRouterClient {
  const { isLocalDev, isE2E } = createEnvUtils(env);

  // E2E tests use mocks - they test UI flows, not OpenRouter integration
  if (isLocalDev || isE2E) {
    return createMockOpenRouterClient();
  }

  if (!env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY required in CI/production');
  }

  return createOpenRouterClient(env.OPENROUTER_API_KEY);
}
