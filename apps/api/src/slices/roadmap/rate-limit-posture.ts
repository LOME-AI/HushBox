import { bindRoutePosture } from '../../lib/rate-limit/index.js';
import { roadmapIpRateLimit } from './domain/index.js';
import type { CarriedRoutePosture, SliceRouteKey } from '../../lib/rate-limit/index.js';
import type { createRoadmapManifest } from './routes.js';

/**
 * The route keys this slice contributes, derived from its own manifest. A route
 * added, renamed or removed moves this union, so the declaration below stops
 * compiling until it moves with it.
 *
 * `/public`, this slice's base path, is shared with a sibling manifest, so a
 * derivation over the mounted paths would sweep in the sibling's route. This
 * one reads this slice's own manifest and prefixes it, so that route is not in
 * this union and cannot be declared here; the colocated test pins the union to
 * the single key rather than leaving that to inspection.
 */
export type RoadmapRouteKey = SliceRouteKey<ReturnType<typeof createRoadmapManifest>>;

/**
 * # How this slice's routes are bounded
 *
 * The declaration crosses the slice perimeter as a BOUND COUNTING CAPABILITY,
 * never as a registry entry: `bindRoutePosture` closes over the entry, and a
 * closure's captures have no reflection surface, so the cap, window, key
 * material and the `clear` disarm stay unreachable from everything this module
 * publishes.
 *
 * The roadmap read is unauthenticated and its only cache is the edge, declared
 * in the route cache-policy map. An edge miss reaches Linear, so this window
 * bounds how often a caller that varies the query string to miss the
 * edge can force that fetch. It is the slice's only route and its only counter, and the
 * slice spends nothing in its domain.
 *
 * It declares `open`, and this is the row where that costs the most: an edge
 * miss reaches a third party, so an unspendable counter leaves the fetch rate
 * against Linear bounded by the edge cache alone. It is declared open anyway
 * because the window guards nothing secret and refusing takes a public page
 * down; the counterweight is written here rather than left implicit, because a
 * route whose flood lands on someone else's API is the one a reviewer should
 * meet the argument for.
 */
export const ROADMAP_ROUTE_POSTURES = {
  '$get /public/roadmap': bindRoutePosture({
    failure: 'open',
    layers: [{ identity: 'ip', countedAt: 'edge', definition: roadmapIpRateLimit }],
  }),
} satisfies Record<RoadmapRouteKey, CarriedRoutePosture>;
