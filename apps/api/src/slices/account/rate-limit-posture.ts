import { bindRoutePosture } from '../../lib/rate-limit/index.js';
import { userSearchRateLimit } from './domain/rate-limit.js';
import type { CarriedRoutePosture, SliceRouteKey } from '../../lib/rate-limit/index.js';
import type { createAccountManifest } from './routes.js';

/**
 * The route keys this slice contributes, derived from its own manifest. A route
 * added, renamed or removed moves this union, so the declaration below stops
 * compiling until it moves with it.
 */
export type AccountRouteKey = SliceRouteKey<ReturnType<typeof createAccountManifest>>;

/**
 * # How this slice's routes are bounded
 *
 * The declaration crosses the slice perimeter as a BOUND COUNTING CAPABILITY,
 * never as a registry entry: `bindRoutePosture` closes over the entry, and a
 * closure's captures have no reflection surface, so the cap, window, key
 * material and the `clear` disarm stay unreachable from everything this module
 * publishes.
 *
 * The username search is the one route with a counter of its own: what it
 * admits is a prefix query against `users`, so it is keyed per account rather
 * than per caller — the route is session-classed, so the authorizer has already
 * refused anyone but a full principal. The counter is spent ahead of the
 * query-schema check and ahead of the membership check on the conversation the
 * query names, either of which answers without touching `users`, so what the
 * window prices is admitted requests rather than queries run.
 *
 * The instructions and accessibility routes touch at most one indexed row for
 * an authenticated user — a body the schema rejects is counted and answered
 * with no row written — so they take their route class's default and this
 * slice owns no entry for them. Nothing in this slice's domain spends a
 * counter, so no route cites one in flow.
 *
 * Every route here but the username search declares `open` on the failure
 * axis. All of them are session-classed, so a caller is one authenticated
 * account and the volume one can buy while a counter is unreachable is bounded
 * by the account rather than by the window; refusing instead would take a
 * signed-in user's own settings away from them for the length of a
 * degradation. The search declares `closed`: what its window admits is a
 * prefix query across `users` rather than the one indexed row every other route
 * here touches, and that window is the only bound on how many such queries one
 * account can ask for.
 */
export const ACCOUNT_ROUTE_POSTURES = {
  '$get /account/users/search': bindRoutePosture({
    failure: 'closed',
    layers: [{ identity: 'user', countedAt: 'edge', definition: userSearchRateLimit }],
  }),
  '$get /account/instructions': { kind: 'default', failure: 'open' },
  '$put /account/instructions': { kind: 'default', failure: 'open' },
  '$delete /account/instructions': { kind: 'default', failure: 'open' },
  '$get /account/preferences/accessibility': { kind: 'default', failure: 'open' },
  '$put /account/preferences/accessibility': { kind: 'default', failure: 'open' },
} satisfies Record<AccountRouteKey, CarriedRoutePosture>;
