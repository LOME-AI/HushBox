# Caching

How every route's cacheability is declared and enforced, and what can and cannot be
proven about it.

## The policy map and the default-deny stage

Every route's cache policy lives in one map
(`apps/api/src/composition/route-cache-policy.ts`), keyed by the same `AppType`-derived
`RouteKey` as the rate-limit posture map and typed
`as const satisfies Record<RouteKey, CachePolicy>`: a route added without a policy fails
compilation by name, and a key naming no route fails as an excess property. A pipeline
stage (`apps/api/src/middleware/pipeline-cache-policy.ts`) renders the declared policy
onto the response on the unwind and default-denies everything else — an undeclared route,
a request matching no route, matched registrations whose policies disagree, and any
non-200 all get `private, no-store`, replacing (never merging with) whatever the handler
set. Only `private` and `no-store` suppress storage: `no-cache` stores and revalidates,
`max-age=0` stores and serves stale — neither is a substitute. A completed WebSocket
upgrade (`101`) is handed back untouched; the platform never caches a request carrying
`Upgrade: websocket`. The policy vocabulary and its one directive rendering live in
`apps/api/src/lib/cache-policy/`; the stage and every test assert through that rendering,
never through hand-written header strings.

The stage is not decoration on routes that already behaved: before it, most routes
emitted no `Cache-Control` at all, and a header-less 200 is heuristically cacheable —
the platform may store it on its own judgement. Forcing `private, no-store` onto every
undeclared response is what makes that state unreachable.

Consequence for a route author: a new route cannot leak by omission — it can only fail to
cache. A new public read gets no shared caching until its policy is declared, and a
storable declaration carries a proof obligation (§Caller-invariance is proven, not
asserted).

## The storable routes

