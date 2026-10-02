import { bindRoutePosture } from '../../lib/rate-limit/index.js';
import { statsIpRateLimit } from './domain/index.js';
import type { CarriedRoutePosture, SliceRouteKey } from '../../lib/rate-limit/index.js';
import type { createStatsManifest } from './routes.js';

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
export type StatsRouteKey = SliceRouteKey<ReturnType<typeof createStatsManifest>>;

/**
 * # How this slice's routes are bounded
 *
 * The declaration crosses the slice perimeter as a BOUND COUNTING CAPABILITY,
 * never as a registry entry: `bindRoutePosture` closes over the entry, and a
 * closure's captures have no reflection surface, so the cap, window, key
 * material and the `clear` disarm stay unreachable from everything this module
 * publishes.
 *
 * The stats read is unauthenticated and its only cache is the edge, declared
 * in the route cache-policy map. An edge miss reaches Postgres, so this window
 * bounds how often a caller that varies the query string to miss the
 * edge can force that read. It is the slice's only route and its only counter, and the slice
 * spends nothing in its domain.
 *
 * It declares `open` on the same ground the catalog read does: what an
 * unspendable counter exposes is one anonymized snapshot read per edge miss,
 * where refusing takes a public page down for no security reason.
 */
export const STATS_ROUTE_POSTURES = {
  '$get /public/stats': bindRoutePosture({
    failure: 'open',
    layers: [{ identity: 'ip', countedAt: 'edge', definition: statsIpRateLimit }],
  }),
} satisfies Record<StatsRouteKey, CarriedRoutePosture>;
