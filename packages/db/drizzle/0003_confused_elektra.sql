ALTER TABLE "users" ALTER COLUMN "balance" SET DEFAULT '0.20000000';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "free_allowance_cents" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "free_allowance_reset_at" timestamp with time zone;