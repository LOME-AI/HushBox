# Product Worker (apps/api)

The Hono product Worker — vertical slices under `src/slices/`, shared machinery under
`src/lib/`. System map and doctrine: `docs/ARCHITECTURE.md` + `docs/CODE-RULES.md`.
The rules below are the working knowledge specific to this tree.

## Routes

- Every route declares exactly one **route class** as its **first handler** via
  `routeClass(…)`: `public` · `session` · `pending-2fa` · `billing-token` · `dev-only`.
  An undeclared route is default-denied (403). `dev-only` routes 404 in production.
  Link-guest and trial-session **principals** are refused at HTTP for all classes. That
  is a belt, not the guest gate: a link guest never presents a principal at all —
  `derivePrincipal` sees no cookie, yields `none`, and the `public` class admits it.
  **A guest-reachable route is therefore `public` plus an in-handler credential gate**,
  which resolves the guest from `X-Link-Public-Key`, matches the conversation, and
  checks the member row and its privilege. Getting that gate wrong is a silent
  authorization hole, so it is enforced structurally rather than by review: every
  `public` route taking a `:conversationId` or reading the link header must prove it
  invokes the shared gate.
- `routes.ts` is one `defineSliceManifest({ basePath, routes })`. **Inferred return
  types — the manifest's and each handler's — are what `AppType` carries**, and that
  derivation is the typed client's whole surface: a handler returning `c.json(...)`
  derives its body shape; one returning a bare `Response` derives `{}` at every
  status. A type-checker walk over `ExtractSchema<AppType>` enumerates the derived
  shapes. The `zValidator` hook context is typed with hono's base `Env`, not
  `AppEnv` (contravariance).
- A shared wire schema binds at the **body-building function**, and the route tail
  keeps deriving: annotate a constructed body with the schema's type
  (`src/slices/conversations/domain/epochs/keychain.ts`), or write `satisfies` with the
  schema type on an inline literal, which preserves its literal shape
  (`src/slices/conversations/domain/shares/shares.ts`). A rename in `packages/shared` is
  then a compile error here.
- Manifest factories receive their dependencies from the composition root (`app.ts`);
  slices never construct adapters.
- Route order per handler: `routeClass(…)` → `zValidator(…)` → handler.

## Slice layout and boundaries (lint-enforced)

- A slice publishes through its `index.ts` barrel and its `public/` entry modules.
  Routes import only their own slice's domain barrel + middleware; domain imports its
  own ports/domain plus other slices' barrels and `public/` modules. **The infra-module
  ban (`drizzle-orm`, `@neondatabase/*`, `@upstash/*`, `resend`, `aws4fetch`, …) is
  stated over slice layers, and `adapters/` is the one layer it exempts** — outside
  `src/slices/` it reaches nothing, which is how `lib/`, middleware and the composition
  root come to hold infra clients. Which layers the ban covers is stated in
  `packages/config/eslint-extensions/boundaries.config.mjs`.
  - Infra query operators (`eq`/`sql`/`inArray`/`and`/…) must not be laundered into
    domain by re-exporting them from an internal package barrel (`@hushbox/db`). The
    boundary is about the capability — raw query-building in domain — not the literal
    `drizzle-orm` specifier. Domain persistence uses the unwrapped `Database` handle's
    builder methods only (`.insert().onConflictDoUpdate()`, `.select().from()`);
    anything that needs operators goes in an adapter.
- The layer algebra, and why each clause holds:
  - Infrastructure-touching code lives in `adapters/`, never `domain/`. Domain holds
    business rules; a pricing decision holding a database handle cannot be tested
    without a database, and the rule and the query drift into each other.
  - `domain/` never imports its own `adapters/`. That is what makes `ports/` mean
    anything: domain declares what it needs and composition supplies it — a domain that
    could reach adapters would pick its own implementation, and the port would be
    decoration.
  - `adapters/` never imports its own `domain/` — the unusual clause, and deliberate:
    an adapter satisfies the contract in `ports/` and nothing else. An adapter that can
    reach domain helpers eventually uses one, and business logic lands in the data
    layer where no rule watches for it.
  - A cache client counts exactly as a database client. The refused thing is a live
    handle out of the process, not a table — "it is only a cache" was never the point.
  - The slice root is a composition layer: the two clauses above make the
    domain↔adapters crossing illegal in either direction, so a module needing both
    lands at the slice root — which may see both and may not perform I/O itself (infra
    modules are refused there too).
    Net effect: `domain/` and `adapters/` are siblings that never see each other; both
    depend on `ports/`, the sole contract surface between them.
