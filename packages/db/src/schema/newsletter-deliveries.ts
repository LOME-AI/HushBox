import { pgTable, index, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { newsletterDeliveryStatusEnum } from './enums';
import { newsletterIssues } from './newsletter-issues';
import { newsletterSubscribers } from './newsletter-subscribers';

/**
 * Per-recipient send record, kept forever (founder ruling — no retention
 * hook). Both FKs take the default NO ACTION (admin_audit.undoes precedent):
 * a delivery row must never be orphaned or cascaded away, so a parent delete
 * is refused instead. Issues are never deleted. Subscribers are — the daily
 * retention purge deletes expired `pending` signups — and a `pending` row is
 * not necessarily childless: an address that lapsed and signed up again is
 * returned to `pending` with its earlier delivery rows standing, and this FK
 * is what refuses that delete rather than losing them.
 * The UNIQUE(issueId, subscriberId) claim makes each send exactly-once.
 */
export const newsletterDeliveries = pgTable(
  'newsletter_deliveries',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => newsletterIssues.id),
    subscriberId: uuid('subscriber_id')
      .notNull()
      .references(() => newsletterSubscribers.id),
    status: newsletterDeliveryStatusEnum('status').notNull(),
    resendEmailId: text('resend_email_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('newsletter_deliveries_issue_id_subscriber_id_unique').on(
      table.issueId,
      table.subscriberId
    ),
    // No issue_id index: the unique above leads with it. subscriber_id is the
    // unique's trailing column, so it needs its own.
    index('newsletter_deliveries_subscriber_id_idx').on(table.subscriberId),
  ]
);
