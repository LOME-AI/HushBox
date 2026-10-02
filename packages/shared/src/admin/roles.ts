/**
 * The admin plane's roles. `operator` is the full plane; `growth-viewer` reads
 * the Growth page and nothing else — no mutation contract may list it, and
 * every admin route it is not listed on refuses it.
 *
 * One source feeding the allowlist parser, the route-to-roles map, each
 * operation contract's `allowedRoles`, and the SPA's navigation filter.
 */
export const ADMIN_ROLES = ['operator', 'growth-viewer'] as const;

/** An admin role. */
export type AdminRole = (typeof ADMIN_ROLES)[number];

/** Narrows a value parsed out of the role-map registry entry, so an unknown role is refused rather than asserted into the type. */
export function isAdminRole(value: string): value is AdminRole {
  return (ADMIN_ROLES as readonly string[]).includes(value);
}
