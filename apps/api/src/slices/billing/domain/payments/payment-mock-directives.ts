import type { EnvUtilities } from '@hushbox/shared';
import type { PaymentMockDirectives } from '../../ports/index.js';

const HOLD_WEBHOOK_HEADER = 'x-mock-hold-payment-webhook';

/**
 * The charge request's directives to the local payment mock. `isLocalDev` is
 * the gate the provider factory selects the mock on, so a header is read only
 * where the mock takes the charge; everywhere else a request carrying it is
 * never read, and the factory re-gates on the same flag before threading
 * anything to a provider.
 */
export function paymentMockDirectivesFor(
  env: Pick<EnvUtilities, 'isLocalDev'>,
  get: (name: string) => string | undefined
): PaymentMockDirectives {
  return env.isLocalDev && get(HOLD_WEBHOOK_HEADER) === 'true' ? { holdWebhook: true } : {};
}
