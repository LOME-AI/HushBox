import type { CarriedRoutePosture, SliceRouteKey } from '../../lib/rate-limit/index.js';
import type { createNotificationsManifest } from './routes.js';

/**
 * The route keys this slice contributes, derived from its own manifest. A route
 * added, renamed or removed moves this union, so the declaration below stops
 * compiling until it moves with it.
 */
export type NotificationsRouteKey = SliceRouteKey<ReturnType<typeof createNotificationsManifest>>;

/**
 * # How this slice's routes are bounded
 *
 * By nothing this slice owns. Every route here is session-classed and writes or
 * reads at most one row for the calling user — a device token, a web-push
 * subscription, the preference set. A body the schema rejects, and a delete
 * naming no token of the caller's, are each counted and touch no row. So each
 * takes its route class's default; this slice owns no registry entry, and its
 * domain spends no counter. The fragment therefore binds nothing and publishes
 * no callable at all.
 *
 * Sending is not a route: delivery runs from jobs and domain events, so the
 * outbound volume this slice produces is bounded by what enqueues it, never by
 * a window on an HTTP path.
 *
 * Every route declares `open` on the failure axis: each is session-classed and
 * writes or reads at most one row for the calling account, so an unspendable
 * counter leaves the volume bounded by that account, while refusing would
 * silently stop a device registering for push during a degradation.
 */
export const NOTIFICATIONS_ROUTE_POSTURES = {
  '$post /notifications/device-tokens': { kind: 'default', failure: 'open' },
  '$delete /notifications/device-tokens/:token': { kind: 'default', failure: 'open' },
  '$post /notifications/web-subscriptions': { kind: 'default', failure: 'open' },
  '$get /notifications/preferences': { kind: 'default', failure: 'open' },
  '$put /notifications/preferences': { kind: 'default', failure: 'open' },
} satisfies Record<NotificationsRouteKey, CarriedRoutePosture>;
