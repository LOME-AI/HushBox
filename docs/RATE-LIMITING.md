# Rate limiting

How every route's rate-limit posture is declared, keyed, counted, and what happens when
Redis is down. The counting primitive's contract — one counting implementation, exactly
`maxAttempts` admitted under any concurrency — is in `docs/CODE-RULES.md` §Security;
the implementation is `apps/api/src/lib/rate-limit/`, and this doc is the architecture
around it.

## The posture map

Every route's posture is declared by the slice that serves it, in that slice's
`rate-limit-posture.ts`: one object literal checked against the slice's own route-key
union, derived from its manifest. The composition root merges the slice fragments with
the routes it mounts from outside `slices/` into the one map the pipeline reads
(`apps/api/src/composition/rate-limit-posture.ts`), checked against `RouteKey`, which
derives from `AppType`. A route added without a posture fails compilation by name, in
its fragment and again at the merge. A renamed or deleted route fails as an excess
property in its fragment only: that check holds while the literal is fresh, a spread
carries none, and the arch rule `posture-fragments-satisfy-a-fresh-literal` holds every
fragment to a fresh literal for exactly that reason. The pipeline default-denies a
matched route whose posture is absent, so the runtime backstops the compiler rather
than trusting it.

The property that makes the map safe is that it **reads** `AppType` and never modifies
it: the map is a consumer exactly like the typed client, so it cannot degrade
route-chain inference. A registration wrapper — declare the posture where the route is
defined, wrap the chain — was tried and rejected: the wrapped chain compiled clean at
the call site while producing a schema not mutually assignable with the native chain,
degrading the very type it depended on. Do not re-propose it.

Neither check sees a slice `AppType` has silently lost — a manifest or handler
annotated instead of inferred (`apps/api/CLAUDE.md` §Routes): the slice's route-key
union collapses to nothing, and a fragment checked against an empty union satisfies it
vacuously, stale keys included. Two witnesses stand where the compiler cannot. Each
slice's posture test asserts at the type level that the slice's route-key union is
non-empty, paired with a control showing an annotated router yields none, so an erased
slice fails `pnpm typecheck`. And the composition root's posture test walks the
assembled router, so a route the type has lost but the router serves without a
declaration fails as a test rather than passing as a compile.

The map is also checked in the direction a declaration cannot assert: from every line
that spends a counter to the route citing it. The whole-app walk
`apps/api/src/whole-app/app-flow-counter-citations.test.ts` reads each `consume` and
`consumeLayers` call and resolves the entry named there, which constrains how a spend
is written: the entry is a registry expression at the call itself. An entry that
arrives through a parameter is attributable only by registering the parameter as a
root with every value it can carry, and every route sharing that site then shares one
citation. The walk fails on anything it cannot read rather than passing over it, and
it is a whole-app test: a spend-site refactor is proven by `pnpm test:api`, not by the
slice's own tests.

## A cache hit runs no counter

Workers Cache is consulted before the Worker runs, so a request served from the edge
cache reaches no middleware and no counter. For a route declared storable in the
cache-policy map, the posture bounds only cache misses.

## The posture kinds

- **Named limit** — registry entries of its own, each with a tuned cap and window. Every
  security surface is one. Each layer of a named posture declares where it counts:
  `edge`, where the pipeline stage derives the key, or `flow`, where the key exists only
  once the slice's domain has resolved something and that domain's own `consume` call is
  the counter.
- **Default** — the route's class default (§Class defaults).
- **Exemption** — typed, one of the classes below, each with a structural
  obligation a rule checks.

## The two identity vocabularies

An identity names who a counter counts. Two closed vocabularies exist, split by where
the identity can be resolved, and a layer's `countedAt` fixes which one it may name
(`apps/api/src/lib/rate-limit/posture.ts`):

- **Edge identities** resolve from the request and the already-resolved principal
  alone — no database read, no body parse — so the pipeline stage spends them before
  the handler runs. That is what lets them be a closed enum rather than middleware
  factories.
- **Flow-only identities** are claims the caller supplies — the account it names, the
  token it presents, the share it cites — that only the owning slice's flow can
  resolve; that flow's own `consume` call is the counter. Naming one on an edge layer
  is a compile error. A flow-only identity can pair a claim with the network the
  claim came from (`claimed-account-per-network`); when a window keys on the pair
  rather than on the claim alone is §IP layers are earned, not defaulted.

A layer's declared identity is the only statement of what it counts. A counter's key
segments do not name the identity its layer is declared on; read the declaration,
never the key.

