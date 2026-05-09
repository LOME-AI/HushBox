import type { Bindings } from '../types.js';

/**
 * Resolve the AI Gateway configuration from env bindings or fail-fast.
 *
 * Both `AI_GATEWAY_API_KEY` and `PUBLIC_MODELS_URL` are required for any
 * gateway-backed call (chat, models, trial, streaming). Routes that need them
 * call this once and let the missing-config error bubble out as a 500 — silent
 * fallbacks would let a misconfigured deployment serve stale or empty model
 * lists.
 */
export function requireGatewayConfig(env: Bindings): {
  apiKey: string;
  publicModelsUrl: string;
} {
  if (!env.AI_GATEWAY_API_KEY) throw new Error('AI_GATEWAY_API_KEY required');
  if (!env.PUBLIC_MODELS_URL) throw new Error('PUBLIC_MODELS_URL required');
  return {
    apiKey: env.AI_GATEWAY_API_KEY,
    publicModelsUrl: env.PUBLIC_MODELS_URL,
  };
}
