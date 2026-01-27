import { pgTable, text, timestamp, boolean, numeric } from 'drizzle-orm/pg-core';

import { FREE_ALLOWANCE_CENTS, WELCOME_CREDIT_BALANCE } from '../constants';

export const users = pgTable('users', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  balance: numeric('balance', { precision: 20, scale: 8 })
    .notNull()
    .default(WELCOME_CREDIT_BALANCE),
  freeAllowanceCents: numeric('free_allowance_cents', { precision: 20, scale: 8 })
    .notNull()
    .default(FREE_ALLOWANCE_CENTS),
  freeAllowanceResetAt: timestamp('free_allowance_reset_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
