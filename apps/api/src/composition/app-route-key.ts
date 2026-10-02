import type { ExtractSchema } from 'hono/types';
import type { RouteKeyOf } from '../lib/rate-limit/index.js';
import type { AppType } from '../app.js';

/**
 * # What the key type witnesses
 *
 * `RouteKey` is READ off `AppType` — the same type the `hc` client consumes —
 * so this type is a consumer of the route schema and can never widen or degrade
 * it. Of the two properties a reader expects from the
 * `satisfies Record<RouteKey, RoutePosture>` witness `ROUTE_POSTURES` carries in
 * `apps/api/src/composition/rate-limit-posture.ts`, that witness holds one:
 *
 * - a route present in `AppType` and absent from that map fails to compile,
 *   naming the missing key. That half is an assignability failure, so the
 *   spreads the map is assembled from leave it intact;
 * - a key in that map that names no route does NOT fail there. Excess-property
 *   checking reaches only a fresh object literal, and every key in that map
 *   arrives through a spread. Each half of the merge carries that check on its
 *   own fresh literal instead: a slice's on the literal its own
 *   `rate-limit-posture.ts` declares, checked against that slice's route-key
 *   union, and the app-level half on the literal `APP_ROUTE_POSTURES` declares
 *   in that same composition module. The arch rule
 *   `posture-fragments-satisfy-a-fresh-literal` is what keeps the slice half
 *   that way, refusing a fragment whose `satisfies` clause does not sit on a
 *   fresh literal. In the ASSEMBLED map, a key naming no route is caught by
 *   `apps/api/src/composition/rate-limit-posture.test.ts`, which walks the
 *   assembled router and reports every declared key it serves no route for.
 *
 * Neither half reaches a route the router serves on a slice `AppType` has
 * ALREADY lost to the documented silent-erasure hazard, where an annotated
 * sub-router widens to `BlankSchema`: such a route reaches `RouteKey` as no key
 * at all, so nothing in that map is missing. Erasing a slice whose routes ARE
 * declared in it is not caught by the compiler either — a slice's route-key
 * union is derived from that same sub-router, so erasure empties the union too,
 * and a fragment checked against an empty key union satisfies it vacuously with
 * every key it declares intact. What catches erasure is the type-level
 * assertion each slice's posture test makes on its own key union — that the
 * union is non-empty, paired with a control erasing the sub-router — and the
 * reader of that assertion is this package's `tsc --noEmit` gate, never the
 * test run, where `expectTypeOf` is a no-op. A route the type has lost and
 * that map does not declare is caught at runtime instead, by that same
 * composition test walking the assembled router: the compiler proves the map
 * COMPLETE against the type, and the tests prove the type against the router.
 */

export type RouteKey = RouteKeyOf<ExtractSchema<AppType>>;
