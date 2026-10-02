-- The growth analytics reader: a SELECT-only Postgres role for the marketing
-- MCP, created in-chain so every Neon branch — preview branches, and the fresh
-- branch a recovery drill restores into — carries it with no manual step.
-- NOLOGIN and passwordless on purpose: the role cannot authenticate, so no
-- usable credential for it exists until its consumer is stood up, at which
-- point the password is minted out-of-band, never in a migration. Roles are
-- cluster-level, so creation is guarded for re-runs after db:reset; grants are
-- idempotent by nature.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'growth_reader') THEN
    CREATE ROLE growth_reader NOLOGIN;
  END IF;
END;
$$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO growth_reader;--> statement-breakpoint
-- Default-deny, the inverse of admin_sql_panel's blanket read: a new table is
-- invisible to growth_reader by construction, so no later migration has to
-- remember a carve-out for it. Only the aggregate views granted SELECT are
-- readable. The revoke precedes the grants because ALL TABLES covers views too.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM growth_reader;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM growth_reader;--> statement-breakpoint
-- These views run with their definer's privileges rather than security_invoker,
-- which is what lets a join over users be readable while users itself is not.
-- Dropping a view destroys the privileges granted on it, so a migration that
-- redefines one of these must re-grant it in that migration.
GRANT SELECT ON acquisition_sources TO growth_reader;--> statement-breakpoint
GRANT SELECT ON funnel_weekly TO growth_reader;--> statement-breakpoint
GRANT SELECT ON growth_weekly TO growth_reader;--> statement-breakpoint
GRANT SELECT ON marketing_daily TO growth_reader;--> statement-breakpoint
GRANT SELECT ON marketing_hourly TO growth_reader;
