import { pgTable, check, index, inet, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { NEWSLETTER_DEFAULT_TOPIC } from '@hushbox/shared';

import {
  newsletterConsentSourceEnum,
  newsletterStatusEnum,
  newsletterSuppressReasonEnum,
} from './enums';
import { users } from './users';

/**
 * Mailing-list subscriptions, topic-keyed so a second list is a data change.
 * `userId` is ON DELETE SET NULL: the subscription is separate consent that
 * survives account deletion — unsubscribing is its own explicit act. The
 * consent columns (source, IP, text version) are the CAN-SPAM/GDPR evidence
 * of exactly what was agreed to and from where.
 *
 * So `email` and the consent columns are personal data that outlives a hard
 * account deletion, deliberately: a subscription is keyed on the address rather
 * than on a user, most subscribers never had an account, and ending one on a
 * subscriber's behalf is a decision they did not make — unsubscribing is the act
 * that makes it. Erasing the evidence would also leave the sends before it
 * unaccounted for.
 */
export const newsletterSubscribers = pgTable(
  'newsletter_subscribers',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    email: text('email').notNull(),
    topic: text('topic').notNull().default(NEWSLETTER_DEFAULT_TOPIC),
    status: newsletterStatusEnum('status').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    consentSource: newsletterConsentSourceEnum('consent_source').notNull(),
    consentIp: inet('consent_ip').notNull(),
    consentTextVersion: text('consent_text_version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    unsubscribedAt: timestamp('unsubscribed_at', { withTimezone: true }),
    suppressedAt: timestamp('suppressed_at', { withTimezone: true }),
    suppressReason: newsletterSuppressReasonEnum('suppress_reason'),
    confirmToken: text('confirm_token').unique(),
    confirmExpiresAt: timestamp('confirm_expires_at', { withTimezone: true }),
    confirmSentAt: timestamp('confirm_sent_at', { withTimezone: true }),
    unsubscribeToken: text('unsubscribe_token').notNull().unique(),
  },
  (table) => [
    unique('newsletter_subscribers_email_topic_unique').on(table.email, table.topic),
    index('newsletter_subscribers_user_id_idx').on(table.userId),
    // Dispatch freezes a recipient list with WHERE topic = $1 AND status =
    // 'subscribed'; no other index leads with either column.
    index('newsletter_subscribers_topic_status_idx').on(table.topic, table.status),
    // Suppression is one fact in two columns: a reason without a time is a
    // suppression nothing dates, a time without a reason one nothing explains.
    check(
      'newsletter_subscribers_suppression_consistency',
      sql`(${table.suppressedAt} IS NULL) = (${table.suppressReason} IS NULL)`
    ),
  ]
);
