import { unavailableError } from '../../../lib/errors/index.js';
import { fromPromise, okAsync } from '../../../lib/result/index.js';
import type { Database } from '@hushbox/db';
import type { NewsletterSuppressReason } from '@hushbox/shared';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { NewsletterStore, NewsletterStoresFactory } from '../ports/index.js';
import type { ResendWebhookEvent } from './webhook-verify.js';

interface SuppressRecipientsParams {
  readonly store: NewsletterStore;
  readonly recipients: readonly string[];
  readonly reason: NewsletterSuppressReason;
  readonly now: Date;
}

/**
 * Applies one webhook event's suppression to every recipient it names,
 * sequentially (a Resend event rarely carries more than one). An unknown or
 * already-converged recipient is a no-op, never an error — Resend reports on
 * transactional recipients who never subscribed, and a non-2xx would only make
 * it redeliver.
 */
function suppressRecipients(params: SuppressRecipientsParams): ResultAsync<void, DomainError> {
  let chain: ResultAsync<void, DomainError> = okAsync();
  for (const email of params.recipients) {
    chain = chain.andThen(() =>
      params.store.suppress({ email, reason: params.reason, now: params.now }).map(() => undefined)
    );
  }
  return chain;
}

/** The verified event types that carry recipients to suppress. */
type ResendSuppressionEvent = Extract<
  ResendWebhookEvent,
  { readonly type: 'email.bounced' | 'email.complained' }
>;

interface ApplyWebhookSuppressionDeps {
  readonly db: Database;
  readonly stores: NewsletterStoresFactory;
}

export interface WebhookSuppressionApplication {
  /** True when this delivery won the event-id claim and ran the suppression. */
  readonly claimed: boolean;
}

/** Carrier for an expected store refusal thrown out of the transaction closure. */
class WebhookSuppressionError extends Error {
  constructor(readonly domainError: DomainError) {
    super('newsletter webhook: suppression refused');
    this.name = 'WebhookSuppressionError';
  }
}

function unwrap<T>(result: ResultAsync<T, DomainError>): Promise<T> {
  return result.match(
    (value) => value,
    (error) => {
      throw new WebhookSuppressionError(error);
    }
  );
}

/**
 * One verified suppression delivery, claim and effect in a single transaction.
 * The claim alone is not the exactly-once — a claim that committed while its
 * suppression failed would answer the provider non-2xx, and the retry it
 * provokes would lose the claim and apply nothing, permanently. Committing
 * both together also makes a multi-recipient event all-or-nothing.
 */
export function applyWebhookSuppression(
  deps: ApplyWebhookSuppressionDeps,
  event: ResendSuppressionEvent,
  now: Date
): ResultAsync<WebhookSuppressionApplication, DomainError> {
  const reason: NewsletterSuppressReason = event.type === 'email.bounced' ? 'bounce' : 'complaint';
  return fromPromise(
    deps.db.transaction(async (tx) => {
      const store = deps.stores(tx);
      const claimed = await unwrap(store.claimWebhookEvent(event.eventId));
      if (!claimed) return { claimed: false };
      await unwrap(suppressRecipients({ store, recipients: event.recipients, reason, now }));
      return { claimed: true };
    }),
    (cause) =>
      cause instanceof WebhookSuppressionError
        ? cause.domainError
        : unavailableError('newsletter webhook: suppression transaction failed', cause)
  );
}
