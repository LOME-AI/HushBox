import { createEnvUtilities } from '@hushbox/shared';
import { createHelcimPaymentProvider } from './payment-helcim.js';
import { createMockPaymentProvider } from './payment-mock.js';
import type { EnvContext } from '@hushbox/shared';
import type { Database } from '@hushbox/db';
import type {
  PaymentMockDirectives,
  PaymentProvider,
  WebhookDeliveryLifetime,
} from '../ports/index.js';

/**
 * Where the payment webhook route mounts: the billing slice's base path plus the
 * route it registers in `apps/api/src/slices/billing/routes.ts`. Hidden coupling —
 * this module's colocated test pins it against the assembled app's route table,
 * because the local mock discards the delivery response and a stale value here is
 * otherwise a silent 404 that strands every local deposit in `awaiting_webhook`.
 */
const WEBHOOK_PATH = '/billing/webhooks/payment';

interface PaymentProviderEnv extends EnvContext {
  HELCIM_API_TOKEN?: string;
  HELCIM_WEBHOOK_VERIFIER?: string;
  API_URL?: string;
}

interface PaymentProviderFactoryOptions {
  /**
   * Threaded only to the local mock so it can register its self-delivered
   * webhook on the request lifetime. The real Helcim provider never receives
   * it — the production path is unchanged.
   */
  readonly executionCtx?: WebhookDeliveryLifetime | undefined;
  /** Threaded only to the local mock; the real Helcim provider never receives them. */
  readonly mockDirectives?: PaymentMockDirectives | undefined;
}

/**
 * envUtils-gated provider selection: local dev gets the in-process mock
 * (signed webhooks against the local route), everything else gets the real
 * Helcim adapter. Missing config fails fast — there is no degraded mode.
 */
export function createPaymentProviderFromEnv(
  env: PaymentProviderEnv,
  db?: Database,
  options: PaymentProviderFactoryOptions = {}
): PaymentProvider {
  // Explicit fail-fast at the selection seam (envUtils still owns all mode
  // branching): createEnvUtilities throws on an absent NODE_ENV, and this guard
  // restates that with a provider-specific message so a production deploy that
  // omitted it fails loudly instead of ever risking the mock — which approves
  // every charge for free and self-delivers validly signed webhooks. Selecting a
  // payment provider on an unset variable is exactly the fallback CODE-RULES forbids.
  if (env.NODE_ENV === undefined) {
    throw new Error('NODE_ENV must be set explicitly to select a payment provider');
  }

  const { isLocalDev, isCI } = createEnvUtilities(env);

  if (isLocalDev) {
    if (env.API_URL === undefined || env.HELCIM_WEBHOOK_VERIFIER === undefined) {
      throw new Error(
        'API_URL and HELCIM_WEBHOOK_VERIFIER are required for the local payment mock'
      );
    }
    return createMockPaymentProvider({
      webhookUrl: `${env.API_URL}${WEBHOOK_PATH}`,
      webhookVerifier: env.HELCIM_WEBHOOK_VERIFIER,
      // `undefined` and absent are equivalent — the mock reads
      // `config.executionCtx?.waitUntil`, so no branch is needed here.
      executionCtx: options.executionCtx,
      holdWebhook: options.mockDirectives?.holdWebhook === true,
    });
  }

  if (env.HELCIM_API_TOKEN === undefined) {
    throw new Error('HELCIM_API_TOKEN is required outside local dev');
  }

  // The mock never receives db — only the real adapter records evidence, and
  // only when a db is wired (CI-gated inside `recordServiceEvidence`).
  return createHelcimPaymentProvider({
    apiToken: env.HELCIM_API_TOKEN,
    ...(db === undefined ? {} : { db, isCI }),
  });
}