| Route                                      | Directives                                                                | Tag             | Why this lifetime                                                                                                                                                                                                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /updates/download/:platform/:version` | `public, max-age=86400, immutable`                                        | `ota`           | The body is a published, versioned bundle whose bytes never change under its key. `max-age` rather than `s-maxage` is deliberate: the native updater fetches it, not a browser cross-origin, so it stays outside the CORS wildcard predicate below.                              |
| `GET /announcements/banner`                | `public, s-maxage=60`                                                     | `banner`        | A banner publish becomes visible within a minute with no purge path.                                                                                                                                                                                                             |
| `GET /models`                              | `public, s-maxage=60`                                                     | `catalog`       | The catalog refreshes hourly; the most-trafficked storable route.                                                                                                                                                                                                                |
| `GET /models/:model/:version/:file`        | `public, max-age=31536000, immutable`                                     | `model-weights` | On-device model artifacts (weights, tokenizers, configs, voice blobs) served to the browser. The version is a path segment, so the bytes under a URL never change; a corrected or extended set publishes under a new version rather than overwriting one.                        |
| `GET /public/stats`                        | `public, s-maxage=3600, stale-while-revalidate=600`                       | `stats`         | One anonymized snapshot per day; `stale-while-revalidate` keeps a miss from blocking a reader.                                                                                                                                                                                   |
| `GET /public/roadmap`                      | `public, s-maxage=3600, stale-while-revalidate=600, stale-if-error=86400` | `roadmap`       | Linear-backed; `stale-if-error` serves the last good board through a Linear outage. The 3600 corrected an earlier header claiming 300 while the since-retired Redis read-through in front of it already held the payload for 3600 s — 3600 is what readers were actually served. |

## A Redis-free handler is not a Redis-free route

The roadmap and stats handlers once read through a Redis cache; that read-through is
retired, and each handler recomputes on every request — the roadmap route calls Linear
afresh and holds no copy of the board, pinned in
`apps/api/src/slices/roadmap/routes.integration.test.ts`. That did not make the routes
Redis-independent: each mounts a per-IP throttle, and with Redis unreachable the route
answers 503 before the handler runs. The handler lost its Redis dependency; the route did not.
The handlers' Redis-independence is provable only behind a pipeline with no throttle
mounted, which is exactly how the tests prove it — the mounted throttle is a Redis
consumer in its own right.

## Caller-invariance is proven, not asserted

The claim that licenses storing a response is that every caller gets the same bytes, and
route class is not evidence of it: `GET /chat/trial/remaining` is `routeClass('public')`
and derives its body from the caller's IP hash and `x-trial-token`. So the arch rule
`cacheable-routes-prove-caller-invariance` (`packages/config/arch/rules/`) refuses any
storable declaration that lacks a colocated caller-invariance test — two callers
differing in session, IP-shaped headers, any credential the route could observe, and
query parameters must receive byte-identical bodies (shared helper:
`apps/api/src/test-support/caller-invariance.ts`). Adding a storable declaration without
the proof fails `pnpm arch:check`. The query-parameter arm exists because the query
string is part of the cache key: a route that starts reading one is not leaking, but its
body has begun depending on caller input, and this test is the only guard that a
declared-storable route has not quietly become that.

The same proof observes the declaration's `Cache-Tag`: both responses must carry the tag
the route's declaration renders, and because the arch rule already forces every storable
declaration through this helper, a storable route added later inherits the tag
observation with the proof nobody can omit. The tag is required on every storable
policy, and it buys less than that requirement suggests: the cache partitions by Worker
version, so a deploy starts cold with or without a tag (§The cache partitions by Worker
version). What requiring it keeps open is purging a subset of still-live entries, which
nothing here does. The expectation is derived through
`cacheDirectives(ROUTE_CACHE_POLICIES[route])` — the same computation the pipeline stage
performs — deliberately not read off the map entry's `tag` field, so a change to the
directive rendering moves the expectation with it instead of passing against a header the
rendering had made wrong. The limit of that construction: a wrong tag _value_ in the
policy map moves the stage and the expectation together, so the proof cannot catch it —
the literal per-policy pins in `apps/api/src/composition/route-cache-policy.test.ts` do.
Those same pins are why demoting a storable route to `no-store`, which turns its proof's
tag assertion into a skip rather than a failure, cannot land quietly: the demotion
reddens the pinned storable set.

## A `shared` declaration also grants the CORS wildcard

`apps/api/src/middleware/cors.ts` reads `public` + `s-maxage` off the response — per
response, never per route, so an error body or a 429 never inherits the grant — as its
evidence that a body does not vary with the caller, and grants the cross-origin wildcard
on it. The `immutable` policy kind writes no `s-maxage` and therefore grants no wildcard.
Changing a route's policy kind changes what an unrelated origin may read.

## A cache hit runs nothing

The cache is consulted before the Worker runs. A hit is served with no middleware, no
route-class check, no rate-limit counter, and no log line. For the storable routes, the
declared rate-limit posture bounds only cache misses.

## The cache partitions by Worker version — there is no purge

`apps/api/wrangler.toml` sets `[cache] enabled = true` and deliberately leaves
`cross_version_cache` unset. Unset, the cache partitions by Worker version: "A new
deployment starts from a cold cache and never serves responses that a previous version
wrote" (Cloudflare Cache Keys page, 2026-07-21). Deploy-time invalidation therefore
needs no mechanism — on purge-on-deploy under this default, the same page: "deployments
already start from a cold cache, so this is unnecessary" — and none exists: Workers
Cache purge has no REST endpoint; purging is in-Worker only, via `ctx.cache.purge`, so a
CI deploy step calling a purge API is not a mechanism that could be built.

Sharing entries across versions was considered and dropped as vacuous: the one entry it
would have preserved across a deploy — the 24-hour OTA bundle — is version-scoped in its
own path, and every push to `main` mints a new `APP_VERSION`, so the preserved entry is
one no client can ask for again.

Purge on banner publish is deliberately not built: the 60-second lifetime makes a
publish live within a minute. If a selective purge is ever wanted it is in-Worker code
(`ctx.cache.purge`) run as a registered post-commit effect, never inside an admin op
body — a purge in the body would run on preview, purging the live cache during a
rolled-back rehearsal.

## The kill switch is not an eraser

"Disabling caching does not purge previously cached responses" (Cloudflare). Turning
`cache.enabled` off stops serving from the cache; it deletes nothing. Stored entries
wait out their TTLs, and a configuration that can reach them again inside that window
serves them again. Anyone reaching for the flag during an incident whose cause is a bad
cached body is muting the cache, not erasing it: the entry outlives the flip for up to
its full lifetime (§The storable routes).

## `Vary: Origin` is honoured, and availability depends on it

`apps/api/src/middleware/cors.ts` runs two branches on the same route: an allowlisted
`Origin` gets an echoed `Access-Control-Allow-Origin` plus
`Access-Control-Allow-Credentials: true`; a non-allowlisted or absent `Origin` gets the
wildcard. The SPA's typed client (`apps/web/src/lib/api-client.ts`) defaults every call
to `credentials: 'include'`. If the edge did not partition entries on `Vary`, an SPA
request could be served the wildcard-no-credentials variant and the browser would reject
it outright — the model catalog breaking on the most-trafficked storable route. It does
partition: Workers Cache implements `Vary` per RFC 9110/9111, with no header allowlist
(Cloudflare Workers Cache configuration page, 2026-07-06). Both branches emit
`Vary: Origin`, pinned in `apps/api/src/middleware/cors.test.ts`; the partitioning
itself is platform behaviour, documented but — like every caching behaviour here —
observable only in production (§What no test can prove).

## What no test can prove — permanent, not pending

This feature is not testable locally or in CI, and never will be. `cache.enabled` is
honored by neither `wrangler dev`, Miniflare, nor `@cloudflare/vitest-pool-workers`: the
config key is parsed and validated, then forwarded only into the deploy-time upload
payload — no local runtime consults it. No local run and no test can observe the
platform's caching behaviour; production is the first place it is ever seen. No
automated test can assert a cache hit against a miss, so no regression guard for the
caching behaviour can exist at any point in the future, locally or in CI. Asserting a
miss is equally worthless: locally every request is a miss, so the assertion passes
identically whether the feature works, is misconfigured, or is deleted from the config.

This is a mechanism proven only in production, admissible because it is best-effort and
fails open; the exception and its reasoning are recorded in `docs/DECISIONS.md`.

Do not substitute the classic Cache API: Miniflare emulates `caches.default` and sets
`Cf-Cache-Status` on its results, so it yields plausible-looking `HIT`/`MISS` values that
say nothing about `cache.enabled` — a different product that runs inside the Worker and
cannot skip it, which is precisely the property `cache.enabled` is wanted for.

What IS locally provable is the half carrying the privacy risk: that no response leaves
the Worker in a state a shared cache is permitted to store unless its route declared that
state. `apps/api/src/whole-app/app-cache-storability.integration.test.ts` walks every registration
of the assembled router and asserts exactly that, and it runs in the ordinary suite with
no Cloudflare emulation. What is unprovable is that caching works — a performance
property. A reader who takes away only "it is tested" has been misled; a reader who takes
away only "it is untested" is missing that the tested half is the one where a mistake is
a disclosure rather than a slow response.

## OTA bundles are never republished under an existing version

CI refuses to overwrite a published OTA object, and the guard's recovery message offers
two options: delete the object or bump the version. Only bumping the version is safe.
`max-age=86400, immutable` binds **private** caches — devices that already downloaded the
bundle — which nothing server-side can reach, so delete-and-republish serves different
bytes under the same version and strands already-downloaded clients on checksum-failing
content for up to a day. Bumping the version avoids it entirely.

## Rejected alternatives

- **Zone Cache Rule** — structurally impossible, not merely discouraged: a `Response` a
  Worker constructs itself is never seen by the zone cache, which acts only on `fetch()`
  subrequest responses. No zone configuration can cache these routes.
- **Per-route `caches.default`** — runs inside the Worker, so it saves only the backend
  round trip: not the invocation, not the pipeline, not CPU. It cannot apply to the OTA
  download (a streamed R2 body) or a WebSocket upgrade at all.
- **Service-binding gateway with `ctx.props`** — Cloudflare's documented pattern for
  cookie-authenticated traffic. It requires splitting the product Worker, and the
  modular monolith is not split for this. The default-deny stage is the mitigation in
  its place, and it is stronger against the failure mode the pattern
  guards — a route forgetting to opt out is structurally impossible here; what remains is
  a wrongly declared route, and every storable declaration is a reviewed entry carrying a
  caller-invariance proof.
- **Sharing entries across deploys (`cross_version_cache`) and a deploy-time tag purge**
  — dropped together (§The cache partitions by Worker version): the flag preserved an
  entry no client can request twice, and the purge it would then have required has no
  API to be built on.