## Class defaults

Every route class carries one default: the edge identity it counts and a cap per
window. The map of record is `CLASS_DEFAULTS` in
`apps/api/src/lib/rate-limit/class-default.ts`, with each row's reasoning beside it;
neither identity nor cap is restated here.

A default is qualified by route: each route of a class has its own window per
identity, so a burst on one route never spends a sibling route's window, and no
class-wide aggregate exists.

The caps are reasoned, not measured. A class default is a backstop, not policy —
roughly an order of magnitude above real peak: high enough that no legitimate user
meets it, low enough to stop a script. Anything needing a tuned number is a named
limit instead.

## Failure posture

The most important section of this document.

**Failure posture is declared per route.** Every counted limit — named or default —
carries `open` or `closed` in the posture map; neither the limit's kind nor the route's
class implies it. A caller past the cap is refused (429) under either posture. The
posture decides only what happens when the bound cannot be spent — no counter
reachable, or no identity to key it on: `closed` refuses the request (503), and the
refusal is captured as every availability refusal is, under the `dependency_unavailable`
fingerprint tagged with the dependency, the failure arm and the route — `redis` for an
unreachable counter store, `unknown` for a missing identity; `open` admits it and reports
the bypass to Sentry under the `rate_limit_bypassed` fingerprint, tagged with the route
and the cause. Each report is throttled to one event per isolate per window — the
availability capture per dependency and failure arm, the bypass report across both its
causes (`BYPASS_REPORT_WINDOW_MS` in the pipeline stage) — so an event is evidence that
the outage or the bypass occurred, never a count, and one bypass cause's report can
silence the other's for that window. The two reports latch separately: one store outage
meets both postures on different routes at once, and an operator diagnosing it needs
both halves. `open` is accepted only when
every layer of the route is
edge-counted: the pipeline spends edge layers and can admit past an unspendable one,
but a flow-counted layer is spent by the slice's own `consume` call, which the
pipeline never reaches, so `bindRoutePosture` rejects `open` on any route carrying a
flow layer. Slice code cannot turn a counter error into admission either (lint rule
`rate-limit/fails-closed`).

**Which value a route declares is one question:** with the counter unspendable, is it
worse to refuse this route or to admit it uncounted? `closed` where the counter is the
only thing between a caller and something expensive or secret — an outage-long flood
that costs real money (inference, external APIs, R2 egress, card processing, email) or
weakens a secret (password, TOTP, recovery phrase, token guessing). `open` where
refusing would break the product for legitimate users and the outage-time abuse
ceiling is already bounded by authentication — or, on a best-effort surface that spends
nothing, where the route's own write bounds what an uncounted flood can do: the marketing
beacon answers 204 whatever happens, and its counting script's ceilings cap what a flood
can store and what one address can add (`docs/GROWTH-MEASUREMENT.md`). The fragment that declares a route
records its answer per row; this is the assignment rule those fragments cite.

