import type { AdminRole } from '@hushbox/shared';
import type { AdminRouteKey } from '../slices/admin/index.js';

/**
 * # The admin plane's primary authorization control
 *
 * Every `admin`-classed route declares which roles may reach it, in one
 * route-keyed map — the same six-place shape as the rate-limit posture and
 * cache-policy maps. The pipeline's admin stage enforces it after the Access
 * assertion is verified and before any handler runs, and refuses a route this
 * map does not declare for every role, the operator included.
 *
 * The route map, not the operation engine, is where this control belongs. Most
 * of the plane is plain reads — Customer-360, the dashboard, the job queue, the
 * audit trail, the SQL panel — that never reach the engine at all, so a check
 * living only at op dispatch would leave each of them open to any role that
 * authenticated. It also matches the slice charter's rule that ops never check
 * auth and the route layer does.
 *
 * `satisfies Record<AdminRouteKey, readonly AdminRole[]>` on this fresh literal
 * carries both halves of the completeness check: a route the slice serves and
 * this map omits fails to compile, and a key here naming no route is caught by
 * the excess-property check the fresh literal keeps. The composition test
 * additionally walks the assembled router, which is what sees a route the type
 * has lost.
 *
 * The read-only role reaches the operations surface — the catalogue and
 * execute — and nothing else, and each route it may reach lists it explicitly
 * rather than inheriting anything. Those two routes ARE that surface: the
 * catalogue is where a caller learns which role it holds and which operations
 * that role may run, and execute is how it runs one. The two enforcement
 * layers answer different questions — whether a role reaches the surface at
 * all is this map's, and which operations it may run is the contract's own
 * `allowedRoles`, which the engine enforces. Refuse a viewer here and the
 * catalogue filter can never run: the role resolves nowhere, and every read
 * operation is refused before its contract is ever consulted.
 */
export const ADMIN_ROUTE_ROLES = {
  '$get /admin/ops': ['operator', 'growth-viewer'],
  '$get /admin/ops/:name/prefill': ['operator'],
  '$post /admin/ops/:name/preview': ['operator'],
  '$post /admin/ops/:name/execute': ['operator', 'growth-viewer'],
  '$get /admin/users/overview': ['operator'],
  '$get /admin/dashboard': ['operator'],
  '$get /admin/jobs': ['operator'],
  '$get /admin/feedback': ['operator'],
  '$get /admin/feedback/:id': ['operator'],
  '$get /admin/newsletter/issues': ['operator'],
  '$post /admin/newsletter/render': ['operator'],
  '$get /admin/newsletter/subscribers/stats': ['operator'],
  '$get /admin/newsletter/subscribers': ['operator'],
  '$get /admin/models': ['operator'],
  '$get /admin/audit': ['operator'],
  '$get /admin/sql': ['operator'],
} satisfies Record<AdminRouteKey, readonly AdminRole[]>;
