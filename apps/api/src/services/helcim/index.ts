import { createEnvUtils, type EnvContext } from '@lome-chat/shared';
import type { HelcimClient } from './types.js';
import { createMockHelcimClient } from './mock.js';
import { createHelcimClient } from './helcim.js';

export type {
  HelcimClient,
  MockHelcimClient,
  ProcessPaymentRequest,
  ProcessPaymentResponse,
} from './types.js';
export { createMockHelcimClient } from './mock.js';
export { createHelcimClient, verifyWebhookSignatureAsync } from './helcim.js';

interface HelcimEnv extends EnvContext {
  HELCIM_API_TOKEN?: string;
  HELCIM_WEBHOOK_VERIFIER?: string;
}

/**
 * Get the appropriate Helcim client based on environment.
 *
 * - Local dev: Returns mock client (silent)
 * - CI/Production: Requires real credentials, fails fast if missing
 */
export function getHelcimClient(env: HelcimEnv): HelcimClient {
  const { isLocalDev, isCI } = createEnvUtils(env);

  console.log(
    `[Helcim] env.CI=${String(env.CI)}, isCI=${String(isCI)}, isLocalDev=${String(isLocalDev)}`
  );

  if (isLocalDev) {
    return createMockHelcimClient();
  }

  if (!env.HELCIM_API_TOKEN || !env.HELCIM_WEBHOOK_VERIFIER) {
    throw new Error('HELCIM_API_TOKEN and HELCIM_WEBHOOK_VERIFIER required in CI/production');
  }

  return createHelcimClient({
    apiToken: env.HELCIM_API_TOKEN,
    webhookVerifier: env.HELCIM_WEBHOOK_VERIFIER,
  });
}
