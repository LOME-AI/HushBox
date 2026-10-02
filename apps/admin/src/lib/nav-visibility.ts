import type { AdminRole } from '@hushbox/shared';

/** What the filter needs of a nav item; the item type itself lives with the nav. */
interface RoleScopedItem {
  readonly roles: readonly AdminRole[];
}

/**
 * The screens a role is drawn, from this app's own per-screen list — a
 * different question from whether a role may reach a route, which the API
 * answers and this app cannot ask. It decides what is rendered and nothing
 * else: the pipeline's route-roles map refuses a screen's requests for a role
 * it does not list, and the operation engine refuses again at dispatch, so a
 * screen drawn by mistake shows empty panels rather than data.
 *
 * `null` is "the role is not known yet" (the catalog read has not answered) and
 * draws nothing, so a viewer never sees an operator's screens flash by while a
 * request is in flight.
 */
export function visibleNavItems<T extends RoleScopedItem>(
  items: readonly T[],
  role: AdminRole | null
): readonly T[] {
  if (role === null) return [];
  return items.filter((item) => item.roles.includes(role));
}
