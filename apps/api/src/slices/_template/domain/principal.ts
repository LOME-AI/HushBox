import type { Principal } from '../../../lib/context/index.js';

/**
 * The caller's identity, taken ONLY from the pipeline principal — never from
 * client input. A `session`-class route is guaranteed a full principal by the
 * authorizer, so anything else reaching here is a composition defect
 * (throw → 500), not an expected error.
 */
export function callerUserId(principal: Principal): string {
  if (principal.kind !== 'full') {
    throw new Error('template: session route reached without a full principal');
  }
  return principal.claims.userId;
}
