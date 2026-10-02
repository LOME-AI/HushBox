import type { Principal } from '../../../lib/context/index.js';

/**
 * The caller's identity, taken ONLY from the pipeline principal — never from
 * client input. Only `session`-class handlers call this (the slice also serves
 * `public` guest-reachable routes, which resolve their caller from the link
 * credential instead), and for those the authorizer guarantees a full principal
 * before the handler runs; anything else reaching this function is a
 * composition defect (throw → 500), not an expected error.
 */
export function callerUserId(principal: Principal): string {
  if (principal.kind !== 'full') {
    throw new Error('conversations: session route reached without a full principal');
  }
  return principal.claims.userId;
}
