import { bindRoutePosture } from '../../lib/rate-limit/index.js';
import { catalogListIpRateLimit } from './domain/rate-limit.js';
import type { CarriedRoutePosture, SliceRouteKey } from '../../lib/rate-limit/index.js';
import type { createModelsManifest } from './routes.js';

/**
 * The route keys this slice contributes, derived from its own manifest. A route
 * added, renamed or removed moves this union, so the declaration below stops
 * compiling until it moves with it.
 */
export type ModelsRouteKey = SliceRouteKey<ReturnType<typeof createModelsManifest>>;

/**
 * # How this slice's routes are bounded
 *
 * The declaration crosses the slice perimeter as a BOUND COUNTING CAPABILITY,
 * never as a registry entry: `bindRoutePosture` closes over the entry, and a
 * closure's captures have no reflection surface, so the cap, window, key
 * material and the `clear` disarm stay unreachable from everything this module
 * publishes.
 *
 * The catalog list is unauthenticated by design — the marketing site's welcome
 * page reads it in the visitor's browser and the picker loads it before login —
 * and costs one catalog read per request, so it carries a per-IP window. The
 * entry is this slice's own, so it is in scope here without leaving the slice.
 *
 * It declares `open`: the window guards nothing secret and nothing that leaves
 * this Worker — one catalog read, on a route declared storable at the edge —
 * while refusing takes the model picker away from every caller before login,
 * including the ones with no session for the pipeline to have refused earlier.
 * An unspendable counter here is a capacity question, never a security one.
 */
export const MODELS_ROUTE_POSTURES = {
  '$get /models': bindRoutePosture({
    failure: 'open',
    layers: [{ identity: 'ip', countedAt: 'edge', definition: catalogListIpRateLimit }],
  }),
} satisfies Record<ModelsRouteKey, CarriedRoutePosture>;
