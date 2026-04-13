-- Wrap-once envelope encryption + content_items refactor + media billing.
-- Pre-launch migration; wipes existing messages and shared_messages outright.

-- 1. Wipe shared messages and drop the old per-plaintext share column.
DELETE FROM "shared_messages";--> statement-breakpoint
ALTER TABLE "shared_messages" DROP COLUMN "share_blob";--> statement-breakpoint
ALTER TABLE "shared_messages" ADD COLUMN "wrapped_content_key" "bytea" NOT NULL;--> statement-breakpoint

-- 2. Wipe messages (cascades to shared_messages, conversation_forks, etc. via FK cascade).
DELETE FROM "messages";--> statement-breakpoint

-- 3. Remove content / AI / billing columns from messages. They move to content_items.
ALTER TABLE "messages" DROP COLUMN "encrypted_blob";--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "model_name";--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "cost";--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "payer_id";--> statement-breakpoint

-- 4. Add the one wrapped content key column on messages (one per message, reused across all content items).
ALTER TABLE "messages" ADD COLUMN "wrapped_content_key" "bytea" NOT NULL;--> statement-breakpoint

-- 5. Create content_items table: one row per discrete piece of content in a message.
--    Text items store inline via encrypted_blob; media items store via storage_key (R2).
--    CHECK constraint enforces mutual exclusion based on content_type.
CREATE TABLE "content_items" (
	"id" text PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"message_id" text NOT NULL,
	"content_type" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"encrypted_blob" "bytea",
	"storage_key" text,
	"mime_type" text,
	"size_bytes" integer,
	"width" integer,
	"height" integer,
	"duration_ms" integer,
	"model_name" text,
	"cost" numeric(20, 8),
	"is_smart_model" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_items_type_consistency" CHECK (
		("content_items"."content_type" = 'text'
		  AND "content_items"."encrypted_blob" IS NOT NULL
		  AND "content_items"."storage_key" IS NULL
		  AND "content_items"."mime_type" IS NULL
		  AND "content_items"."size_bytes" IS NULL)
		OR ("content_items"."content_type" IN ('image', 'audio', 'video')
		  AND "content_items"."storage_key" IS NOT NULL
		  AND "content_items"."mime_type" IS NOT NULL
		  AND "content_items"."size_bytes" IS NOT NULL
		  AND "content_items"."encrypted_blob" IS NULL)
	)
);--> statement-breakpoint

ALTER TABLE "content_items"
	ADD CONSTRAINT "content_items_message_id_messages_id_fk"
	FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id")
	ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "content_items_message_id_position_idx"
	ON "content_items" USING btree ("message_id","position");--> statement-breakpoint

-- Partial unique index on storage_key: enforces one R2 object per media row without
-- blocking text rows (all of which have NULL storage_key).
CREATE UNIQUE INDEX "content_items_storage_key_idx"
	ON "content_items" USING btree ("storage_key")
	WHERE "content_items"."storage_key" IS NOT NULL;--> statement-breakpoint

-- 6. Create media_generations billing detail table (sibling of llm_completions under usage_records).
CREATE TABLE "media_generations" (
	"id" text PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"usage_record_id" text NOT NULL,
	"model" text NOT NULL,
	"provider" text NOT NULL,
	"media_type" text NOT NULL,
	"image_count" integer,
	"duration_ms" integer,
	"resolution" text,
	CONSTRAINT "media_generations_usage_record_id_unique" UNIQUE("usage_record_id")
);--> statement-breakpoint

ALTER TABLE "media_generations"
	ADD CONSTRAINT "media_generations_usage_record_id_usage_records_id_fk"
	FOREIGN KEY ("usage_record_id") REFERENCES "public"."usage_records"("id")
	ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "media_generations_model_idx"
	ON "media_generations" USING btree ("model");
