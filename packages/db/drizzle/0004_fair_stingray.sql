CREATE TABLE "guest_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"guest_token" varchar(64),
	"ip_hash" varchar(64) NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"reset_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guest_usage_guest_token_unique" UNIQUE("guest_token")
);
--> statement-breakpoint
CREATE INDEX "guest_usage_guest_token_idx" ON "guest_usage" USING btree ("guest_token");--> statement-breakpoint
CREATE INDEX "guest_usage_ip_hash_idx" ON "guest_usage" USING btree ("ip_hash");