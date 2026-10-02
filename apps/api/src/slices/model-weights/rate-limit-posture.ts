import { bindRoutePosture } from '../../lib/rate-limit/index.js';
import { modelArtifactDownloadIpRateLimit } from './domain/rate-limit.js';
import type { CarriedRoutePosture, SliceRouteKey } from '../../lib/rate-limit/index.js';
import type { createModelWeightsManifest } from './routes.js';

/**
 * The route keys this slice contributes, derived from its own manifest. A route
 * added, renamed or removed moves this union, so the declaration below stops
 * compiling until it moves with it.
 */
export type ModelWeightsRouteKey = SliceRouteKey<ReturnType<typeof createModelWeightsManifest>>;

/**
 * # How this slice's routes are bounded
 *
 * The declaration crosses the slice perimeter as a BOUND COUNTING CAPABILITY,
 * never as a registry entry: `bindRoutePosture` closes over the entries, and a
 * closure's captures have no reflection surface, so the caps, windows, key
 * material and the `clear` disarm stay unreachable from everything this module
 * publishes.
 *
 * The artifact download is unauthenticated and what it admits is one R2 object
 * fetch, so it carries the per-IP window this slice owns.
 *
 * It declares `closed`, and the edge declaration it carries is not a reason to
 * declare otherwise. A cache hit is served before this Worker runs at all, so
 * what an unspendable counter fails to bound is the MISS rate rather than the
 * request rate — and the declaration absorbs the honest fetch rate while
 * bounding a determined caller not at all. The query string is part of the
 * platform's cache key (`docs/CACHING.md`), so appending one mints a fresh key
 * for the same published object, and every such request is a miss that reaches
 * this Worker. The window is spent ahead of the path-parameter check and the
 * object lookup, so it also counts misses that stream nothing; a miss naming a
 * published object streams the whole artifact, and nothing but the counter
 * stands between that caller and unmetered R2 egress, which is the side of the
 * question egress sits on: refusing costs published artifacts for the length
 * of a degradation, where admitting costs bytes that cannot be un-served.
 */
export const MODEL_WEIGHTS_ROUTE_POSTURES = {
  '$get /models/:model/:version/:file': bindRoutePosture({
    failure: 'closed',
    layers: [{ identity: 'ip', countedAt: 'edge', definition: modelArtifactDownloadIpRateLimit }],
  }),
} satisfies Record<ModelWeightsRouteKey, CarriedRoutePosture>;
