# Neon role passwords

Obtain and reset the Postgres role passwords behind `DATABASE_URL`, `ADMIN_SQL_PANEL_DATABASE_URL`, `GROWTH_READER_DATABASE_URL` and `BACKUP_DATABASE_URL`. A password reset is the only rotation Neon offers; the old password stops being accepted when the reset finishes, so the deploy carrying the new value is staged before the reset. Design: `docs/SECRETS.md`.

## Pooled versus direct

Neon exposes every branch on two hosts. The direct host is `ep-<name>-<id>.<region>.aws.neon.tech`; the pooled host inserts `-pooler` after the endpoint segment and fronts the same compute with PgBouncer in transaction mode. The pooled host admits 10,000 client connections where the direct host's ceiling depends on compute size, and it lends a connection for one transaction at a time, so anything that lives on a session is lost between transactions: `SET`/`RESET` outside a transaction (`SET LOCAL` inside one survives), `LISTEN`/`NOTIFY`, `WITH HOLD` cursors, SQL-level `PREPARE`, `LOAD`, and session advisory locks; protocol-level prepared statements work. Neon recommends the pooled host for a serverless client that opens a connection per request, and the direct host for migrations, `pg_dump`/`pg_restore`, logical replication, and anything session-bound.

This repository binds one value to both jobs. The product Worker and the Durable Objects open the Neon serverless driver's `Pool` over WebSocket with one connection per pool (`packages/db/src/client.ts`) — the per-request pattern the pooled host is meant for — and the deploy job runs `pnpm db:migrate` against the same production `DATABASE_URL` (`.github/workflows/ci.yml`, the `deploy` job), where `packages/db/drizzle.config.ts` states that drizzle-kit needs the direct TCP host and the pooled host is not migratable. The Worker's request path needs the direct host too: its pool sends the request statement bound as a startup `options` parameter (`apps/api/src/lib/context/factories.ts`), which the pooled host refuses on every connection. The direct host is therefore the value that satisfies both; its cost is the compute-sized connection ceiling. `ADMIN_SQL_PANEL_DATABASE_URL` carries one transaction with a `SET LOCAL` per query, which both hosts accept.

A connection string from the console has the shape `postgresql://<role>:<password>@<host>/<database>?sslmode=require&channel_binding=require`; Neon recommends `sslmode=verify-full`, and the client accepts either `postgres://` or `postgresql://`.

## Obtain

### `DATABASE_URL`

The role is the one migrations run as: the project's console-created role, which — like every role made in the console, the CLI, or the API — is a member of `neon_superuser` (`CREATEDB`, `CREATEROLE`, `BYPASSRLS`, `pg_read_all_data`, `pg_write_all_data`, and more).

