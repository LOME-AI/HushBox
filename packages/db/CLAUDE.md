# Database package (packages/db)

Drizzle schema, migrations, and client. Conventions: `docs/ARCHITECTURE.md` §Data model
essentials; what each table means: `docs/DATA-MODEL.md`.

## Migrations

- Edit `src/schema/*.ts`, then `pnpm db:generate` — it writes the migration into
  `packages/db/drizzle/`, which ships with the schema change (CI fails on an
  uncommitted drift between schema and migrations). `pnpm db:migrate` applies, then
  proves the database matches the migration chain and refuses when it does not
  (`src/verify-schema-drift.ts`); the production deploy runs the same step before the
  Worker ships, so a drifted database blocks the deploy. Locally, `pnpm db:reset` is the
  remedy.
- Migrations continue the existing chain — no baselines, one drizzle config. An applied
  migration is immutable: the migrator neither re-applies nor checksums a file it has
  passed, so an edit to one reaches only databases migrated afterwards (every fresh Neon
  branch) and silently diverges from every database that already passed it. A correction
  ships as a new migration.
- The `admin_sql_panel` role is granted SELECT on future tables via
  `ALTER DEFAULT PRIVILEGES` (admin SQL panel). A new table holding plaintext
  credential or secret material must ship a `REVOKE`/column-scoped carve-out in its
  own migration (precedent: `verification_tokens`, `users.opaque_registration` in
  `0050_admin-plane-foundations.sql`). The decision is forced, not remembered: a new
  table fails `shape/panel-readability.test.ts` until it is declared `readable` or
  `revoked` there, and a `revoked` declaration must match a `REVOKE SELECT` in the
  migration chain.
- The `growth_reader` role is default-deny: its migration revokes every table privilege,
  present and future, and grants SELECT on the growth aggregate views alone. Dropping a
  view destroys its grants, and a Drizzle view redefinition drops and recreates, so a
  migration that redefines one of those views re-grants SELECT to `growth_reader` in the
  same migration — `shape/growth-reader-grants.test.ts` fails the chain otherwise, and
  `growth-reader-privileges.integration.test.ts` reads the live role's reach.

## Shape-test contract

`src/schema/shape/*.test.ts` enforces schema conventions; a new table or column must
satisfy them or the suite fails:

- Every FK column leads an index/unique/PK, or a partial index whose predicate tests
  that FK column itself for not-null; coverage is derived from the schema
  (`shape/not-null-partial-indexes.ts`), never registered.
- Every `bigint` column is classified in `shape/money.test.ts`: nano-USD money in
  `MONEY_COLUMNS`, every other `bigint` (a sequence, a counter) in
  `NOT_MONEY_BIGINT_COLUMNS`. An unclassified `bigint` fails the suite.
- Every table declares `relations()`.
- uuidv7 primary keys (`service_evidence` is the one grandfathered exception).
- Closed sets are pgEnums, never bare `text()` (`jobs.type` is text by design).
- The `jobs` table has exactly its four partial indexes (claim probe, active dedupe,
  succeeded prune, discarded prune).
- Every table declares its admin SQL panel readability (see Migrations above).

## Ownership

- Every table has exactly one owning slice (single-writer-per-table); schema changes
  belong with the owning slice's work.