- The two doors differ in width, not in status. The barrel is everything the slice
  offers in one module; a `public/` entry module is one capability, in a file named for
  it. Lint holds a `public/` module to its own slice and the lib dirs — **never another
  slice** — which is what makes consuming one pull in a capability rather than a slice;
  like the barrel and unlike domain, it may reach its own slice's `adapters/`.
  - **Which door to use is convention in general, and enforced wherever the barrel
    route would close a cycle** — there `import/no-cycle` rejects the barrel import and
    the door is the only legal route. Default to the barrel. Add a `public/` door
    when the consumer is **another slice's domain**, or when the module value-imports
    `@hushbox/realtime`: domain layers legally import slice barrels, so publishing such
    a module on the barrel would pull the workerd-only Durable Object runtime into
    every consumer's import graph (living example:
    `conversations/public/room-bindings.ts`).
    Non-slice consumers (app assembly, middleware, the job registry, dev/seed) use the
    barrel.
  - The door is unconditional rather than "when a cycle would form", because _"would
    this make a cycle?"_ is not a fact about your file. A barrel import is safe only
    while nothing imports you back — a property of your slice's position in the graph
    that another slice can falsify later without touching your code. The door needs no
    such property: because it imports only its own slice, consuming it cannot create a
    return edge.
  - A dev-only fixture published through the barrel or a door lives in a file whose
    name begins `dev-`. The dev-fixture unreachability rule derives its fixture set
    from that prefix inside the api tree, so an off-prefix fixture passes the rule with
    zero violations — the naming convention is the contract.
- The perimeter's outer ring: the composition root (`src/composition/` plus `app.ts`,
  `entry.ts`, `index.ts`, and the cron entry `scheduled.ts`) wires slices through
  barrels and `public/` doors only — never `domain/`, `ports/`, or `adapters/`. `dev/`
  and `test-support/` may import anything, and no production element may import them
  back (the single sanctioned edge is composition → dev; the mount is unconditional and
  the `dev-only` route class is what hides those routes in production). Test
  files (`*.test.ts` / `*.spec.ts` / `*.setup.ts`) and `_template/` are outside the
  governed set entirely.
- New slice: copy `src/slices/_template/` (it compiles — contract drift fails
  typecheck — but is excluded from lint/coverage/arch gates).
- Durable Object classes are declared only in `packages/realtime`, never in slices
  (arch-enforced).

## Mutations and errors

- Mutations run through `runMutation` over one of the five `idempotent.*` wrappers
  (`byKey`, `byUpsert`, `byTransition`, `byEventId`, `byExternalPreClaim`);
  `runMutation` accepts only `Idempotent<T>`, and casting to the brand is lint-banned.
  Exempt routes declare `idempotencyExempt('<class>')` and the arch rule requires the
  matching wrapper lexically in the terminal handler.
- Domain code returns `Result` (a dropped `Result` fails lint); routes map errors via
  `respondDomainError`, which resolves the wire code through `domainWireCode(error)`
  (an error's own `wireCode` when carried, else `DOMAIN_ERROR_CODE_TO_WIRE_CODE[error.code]`)
  paired with `STATUS_BY_DOMAIN_CODE`; malformed input → `createErrorResponse(ERROR_CODES.VALIDATION)`, 400.
- `cockatiel` is importable only inside `src/lib/resilience` — compose its exported
  retry/timeout policies everywhere else (lint-enforced).

## Engine and node purity (lint-enforced)

- Engine/node code uses `ctx.clock.now()` / `ctx.rng.random()` — never `Date.now()` /
  `Math.random()` — and never `fetch`, storage, or runtime slice-barrel imports
  (`import type` only).
- Capability node executions resolve only through the live execution registry — never
  imported or dispatched directly.

## OpenRouter calls

- Never inline `provider` / `extraBody.provider` literals — use
  `languageRoutingOptions()` / `mediaRoutingOptions()` from `@hushbox/shared`, which
  single-source the ZDR block (lint-enforced).

## Store raw, parse on demand

- Model text is stored exactly as returned, inside the one grammar owned by
  `packages/shared/src/assistant-text/` (the only code that may touch the delimiters),
  which also frames the reasoning and search rows HushBox writes. All presentation parses
  on demand.
- History reaches a run only as a client-supplied array, and the chat route reduces each
  assistant turn to its root answer text at that one seam, ahead of the body hash, the
  prompt count and the run body. Nothing downstream may strip again.
- Workflow node values from reasoning-capable modelCalls carry the serialized form;
  future transform/fanIn consumers read the answer through that module.

## Tests

- Never `vi.mock` a slice barrel (lint-enforced) — internal slices are exercised for
  real; mocks exist only at true external seams.
- Integration tests run against real local Postgres/Redis/MinIO.
- Each worker slot gets its own cloned database, so concurrent files never collide —
  but a slot is shared by every file that lands on it, sequentially. Rows a file
  leaves behind are visible to the next file in that slot, which is why per-file
  cleanup registries stay and why a fixture must not outlive the test that needs it.
- A test that mints a fake HTTP transport (`vi.fn`, `vi.mock`, `vi.spyOn`,
  `vi.stubGlobal('fetch', …)`) must not also write a `service_evidence` row: a row
  means a real call happened (arch-enforced). Evidence for fcm, webpush and resend
  belongs in a CI-gated test that made the real call, never in an adapter the factory
  mocks away in CI.
