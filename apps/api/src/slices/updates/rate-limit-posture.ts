import { bindRoutePosture } from '../../lib/rate-limit/index.js';
import { bundleDownloadIpRateLimit } from './domain/rate-limit.js';
import type { CarriedRoutePosture, SliceRouteKey } from '../../lib/rate-limit/index.js';
import type { createUpdatesManifest } from './routes.js';

/**
 * The route keys this slice contributes, derived from its own manifest. A route
 * added, renamed or removed moves this union, so the declaration below stops
 * compiling until it moves with it.
 */
export type UpdatesRouteKey = SliceRouteKey<ReturnType<typeof createUpdatesManifest>>;

/**
 * # How this slice's routes are bounded
 *
 * The declaration crosses the slice perimeter as a BOUND COUNTING CAPABILITY,
 * never as a registry entry: `bindRoutePosture` closes over the entries, and a
 * closure's captures have no reflection surface, so the caps, windows, key
 * material and the `clear` disarm stay unreachable from everything this module
 * publishes.
 *
 * The version read touches no store — it answers from the request header, the
 * Worker's own bindings and the dev-only in-memory override — so a flood of it
 * reaches nothing behind the Worker, which is the obligation `constant-cost`
 * names. The bundle download is the opposite: unauthenticated, and what it
 * admits is one R2 object fetch, so it carries the per-IP window this slice
 * owns.
 *
 * The download declares `closed`, and what it trades is R2 egress. A cache hit
 * is served before this Worker runs at all, so what an unspendable counter
 * fails to bound is the MISS rate rather than the request rate — and the edge
 * declaration the route carries absorbs the honest fetch rate while bounding a
 * determined caller not at all. The query string is part of the platform's
 * cache key (`docs/CACHING.md`), so appending one mints a fresh key for the
 * same bundle, and every such request is a miss that reaches this Worker. The
 * window is spent ahead of the path-parameter check and the object lookup, so
 * it also counts misses that stream nothing; a miss naming a published bundle
 * streams it, and nothing but the counter stands between that caller and
 * unmetered egress, so the cost of refusing — every installed app stopped from taking an
 * update for the length of a degradation — is the one this row accepts. The
 * version read carries no failure declaration at all, because an exemption
 * reaches no counter to be unable to spend.
 */
export const UPDATES_ROUTE_POSTURES = {
  '$get /updates/current': { kind: 'exempt', exemption: 'constant-cost' },
  '$get /updates/download/:platform/:version': bindRoutePosture({
    failure: 'closed',
    layers: [{ identity: 'ip', countedAt: 'edge', definition: bundleDownloadIpRateLimit }],
  }),
} satisfies Record<UpdatesRouteKey, CarriedRoutePosture>;
