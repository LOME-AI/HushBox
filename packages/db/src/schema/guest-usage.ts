import { pgTable, text, timestamp, integer, index, varchar } from 'drizzle-orm/pg-core';

/**
 * Tracks guest (unauthenticated) user message usage for rate limiting.
 *
 * Identity tracking uses two mechanisms:
 * - Primary: guestToken stored in localStorage (persists across sessions)
 * - Backstop: ipHash catches users who clear storage or use incognito
 *
 * Query pattern: WHERE guestToken = ? OR ipHash = ?
 * Take the record with higher messageCount to catch evasion attempts.
 *
 * See packages/shared/src/tiers.ts for GUEST_MESSAGE_LIMIT constant.
 */
export const guestUsage = pgTable(
  'guest_usage',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    // Primary identifier: token stored in localStorage
    guestToken: varchar('guest_token', { length: 64 }).unique(),
    // Backstop identifier: SHA-256 hash of IP address
    ipHash: varchar('ip_hash', { length: 64 }).notNull(),
    // Number of messages sent today
    messageCount: integer('message_count').notNull().default(0),
    // When the usage was last reset (lazy reset at UTC midnight)
    resetAt: timestamp('reset_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('guest_usage_guest_token_idx').on(table.guestToken),
    index('guest_usage_ip_hash_idx').on(table.ipHash),
  ]
);
