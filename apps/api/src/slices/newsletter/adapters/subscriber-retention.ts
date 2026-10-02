import { and, eq, inArray, notExists, sql } from 'drizzle-orm';
import { newsletterDeliveries, newsletterSubscribers } from '@hushbox/db';
import { NEWSLETTER_CONFIRM_TTL_MS } from '@hushbox/shared';
import type { DbWriter } from '../../../lib/idempotency/index.js';

/**
 * How long a `pending` signup outlives its own confirm credential before the
 * row goes. The address and the consent IP on it were recorded from an
 * unauthenticated form, so until someone confirms, nothing establishes that
 * the address owner asked for any of it; once the credential behind the row
 * has expired, the row is personal data held on nobody's word.
 *
 * The grace is the credential's own lifetime rather than a second figure, so
 * the two cannot drift, and a resend moves `confirmExpiresAt` forward — which
 * restarts this clock for anyone still deciding.
 */
export const UNCONFIRMED_SUBSCRIBER_GRACE_MS = NEWSLETTER_CONFIRM_TTL_MS;

const GRACE_SECONDS = UNCONFIRMED_SUBSCRIBER_GRACE_MS / 1000;

interface UnconfirmedSubscriberPurgeParams {
  readonly batchSize: number;
}

/**
 * Deletes one bounded batch of expired unconfirmed signups; returns how many
 * went. `status = 'pending'` is not the whole guard: a lapsed address that
 * signed up again is back at `pending` while its earlier `newsletter_deliveries`
 * rows stand, and those are kept forever as the duplicate-send referee, under a
 * `NO ACTION` reference that refuses the parent delete. Selecting such a row
 * would raise `23503` and abort the whole batch on every pass thereafter, so a
 * subscriber owning any delivery is never a candidate — it consented and was
 * lawfully mailed, which is not the population this purge exists to shed.
 * A confirmed row keeps the `confirmExpiresAt` it was confirmed against, so age
 * alone would reach subscribers.
 */
export async function purgeUnconfirmedSubscribers(
  writer: DbWriter,
  params: UnconfirmedSubscriberPurgeParams
): Promise<number> {
  const expired = writer
    .select({ id: newsletterSubscribers.id })
    .from(newsletterSubscribers)
    .where(
      and(
        eq(newsletterSubscribers.status, 'pending'),
        sql`${newsletterSubscribers.confirmExpiresAt} < now() - make_interval(secs => ${GRACE_SECONDS})`,
        notExists(
          writer
            .select({ one: sql`1` })
            .from(newsletterDeliveries)
            .where(eq(newsletterDeliveries.subscriberId, newsletterSubscribers.id))
        )
      )
    )
    .limit(params.batchSize);
  const deleted = await writer
    .delete(newsletterSubscribers)
    .where(inArray(newsletterSubscribers.id, expired))
    .returning({ id: newsletterSubscribers.id });
  return deleted.length;
}
