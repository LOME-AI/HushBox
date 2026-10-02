CREATE TYPE "public"."admin_role" AS ENUM('operator', 'growth-viewer');--> statement-breakpoint
-- The default backfills rows written before the plane had roles: every admin
-- actor was an operator then, because no other role existed. It is dropped
-- immediately so a later insert that omits the column fails instead of
-- silently recording the fuller role. `admin_audit` is append-only by trigger,
-- so a backfilling UPDATE is not available here.
ALTER TABLE "admin_audit" ADD COLUMN "role" "admin_role" DEFAULT 'operator' NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_audit" ALTER COLUMN "role" DROP DEFAULT;
