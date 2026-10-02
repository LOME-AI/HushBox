-- Migration 0008: Full schema overhaul for epoch-based E2EE architecture
-- From 0007 baseline to new schema (design doc Part 14)
-- No existing users — clean slate migration

-- =============================================================================
-- Step 1: DROP old tables and enums
-- =============================================================================

-- Drop tables with FK dependencies first (CASCADE for cross-FK references)
DROP TABLE IF EXISTS "message_shares" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "conversation_shares" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "balance_transactions" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "guest_usage" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "accounts" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "sessions" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "verifications" CASCADE;
--> statement-breakpoint

-- Convert enum columns to text and drop defaults BEFORE dropping the types
ALTER TABLE "payments" ALTER COLUMN "status" SET DATA TYPE text;
--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "status" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "role" SET DATA TYPE text;
--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "role" DROP DEFAULT;
--> statement-breakpoint

-- Drop enums (safe now — no columns reference them)
DROP TYPE IF EXISTS "balance_transaction_type";
--> statement-breakpoint
DROP TYPE IF EXISTS "deduction_source";
--> statement-breakpoint
DROP TYPE IF EXISTS "message_role";
--> statement-breakpoint
DROP TYPE IF EXISTS "payment_status";
--> statement-breakpoint

-- =============================================================================
-- Step 2: ALTER users
-- =============================================================================

-- Drop columns no longer needed
ALTER TABLE "users" DROP COLUMN IF EXISTS "balance";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "free_allowance_cents";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "free_allowance_reset_at";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "name";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "image";
--> statement-breakpoint

-- Add new columns
ALTER TABLE "users" ADD COLUMN "username" text NOT NULL UNIQUE;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verify_token" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verify_expires" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "opaque_registration" bytea NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "public_key" bytea NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_wrapped_private_key" bytea NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "recovery_wrapped_private_key" bytea NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_secret_encrypted" bytea;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_enabled" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "has_acknowledged_phrase" boolean NOT NULL DEFAULT false;
--> statement-breakpoint

-- Change id default to uuidv7()
ALTER TABLE "users" ALTER COLUMN "id" SET DEFAULT uuidv7();
--> statement-breakpoint

-- Index on email_verify_token for lookup during verification
CREATE INDEX "idx_users_email_verify_token" ON "users" USING btree ("email_verify_token");
--> statement-breakpoint

-- =============================================================================
-- Step 3: ALTER conversations
-- =============================================================================

-- Drop old sharing columns
ALTER TABLE "conversations" DROP COLUMN IF EXISTS "is_public";
--> statement-breakpoint
ALTER TABLE "conversations" DROP COLUMN IF EXISTS "public_share_id";
--> statement-breakpoint
ALTER TABLE "conversations" DROP COLUMN IF EXISTS "public_share_expires";
--> statement-breakpoint