Neon console -> the project -> "Connect" on the "Project Dashboard" -> the "Connect to your database" modal -> choose the branch, compute, database, and role -> leave "Connection pooling" off (the toggle's exact microcopy was inferred during research, not read from a screen). The modal shows the string; the password inside it is shown once, at role creation or password reset, and never again. A role whose password nobody holds gets one by the reset under §Replace.

Write the offline copy. Set `DATABASE_URL` in the `production` environment together with `ADMIN_SQL_PANEL_DATABASE_URL` and `GROWTH_READER_DATABASE_URL`; the three are coupled and ship in one publish.

Probe: the deploy job's migration step connects with the value before the Worker serves a request on it; after the deploy, any authenticated request that reads the database.

### `ADMIN_SQL_PANEL_DATABASE_URL`

The role `admin_sql_panel` is SELECT-only, and Neon cannot make such a role: every role created in the console, the CLI, or the API is a `neon_superuser` member, and Neon's documentation sends anyone needing a limited role to SQL. The migration chain is that SQL — every migration under `packages/db/drizzle/` that names `admin_sql_panel`, from the one that creates it onward:

- `CREATE ROLE admin_sql_panel NOLOGIN`, guarded by `IF NOT EXISTS` — the role exists on every branch the migration reaches, but nothing can log in as it until an operator says so, so no deploy or CI run ever holds its password.
- `GRANT USAGE ON SCHEMA public` — `PUBLIC` holds `USAGE` on the `public` schema by default (PostgreSQL 15 withdrew `CREATE` from it, not `USAGE`), so on a stock cluster this grant changes nothing; it is what keeps the panel resolving table names on a cluster where `PUBLIC`'s `USAGE` has been revoked as hardening.
- `GRANT SELECT ON ALL TABLES IN SCHEMA public` — a snapshot: it covers the tables that exist when it runs and no table created later.
- `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES` — covers the later tables, because default privileges apply to objects the executing role creates afterwards, and the migration role creates every table.
- `REVOKE SELECT` on each credential-bearing table, followed by a column-list `GRANT SELECT` — the carve-outs: plaintext credential material is never panel-readable, and later migrations narrow the lists further.

`admin_sql_panel` is created only by that migration. A role of that name created in the console is a `neon_superuser` member; the migration's `IF NOT EXISTS` guard keeps it and grants on top, and the "SELECT-only" panel can then write every table. The panel's write-proofness (`apps/api/src/slices/admin/adapters/sql-panel.ts`) is the role's lack of write grants and nothing else.

What the migration deliberately omits is the login. Mint a password locally — Neon's roles page asks for at least 60 bits of entropy and its database-access page for at least 12 characters; the two were not reconciled during research, so meet the stricter — in hex, so it needs no URL-encoding inside the connection string:

```
openssl rand -hex 24
```

Then, connected as the migration role (its `CREATEROLE` covers this) over the direct host:

```sql
ALTER ROLE admin_sql_panel LOGIN PASSWORD '<password>';
```

One statement grants both, so no state exists in which the role can log in without the password you chose. Compose the connection string by hand: the host and database from `DATABASE_URL`, `admin_sql_panel` as the role, the new password. Whether the console's "Connect" modal lists a role created in SQL was not established during research.

Write the offline copy. Set `ADMIN_SQL_PANEL_DATABASE_URL` in the `production` environment together with `DATABASE_URL`.

Probe: from the admin GUI's SQL panel, a `SELECT` on an ordinary table returns rows; an `INSERT` returns the panel's forbidden code (SQLSTATE `42501`); and `SELECT * FROM verification_tokens` is refused too. The third is the one that matters — it fails only for the migration's role, never for a console-created one.

### `GROWTH_READER_DATABASE_URL`

The role `growth_reader` is SELECT-only on the growth aggregate views, and the migration chain creates it for the same reason it creates `admin_sql_panel` (`packages/db/drizzle/0086_growth-reader-role.sql`): `NOLOGIN` with no password, every table privilege revoked present and future, `SELECT` granted on the views alone. Its consumer is the marketer's Neon MCP, not the product Worker; standing that consumer up is `docs/runbooks/infra/growth-reader-role.md`.

Until an operator grants the login, the value is a well-formed string that cannot connect — `postgresql://growth_reader@<host>/<database>?sslmode=require&channel_binding=require`, the direct host and database from `DATABASE_URL`, no password component — because the deploy publishes every declared secret and nothing connects with this one. That is the intended state, not a broken credential.

To make it connectable, mint a password and grant the login exactly as for `admin_sql_panel` — `openssl rand -hex 24`, then as the migration role over the direct host:

```sql
ALTER ROLE growth_reader LOGIN PASSWORD '<password>';
```

Compose the string by hand with `growth_reader` as the role and the new password.

Write the offline copy. Set `GROWTH_READER_DATABASE_URL` in the `production` environment together with `DATABASE_URL`.

Probe: connected with the value, `SELECT` from `growth_weekly` returns rows and `SELECT * FROM users` is refused (SQLSTATE `42501`). Before the login is granted, the probe is that a connection with the value is refused.

### `BACKUP_DATABASE_URL`

The connection the hourly backup takes its dump over, for a role that can read every table. Compose it exactly as `DATABASE_URL`, and take it from the **direct** host: the dump exports a transaction snapshot and hands it to a second session running `pg_dump`, and the pooled host routes that second session to a different backend, which cannot see the snapshot. §Pooled versus direct is why the direct host is available at all.

Write the offline copy, then set it in the `backup` environment — `production` secrets are unreadable from there. One value answers both `BACKUP_DATABASE_URL` and `BACKUP_SNAPSHOT_DATABASE_URL`, because on Neon one direct endpoint serves the driver holding the snapshot and the containerised `pg_dump` alike; locally they are two endpoints of one database.

Probe: the next hourly backup run; it refuses on the whole environment before it dumps anything when the value is absent. Design: `docs/BACKUPS.md`.

## Replace

A password reset is the only rotation Neon offers. Console: "Branches" -> the branch -> "Roles & Databases" -> the role's menu -> "Reset password" -> confirm; the new password is shown once (the "Connect" modal's role selector offers the same action). API: `POST /projects/{project_id}/branches/{branch_id}/roles/{role_name}/reset_password`. The CLI has none: `neon roles` offers `list`, `create`, and `delete` only. A reset is branch-scoped — a child branch copies roles at creation and keeps its own passwords. For the SQL-created roles `admin_sql_panel` and `growth_reader`, `ALTER ROLE <role> PASSWORD '<password>'` over SQL is the reset; whether the console offers "Reset password" for a SQL-created role was not established.

What the reset does to open sessions is stated both ways by Neon: the API reference says the old password stays valid until the operation finishes and connections to the compute are then dropped; the FAQ says the old password stops working at the next connection attempt and sessions already open stay connected. Either way the Worker, which opens a connection per request, fails from the reset until the deploy carrying the new value completes — the outage the registry declares. Sequence: reset (or `ALTER ROLE`), write the offline copy, set both `production` secrets, run the deploy; the deploy's migration step is the first connection with the new value.
