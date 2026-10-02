import { pgTable, text, timestamp, jsonb } from 'drizzle-orm/pg-core';

export const serviceEvidence = pgTable('service_evidence', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  service: text('service').notNull(),
  details: jsonb('details'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
