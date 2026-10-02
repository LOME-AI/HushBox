import { z } from 'zod';
import { conflictError, notFoundError } from '../../../../lib/errors/index.js';
import { errAsync, okAsync } from '../../../../lib/result/index.js';
import type { Database } from '@hushbox/db';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { ResultAsync } from '../../../../lib/result/index.js';
import type { BillingStores, PaymentProvider } from '../../ports/index.js';

/** The dev-only held-webhook release query: the payment whose webhook to deliver. */
export const releaseHeldWebhookQuerySchema = z.object({ paymentId: z.uuid() });

interface ReleaseHeldWebhookDeps {
  readonly db: Database;
  readonly stores: Pick<BillingStores, 'readPayment'>;
  readonly provider: PaymentProvider;
}

interface HeldWebhookRelease {
  readonly released: boolean;
}

/**
 * Delivers the confirming webhook the local payment mock held for a payment's
 * charge, addressed by the transaction id on the payment's own row, so nothing
 * about a held charge waits in the isolate between the charge and its release.
 * Where the provider cannot release a webhook — the real processor, whose
 * delivery is its own — nothing is released.
 */
export function releaseHeldPaymentWebhook(
  deps: ReleaseHeldWebhookDeps,
  paymentId: string
): ResultAsync<HeldWebhookRelease, DomainError> {
  const release = deps.provider.releaseHeldWebhook;
  if (release === undefined) {
    return okAsync({ released: false });
  }
  return deps.stores.readPayment(deps.db, paymentId).andThen((payment) => {
    if (payment === null) {
      return errAsync(notFoundError('no payment to release a webhook for'));
    }
    if (payment.helcimTransactionId === null) {
      return errAsync(conflictError('the payment has no provider transaction to confirm yet'));
    }
    return release(payment.helcimTransactionId).map((): HeldWebhookRelease => ({ released: true }));
  });
}