-- Change title from text to bytea (ECIES blob under epoch key)
-- Must drop default before type change (text default can't cast to bytea)
ALTER TABLE "conversations" ALTER COLUMN "title" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "title" SET DATA TYPE bytea USING decode('', 'hex');
--> statement-breakpoint

-- Add new columns
ALTER TABLE "conversations" ADD COLUMN "project_id" text REFERENCES "projects"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "title_epoch_number" integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "current_epoch" integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "next_sequence" integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "rotation_pending" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "per_person_budget" numeric(20, 8);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "conversation_budget" numeric(20, 8);
--> statement-breakpoint

-- Change id default to uuidv7()
ALTER TABLE "conversations" ALTER COLUMN "id" SET DEFAULT uuidv7();
--> statement-breakpoint

-- =============================================================================
-- Step 4: ALTER messages
-- =============================================================================

-- Drop FK to balance_transactions first (table was dropped in step 1)
ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "messages_balance_transaction_id_balance_transactions_id_fk";
--> statement-breakpoint

-- Drop old columns
ALTER TABLE "messages" DROP COLUMN IF EXISTS "role";
--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN IF EXISTS "content";
--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN IF EXISTS "model";
--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN IF EXISTS "balance_transaction_id";
--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN IF EXISTS "cost";
--> statement-breakpoint

-- Add new columns
ALTER TABLE "messages" ADD COLUMN "encrypted_blob" bytea NOT NULL;
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sender_type" text NOT NULL;
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sender_id" text;
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sender_display_name" text;
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "payer_id" text;
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "epoch_number" integer NOT NULL;
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sequence_number" integer NOT NULL;
--> statement-breakpoint

-- CHECK constraint on sender_type
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_type_check"
  CHECK ("sender_type" IN ('user', 'ai'));
--> statement-breakpoint

-- Drop old index and create new one
DROP INDEX IF EXISTS "messages_conversation_id_idx";
--> statement-breakpoint
CREATE INDEX "messages_conversation_id_sequence_idx"
  ON "messages" USING btree ("conversation_id", "sequence_number");
--> statement-breakpoint

-- Change id default to uuidv7()
ALTER TABLE "messages" ALTER COLUMN "id" SET DEFAULT uuidv7();
--> statement-breakpoint

-- =============================================================================
-- Step 5: ALTER projects
-- =============================================================================

-- Drop old columns
ALTER TABLE "projects" DROP COLUMN IF EXISTS "name";
--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN IF EXISTS "description";
--> statement-breakpoint

-- Add new encrypted columns
ALTER TABLE "projects" ADD COLUMN "encrypted_name" bytea NOT NULL;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "encrypted_description" bytea;
--> statement-breakpoint

-- Change id default to uuidv7()
ALTER TABLE "projects" ALTER COLUMN "id" SET DEFAULT uuidv7();
--> statement-breakpoint

-- =============================================================================
-- Step 6: ALTER payments
-- =============================================================================

-- Drop the existing FK constraint (ON DELETE CASCADE)
ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "payments_user_id_users_id_fk";
--> statement-breakpoint

-- Make user_id nullable
ALTER TABLE "payments" ALTER COLUMN "user_id" DROP NOT NULL;
--> statement-breakpoint

-- Re-add FK with ON DELETE SET NULL
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint

-- Set default for status (type already changed to text in Step 1)
ALTER TABLE "payments" ALTER COLUMN "status" SET DEFAULT 'pending';
--> statement-breakpoint

-- Add CHECK constraint for status values
ALTER TABLE "payments" ADD CONSTRAINT "payments_status_check"
  CHECK ("status" IN ('pending', 'awaiting_webhook', 'completed', 'failed', 'refunded'));
--> statement-breakpoint

-- Add idempotency_key column (was in deleted 0008-0012, needed by schema)
ALTER TABLE "payments" ADD COLUMN "idempotency_key" text;
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_idempotency_key"
  UNIQUE ("user_id", "idempotency_key");
--> statement-breakpoint

-- Change id default to uuidv7()
ALTER TABLE "payments" ALTER COLUMN "id" SET DEFAULT uuidv7();
--> statement-breakpoint

-- =============================================================================
-- Step 7: CREATE new tables
-- =============================================================================

-- 7.1: wallets
CREATE TABLE "wallets" (
  "id" text PRIMARY KEY DEFAULT uuidv7(),
  "user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "type" text NOT NULL,
  "balance" numeric(20, 8) NOT NULL DEFAULT 0,
  "priority" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "wallets_user_id_idx" ON "wallets" USING btree ("user_id");
--> statement-breakpoint

-- 7.2: usage_records
CREATE TABLE "usage_records" (
  "id" text PRIMARY KEY DEFAULT uuidv7(),
  "user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "type" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "cost" numeric(20, 8) NOT NULL,
  "source_type" text NOT NULL,
  "source_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  CONSTRAINT "usage_records_status_check"
    CHECK ("status" IN ('pending', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE INDEX "usage_records_user_id_type_created_at_idx"
  ON "usage_records" USING btree ("user_id", "type", "created_at");
--> statement-breakpoint
CREATE INDEX "usage_records_source_type_source_id_idx"
  ON "usage_records" USING btree ("source_type", "source_id");
--> statement-breakpoint

-- 7.3: ledger_entries
CREATE TABLE "ledger_entries" (
  "id" text PRIMARY KEY DEFAULT uuidv7(),
  "wallet_id" text NOT NULL REFERENCES "wallets"("id") ON DELETE CASCADE,
  "amount" numeric(20, 8) NOT NULL,
  "balance_after" numeric(20, 8) NOT NULL,
  "entry_type" text NOT NULL,
  "payment_id" text REFERENCES "payments"("id") ON DELETE SET NULL,
  "usage_record_id" text REFERENCES "usage_records"("id") ON DELETE SET NULL,
  "source_wallet_id" text REFERENCES "wallets"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ledger_entries_entry_type_check"
    CHECK ("entry_type" IN ('deposit', 'usage_charge', 'refund', 'adjustment', 'renewal', 'welcome_credit')),
  CONSTRAINT "ledger_entries_exactly_one_source_check"
    CHECK (
      (("payment_id" IS NOT NULL)::int +
       ("usage_record_id" IS NOT NULL)::int +
       ("source_wallet_id" IS NOT NULL)::int) = 1
    )
);
--> statement-breakpoint
CREATE INDEX "ledger_entries_wallet_id_created_at_idx"
  ON "ledger_entries" USING btree ("wallet_id", "created_at");
--> statement-breakpoint
CREATE INDEX "ledger_entries_usage_record_id_idx"
  ON "ledger_entries" ("usage_record_id") WHERE "usage_record_id" IS NOT NULL;
--> statement-breakpoint

-- 7.4: llm_completions
CREATE TABLE "llm_completions" (
  "id" text PRIMARY KEY DEFAULT uuidv7(),
  "usage_record_id" text NOT NULL UNIQUE REFERENCES "usage_records"("id") ON DELETE CASCADE,
  "model" text NOT NULL,
  "provider" text NOT NULL,
  "input_tokens" integer NOT NULL,
  "output_tokens" integer NOT NULL,
  "cached_tokens" integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX "llm_completions_model_idx" ON "llm_completions" USING btree ("model");
--> statement-breakpoint

-- 7.5: shared_links
CREATE TABLE "shared_links" (
  "id" text PRIMARY KEY DEFAULT uuidv7(),
  "conversation_id" text NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
  "link_public_key" bytea NOT NULL,
  "privilege" text NOT NULL DEFAULT 'read',
  "visible_from_epoch" integer NOT NULL,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "shared_links_privilege_check"
    CHECK ("privilege" IN ('read', 'write'))
);
--> statement-breakpoint
CREATE INDEX "shared_links_conversation_id_active_idx"
  ON "shared_links" ("conversation_id") WHERE "revoked_at" IS NULL;
--> statement-breakpoint

-- 7.6: conversation_members
CREATE TABLE "conversation_members" (
  "id" text PRIMARY KEY DEFAULT uuidv7(),
  "conversation_id" text NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
  "user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "link_id" text REFERENCES "shared_links"("id") ON DELETE SET NULL,
  "privilege" text NOT NULL DEFAULT 'write',
  "visible_from_epoch" integer NOT NULL,
  "joined_at" timestamp with time zone DEFAULT now() NOT NULL,
  "left_at" timestamp with time zone,
  CONSTRAINT "conversation_members_has_identity_check"
    CHECK (("user_id" IS NOT NULL) OR ("link_id" IS NOT NULL)),
  CONSTRAINT "conversation_members_privilege_check"
    CHECK ("privilege" IN ('read', 'write', 'admin', 'owner'))
);
--> statement-breakpoint

-- 7.7: epochs
CREATE TABLE "epochs" (
  "id" text PRIMARY KEY DEFAULT uuidv7(),
  "conversation_id" text NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
  "epoch_number" integer NOT NULL,
  "epoch_public_key" bytea NOT NULL,
  "confirmation_hash" bytea NOT NULL,
  "chain_link" bytea,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "epochs_conversation_epoch_unique"
    UNIQUE ("conversation_id", "epoch_number")
);
--> statement-breakpoint

-- 7.8: epoch_members
CREATE TABLE "epoch_members" (
  "id" text PRIMARY KEY DEFAULT uuidv7(),
  "epoch_id" text NOT NULL REFERENCES "epochs"("id") ON DELETE CASCADE,
  "member_public_key" bytea NOT NULL,
  "wrap" bytea NOT NULL,
  "privilege" text NOT NULL,
  "visible_from_epoch" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "epoch_members_privilege_check"
    CHECK ("privilege" IN ('read', 'write', 'admin', 'owner')),
  CONSTRAINT "epoch_members_epoch_member_unique"
    UNIQUE ("epoch_id", "member_public_key")
);
--> statement-breakpoint
CREATE INDEX "epoch_members_member_public_key_idx"
  ON "epoch_members" USING btree ("member_public_key");
--> statement-breakpoint

-- 7.9: pending_removals
CREATE TABLE "pending_removals" (
  "id" text PRIMARY KEY DEFAULT uuidv7(),
  "conversation_id" text NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
  "member_id" text NOT NULL REFERENCES "conversation_members"("id") ON DELETE CASCADE,
  "requested_by" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "pending_removals_conversation_id_idx"
  ON "pending_removals" USING btree ("conversation_id");
--> statement-breakpoint

-- 7.10: shared_messages
CREATE TABLE "shared_messages" (
  "id" text PRIMARY KEY DEFAULT uuidv7(),
  "message_id" text NOT NULL REFERENCES "messages"("id") ON DELETE CASCADE,
  "share_blob" bytea NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- 7.11: member_budgets
CREATE TABLE "member_budgets" (
  "id" text PRIMARY KEY DEFAULT uuidv7(),
  "member_id" text NOT NULL UNIQUE REFERENCES "conversation_members"("id") ON DELETE CASCADE,
  "budget" numeric(20, 8) NOT NULL,
  "spent" numeric(20, 8) NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- 7.12: conversation_spending
CREATE TABLE "conversation_spending" (
  "id" text PRIMARY KEY DEFAULT uuidv7(),
  "conversation_id" text NOT NULL UNIQUE REFERENCES "conversations"("id") ON DELETE CASCADE,
  "total_spent" numeric(20, 8) NOT NULL DEFAULT 0,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- =============================================================================
-- Step 9: Partial unique indexes for conversation_members
-- =============================================================================

-- Prevent duplicate active members (same user in same conversation)
CREATE UNIQUE INDEX "conversation_members_user_active"
  ON "conversation_members" ("conversation_id", "user_id") WHERE "left_at" IS NULL;
--> statement-breakpoint

-- Prevent duplicate active link memberships
CREATE UNIQUE INDEX "conversation_members_link_active"
  ON "conversation_members" ("conversation_id", "link_id") WHERE "left_at" IS NULL;
--> statement-breakpoint

-- Fast active member lookups by conversation
CREATE INDEX "conversation_members_active"
  ON "conversation_members" ("conversation_id") WHERE "left_at" IS NULL;
--> statement-breakpoint

-- Fast active member lookups by user
CREATE INDEX "conversation_members_user_active_lookup"
  ON "conversation_members" ("user_id") WHERE "left_at" IS NULL;
