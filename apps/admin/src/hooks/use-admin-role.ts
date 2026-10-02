import { useOps } from '@/hooks/use-ops';
import type { AdminRole } from '@hushbox/shared';

/**
 * The caller's admin role, as the plane resolved it. It rides the ops catalog
 * rather than a route of its own: that read is already made on every screen
 * that renders an op, its response is already filtered by the same role, and a
 * second endpoint would be a second answer to one question.
 *
 * `null` until the read answers — including when it fails, because a role the
 * SPA guessed would draw screens the API then refuses.
 */
export function useAdminRole(): AdminRole | null {
  return useOps().data?.role ?? null;
}
