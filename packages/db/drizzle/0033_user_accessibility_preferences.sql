-- Add accessibility preferences storage to users table.
-- JSONB column with literal default; companion timestamptz powers LWW (last-write-wins) sync.
-- IF NOT EXISTS so the migration is safe to re-apply on slots whose DB already
-- has the columns (e.g. they were added by hand during development before this
-- file existed). Without this guard a fresh-slot vs existing-slot mismatch in
-- the drizzle migration tracker bricks `pnpm dev`.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "accessibility_preferences" jsonb NOT NULL DEFAULT '{"version":1}'::jsonb;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "accessibility_preferences_updated_at" timestamp with time zone NOT NULL DEFAULT now();
