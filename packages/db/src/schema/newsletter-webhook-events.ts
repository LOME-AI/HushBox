import { pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * The newsletter slice's first-delivery claim on a provider webhook event:
 * the UNIQUE on the provider's event id is what makes one delivery win, and
 * a losing insert is the replay being refused rather than an error. Rows are
 * never deleted, because the dedupe has to outlive any retry window — a
 * delivery replayed long after the original must not re-suppress an address
 * the subscriber has resubscribed in the meantime.
 */
export const newsletterWebhookEvents = pgTable(
  'newsletter_webhook_events',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    eventId: text('event_id').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [unique('newsletter_webhook_events_event_id_unique').on(table.eventId)]
);
