CREATE TABLE IF NOT EXISTS "account_deletion_events" (
	"id" text PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "account_deletion_events_deleted_at_idx" ON "account_deletion_events" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_sender_id_idx" ON "messages" USING btree ("sender_id") WHERE "messages"."sender_id" is not null;--> statement-breakpoint
ALTER TABLE "conversation_members" DROP CONSTRAINT IF EXISTS "conversation_members_has_identity_check";--> statement-breakpoint
ALTER TABLE "conversation_members" DROP CONSTRAINT IF EXISTS "conversation_members_identity_or_left_check";--> statement-breakpoint
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_identity_or_left_check" CHECK ("conversation_members"."user_id" IS NOT NULL OR "conversation_members"."link_id" IS NOT NULL OR "conversation_members"."left_at" IS NOT NULL);
