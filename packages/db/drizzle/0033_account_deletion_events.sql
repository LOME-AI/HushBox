CREATE TABLE "account_deletion_events" (
	"id" text PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE INDEX "account_deletion_events_deleted_at_idx" ON "account_deletion_events" USING btree ("deleted_at");