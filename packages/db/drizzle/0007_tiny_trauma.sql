ALTER TABLE "users" ALTER COLUMN "free_allowance_cents" SET DATA TYPE numeric(20, 8);--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "free_allowance_cents" SET DEFAULT '5.00000000';