The reasoning matters more than the rule: letting an unauthorized request through is a
security bypass; letting an extra request through is a capacity event. Stripe states
this directly in [Scaling your API with rate limiters](https://stripe.com/blog/rate-limiters),
and it is near-universal guidance — rate limiting fails open, authorization fails
closed. `open` buys less than it appears to. `GET /billing/balance` declares it and
its handler reads no Redis, yet with Redis down a request carrying a session reaches
the session stage's revocation check first, which fails closed with 503 whatever the
route's posture says. An `open` posture protects a route against a fault confined to
the limiter — a counter error, an identity the edge left unresolvable — and against a
store outage only for a request no earlier stage sends to that store (`docs/CACHING.md`
§A Redis-free handler is not a Redis-free route makes the same point about the
throttle itself). Fail-open without the bypass report is the actual vulnerability;
fail-open with it is a visible capacity risk.

The middle path — fail closed on a blip, open on a sustained outage — is a circuit
breaker, and `docs/DECISIONS.md` §Deliberate limits excludes in-isolate breakers.
Do not re-propose it here.

## Webhooks never reject

Signature verification runs before any I/O and IS the bound: junk volume cannot
present a valid provider signature, so it is refused before touching the database.
Verified events acknowledge fast and process as jobs — the one-row-per-provider-event-id
tables and the jobs system are built for exactly this. No rejecting limiter sits on the
webhook path: a 429 either triggers provider retries that add load or, with a sender
whose retry logic is weak, silently loses the event — and "we assumed the provider
retries" is how events get lost quietly. If flooding ever becomes real, the answer is
an edge allowlist of the providers' published IP ranges, where a rejection never
reaches application code.

## The exemption classes

Each class carries a structural obligation a rule checks:

- **`signature-gated-webhook`** — the verifier must run before any I/O.
- **`constant-cost`** — the handler may not touch database, Redis, bucket, or `fetch`.
  Health and the served-version route qualify; the announcements banner does not — it
  reads the database.

A further class, `single-use-token-handoff`, was designed and dropped: its justification
was the weakest-sourced claim in the research, and its poster route turned out to be an
unlimited secret-guessing surface — the class would have blessed a hole rather than
exempted a protected route. The self-DoS hazard it was built on is resolved by layered
keying, never by the absence of a limit.

## Layered limits are all-or-nothing

A request refused by one layer must leave every other layer's counter untouched.
Otherwise an attacker sharing an IP drains a legitimate user's personal budget with
requests that were never admitted — recreating the hazard layering exists to prevent.

The competing constraint: the counter must keep advancing past the cap **on the
refusing layer**, because a crossing has to stay one distinguishable count. The login
lockout email fires exactly once, on the count that crosses the account-wide ceiling,
and a per-network crossing mails nobody: it refuses one network, not the account, and
a guesser holding many addresses would otherwise mail the owner once per address (the
ceiling-crossing predicate in `apps/api/src/slices/identity/domain/opaque/login.ts`).
Every refusing layer advances past its cap; which crossing notifies is the flow's
question, answered per layer. So the script checks every layer, then increments all
layers when none refuses, or only the refusing layers when some do; a refusal is
attributed to the first refusing layer in declaration order, so a flow declares the
layer whose refusal should answer ahead of the others. Cost is one Redis round trip
regardless of layer count.

## The counting script

The atomicity ground is the script's atomic execution — Redis blocks all other
activity for a script's duration — not any single command's return value. The logic
must never split across round trips: between two calls, anything can interleave.

Two Redis facts for whoever touches the script:

- Do not add a `#!lua` shebang. On real Redis, declaring a script version removes the
  default cross-slot key allowance the layered keys rely on.
- A migration to genuine OSS Redis Cluster would make layered keys un-co-slottable.
  That is a re-entry condition, not a present constraint.

## IP layers are earned, not defaulted

Default layering is user-keyed only, on authenticated routes. An IP layer is added
where the surface is expensive or sessionless, and sized with a written rationale —
the model is the media slice's registry header
(`apps/api/src/slices/media/domain/rate-limit.ts`), which sizes the guest-IP window at
a multiple of the per-caller cap so that a second guest behind one IPv6 /64 is not the
first casualty. The cost of an IP layer is not compute; it is the per-route judgement
of how many legitimate users plausibly share one network on that surface, and a
default cannot make that judgement.

The card charge (`POST /billing/payments`) is the other worked case: an address layer
ahead of an account-keyed layer, declared `closed` because the counter is the only
thing between a caller and card processing. The cost is written beside the sizing in
the billing registry (`apps/api/src/slices/billing/domain/rate-limit.ts`, §"Which
layer answers whom" and §"The arithmetic"): the address layer can refuse an honest
payer behind a shared address, and it is sized as a multiple of the per-account cap so
that several honest payers behind one address fit under it.

The composite pair is the third shape, for a window keyed on a claim rather than on a
principal. A counter that anyone able to name an account can spend is a denial lever
as well as a guessing bound: one address can drain it and hold the owner out of the
route. The model is the lockout pairs in the identity registry
(`apps/api/src/slices/identity/domain/keys.ts`): the window a caller meets keys on the
named account _and_ the network the attempt came from
(`claimed-account-per-network`), so what one network spends is its own, and an
account-wide ceiling above it keeps the brute-force bound a per-network window cannot
supply against a botnet — sized as a multiple of the per-network cap, the multiple's
reasoning written beside each entry. A separate address layer is the wrong shape
here: it bounds the address and leaves the named account's own window spendable from
one.

## Excluded: the Workers rate-limit binding

Cloudflare's native rate-limit binding does no network round trip, which is
attractive, and is excluded anyway: its counter is per-colo and per-isolate-cached —
the [Workers rate-limit binding documentation](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
calls it "intentionally designed to not be used as an accurate accounting system" —
its windows are restricted to 10 or 60 seconds, and its counters cannot be seeded or
inspected, so CI cannot test it deterministically. Adopting it would also break
"one counting implementation, no exceptions." Re-entry: sustained Redis cost pressure,
in the style of `ARCHITECTURE.md`'s Hyperdrive deferral.
