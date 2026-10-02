import { bindRoutePosture } from '../../lib/rate-limit/index.js';
import { growthBeaconIpRateLimit } from './domain/rate-limit.js';
import type { CarriedRoutePosture, SliceRouteKey } from '../../lib/rate-limit/index.js';
import type { createGrowthManifest } from './routes.js';

/**
 * The route keys this slice contributes, derived from its own manifest. A route
 * added, renamed or removed moves this union, so the declaration below stops
 * compiling until it moves with it.
 */
export type GrowthRouteKey = SliceRouteKey<ReturnType<typeof createGrowthManifest>>;

/**
 * # How this slice's routes are bounded
 *
 * The declaration crosses the slice perimeter as a BOUND COUNTING CAPABILITY,
 * never as a registry entry: `bindRoutePosture` closes over the entry, and a
 * closure's captures have no reflection surface, so the cap, window and key
 * material stay unreachable from everything this module publishes.
 *
 * The beacon is the slice's only route and its only counter, and the slice
 * spends nothing in its own domain. What the window bounds is how fast one
 * address can open Redis sets and, on a registry miss, reach Postgres.
 *
 * It declares `open`, and the reason is the whole point of the route: a
 * counter outage must never take a marketing page down. The route already
 * answers the same 204 when Redis cannot be reached, so refusing here would
 * make the request LOUDER than the failure it is standing in for, on the one
 * surface where nobody is waiting for an answer. Every layer is counted at the
 * edge, which is what makes `open` honourable rather than half-kept — and what
 * an unspendable counter admits is uncounted beacons, which write nothing a
 * caller can see and are bounded past that by the ceilings the write script
 * enforces on its own: the set and index ceilings bound what a flood can store,
 * and the mint ceiling bounds what one address can add to a count, which is the
 * half a bound on storage leaves open.
 */
export const GROWTH_ROUTE_POSTURES = {
  '$post /e': bindRoutePosture({
    failure: 'open',
    layers: [{ identity: 'ip', countedAt: 'edge', definition: growthBeaconIpRateLimit }],
  }),
} satisfies Record<GrowthRouteKey, CarriedRoutePosture>;
