/**
 * Public surface of @hushbox/db. Drizzle schema, Zod adapters, client factory,
 * and a small set of operational helpers (evidence, account-deletion events).
 *
 * Note for local-dev contributors: `scripts/ensure-stack` installs a dev-only
 * bookkeeping table named `__stack_meta` plus statement-level triggers on
 * every seed-tracked table. Those objects are NOT in `packages/db/drizzle/`
 * and never reach production — they're created at runtime by
 * `scripts/lib/stack-meta.ts` via raw SQL when `isLocalDev` is true. If you
 * see a `__stack_*` object in a local Postgres and don't recognize it, that's
 * why; ignore it from a schema-modeling standpoint.
 */
export * from './schema/index';
export * from './zod/index';
export * from './client';
export * from './evidence';
export * from './account-deletion-events';
