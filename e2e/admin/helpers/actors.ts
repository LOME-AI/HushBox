/**
 * The operator pool the admin specifications authenticate as, both admitted by
 * the API's dev-mode `ADMIN_ACTOR_ALLOWLIST` and mapped to the operator role
 * there (`packages/shared/src/env/env.config.ts`).
 *
 * It is neither a copy of that allowlist nor of the admin SPA's own actor list
 * (`apps/admin/src/lib/dev-actor.ts`), and it is not meant to become one: both
 * of those additionally carry a read-only growth viewer, whose authorization is
 * narrower than the mutations these specifications drive. Two lists that serve
 * different purposes need not agree, so this one is the operators and stays
 * two.
 */
export const DEV_ADMIN_ACTORS = ['admin@hushbox.test', 'ops@hushbox.test'] as const;

export type DevAdminActor = (typeof DEV_ADMIN_ACTORS)[number];
