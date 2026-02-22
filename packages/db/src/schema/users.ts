import { pgTable, text, timestamp, boolean, index, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { bytea } from './bytea';

export const users = pgTable(
  'users',
  {
    id: text('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    email: text('email').unique(),
    username: varchar('username', { length: 20 }).notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),

    emailVerified: boolean('email_verified').notNull().default(false),
    emailVerifyToken: text('email_verify_token'),
    emailVerifyExpires: timestamp('email_verify_expires', { withTimezone: true }),

    // OPAQUE authentication
    opaqueRegistration: bytea('opaque_registration').notNull(),

    // TOTP 2FA
    totpSecretEncrypted: bytea('totp_secret_encrypted'),
    totpEnabled: boolean('totp_enabled').notNull().default(false),

    // Recovery phrase acknowledgment
    hasAcknowledgedPhrase: boolean('has_acknowledged_phrase').notNull().default(false),

    // E2E encryption keys
    publicKey: bytea('public_key').notNull(),
    passwordWrappedPrivateKey: bytea('password_wrapped_private_key').notNull(),
    recoveryWrappedPrivateKey: bytea('recovery_wrapped_private_key').notNull(),
  },
  (table) => [index('idx_users_email_verify_token').on(table.emailVerifyToken)]
);
