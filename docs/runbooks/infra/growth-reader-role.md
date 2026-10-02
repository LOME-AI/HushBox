# Growth reader role

Stand up the marketer's read access to the growth aggregate views: the Postgres role
`growth_reader`, the Neon MCP that reads as it, and the marketer's `growth-viewer` entry
on the admin plane. The credential itself — granting the login, composing
`GROWTH_READER_DATABASE_URL`, resetting the password — is
`docs/runbooks/secrets/neon-role-password.md`.

## What keeps it from reading anything else

The migration that creates the role (`packages/db/drizzle/0086_growth-reader-role.sql`) is
the enforcement: `NOLOGIN` with no password, so no usable credential exists until an
operator mints one; every table privilege revoked, present and future, so a table added
later is invisible to it by construction; `SELECT` granted on the growth aggregate views
alone. The views run with their definer's privileges, which is what lets an aggregate over
`users` be readable while `users` is not — so a view's body is the whole of what the role
sees. Two tests pin which relations and columns the role reads, in both directions:
`packages/db/src/schema/shape/growth-reader-grants.test.ts` over the migration text,
`packages/db/src/schema/growth-reader-privileges.integration.test.ts` over a live catalog.
Neither reads what a column carries: a migration that redefines a granted view changes
what the role sees with no grant changing and every gate green, so that migration's body
is the only place the change is visible.

The MCP's read-only mode restricts statements, not tables: a read-only connection
authenticated as the project's own role could `SELECT` from `users`. Read-only mode is the
belt; the role is the control.

## Stand it up

1. Grant the role its login and compose `GROWTH_READER_DATABASE_URL`:
   `docs/runbooks/secrets/neon-role-password.md` §Obtain, under that name.
2. Configure the marketer's Neon MCP authenticated with that connection string, in
   read-only mode and scoped to the one project — never with OAuth to a person's Neon
   account, so the MCP holds the role's reach and nothing else. The endpoint and the
   parameters that set mode, project and tool categories are Neon's MCP documentation,
   not this file.
3. Give the marketer's address the `growth-viewer` role on the admin plane: the
   Cloudflare Access policy, `ADMIN_ACTOR_ALLOWLIST` and `ADMIN_ROLE_MAP`
   (`docs/runbooks/secrets/cloudflare-identifiers.md`).

## Prove it

- Connected as `growth_reader`, `SELECT` from `growth_weekly` returns rows; `SELECT` from
  `users` and any `INSERT` are refused (SQLSTATE `42501`). The refusal on `users` is the
  one that matters — it fails only for the migration's role, never for a console-created
  one.
- The marketer signs in to the admin SPA and reaches the Growth page and nothing else.
