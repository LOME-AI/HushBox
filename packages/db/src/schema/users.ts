import {
  pgTable,
  boolean,
  check,
  index,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { bytea } from './bytea';
import { userLockReasonEnum } from './enums';

export const users = pgTable(
  'users',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    email: text('email').notNull().unique(),
    username: varchar('username', { length: 20 }).notNull().unique(),
    emailVerified: boolean('email_verified').notNull().default(false),

    // OPAQUE authentication
    opaqueRegistration: bytea('opaque_registration').notNull(),
    // Per-user OPAQUE server material, sealed under OPAQUE_KEK.
    opaqueServerMaterial: bytea('opaque_server_material').notNull(),
    // Fingerprint of the OPAQUE_KEK that sealed the material; non-secret by construction.
    opaqueKekFingerprint: bytea('opaque_kek_fingerprint').notNull(),

    // TOTP 2FA
    totpSecretEncrypted: bytea('totp_secret_encrypted'),
    totpEnabled: boolean('totp_enabled').notNull().default(false),

    // Recovery phrase acknowledgment
    hasAcknowledgedPhrase: boolean('has_acknowledged_phrase').notNull().default(false),

    // E2E encryption keys
    publicKey: bytea('public_key').notNull(),
    passwordWrappedPrivateKey: bytea('password_wrapped_private_key').notNull(),
    recoveryWrappedPrivateKey: bytea('recovery_wrapped_private_key').notNull(),
    // The X25519 public half of the recovery-phrase keypair, kept so the server
    // can seal a reset challenge only the phrase-holder can open. NOT NULL: an
    // account missing it has no reset path at all, and must never be creatable.
    recoveryPublicKey: bytea('recovery_public_key').notNull(),

    // Chargeback auto-defense / admin lock — reversible, no delete
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockReason: userLockReasonEnum('lock_reason'),

    // Chunked-deletion fallback marker
    deletionRequestedAt: timestamp('deletion_requested_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      'users_lock_consistency',
      sql`(${table.lockedAt} IS NULL) = (${table.lockReason} IS NULL)`
    ),
    // Serves the invite search's case-insensitive username prefix match. The
    // unique btree above cannot: it is ordered by the stored value under the
    // database collation, and neither a case-folded match nor a `LIKE` prefix
    // can be answered from that ordering. `lower(...)` is what makes the
    // predicate index-visible; `text_pattern_ops` is what makes a prefix a
    // range on it under any collation.
    index('users_username_lower_pattern_idx').using(
      'btree',
      sql`lower(${table.username}) text_pattern_ops`
    ),
  ]
);
