/**
 * Public surface of @hushbox/db: the Drizzle schema and the database client
 * factory.
 *
 * Note for local-dev contributors: `scripts/lib/stack/ensure-stack.ts` installs a dev-only
 * bookkeeping table named `__stack_meta` plus statement-level triggers on
 * every seed-tracked table. Those objects are NOT in `packages/db/drizzle/`
 * and never reach production — they're created at runtime by
 * `scripts/lib/stack/stack-meta.ts` via raw SQL when `isLocalDev` is true. If you
 * see a `__stack_*` object in a local Postgres and don't recognize it, that's
 * why; ignore it from a schema-modeling standpoint.
 *
 * Every export here is something this package names and defines — a schema
 * object, the client, a named helper — and what it does is settled by that
 * definition rather than chosen by the caller. Query operators
 * (eq/sql/inArray/and) are deliberately NOT re-exported: an operator hands the
 * caller the choice of SQL, so slice domain/ code could obtain one via
 * @hushbox/db and compose whatever fragment it liked, passing
 * boundaries/dependencies in letter while defeating its intent. That choice,
 * not the return type, is the line a query-fragment helper is judged on —
 * `anyOverflow` emits `bool_or(x)` whatever it is applied to, so a caller gains
 * that one aggregate and no way to build another, while a helper returning
 * whatever SQL its caller handed it would be an operator under another name and
 * stays out. That boundary binds slice layers only, and which of them an infra
 * module may reach is stated in
 * `packages/config/eslint-extensions/boundaries.config.mjs`; this package is
 * not a slice, so its own modules import operators freely.
 */
export * from './schema/index';
export * from './client';
export * from './evidence';
export * from './schema/growth-overflow';
export * from './schema/growth-landing-clamp';
