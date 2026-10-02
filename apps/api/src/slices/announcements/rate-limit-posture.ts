import type { CarriedRoutePosture, SliceRouteKey } from '../../lib/rate-limit/index.js';
import type { createAnnouncementsManifest } from './routes.js';

/**
 * The route keys this slice contributes, derived from its own manifest. A route
 * added, renamed or removed moves this union, so the declaration below stops
 * compiling until it moves with it.
 */
export type AnnouncementsRouteKey = SliceRouteKey<ReturnType<typeof createAnnouncementsManifest>>;

/**
 * # How this slice's routes are bounded
 *
 * By nothing this slice owns. The banner read is public but answers one row
 * that is user-agnostic and edge-cached for a minute; the two dismissal routes
 * are session-classed and touch at most one row per user — each validates its
 * query or body after the counter is spent, so a rejected request is counted
 * and touches none. All three take their route class's default, this slice
 * owns no registry entry, and its domain spends no counter — so the fragment binds nothing and publishes no callable at all.
 *
 * All three declare `open` on the failure axis. The dismissals are bounded by
 * the account that owns the row. The banner read is the one unauthenticated
 * route here, and it is declared storable for a minute, so a flood meets the
 * edge cache rather than the Worker; what refusing would cost is the banner on
 * every app load for the length of a degradation, against one user-agnostic row
 * read per cache miss.
 */
export const ANNOUNCEMENTS_ROUTE_POSTURES = {
  '$get /announcements/banner': { kind: 'default', failure: 'open' },
  '$get /announcements/banner/dismissal': { kind: 'default', failure: 'open' },
  '$put /announcements/banner/dismissal': { kind: 'default', failure: 'open' },
} satisfies Record<AnnouncementsRouteKey, CarriedRoutePosture>;
