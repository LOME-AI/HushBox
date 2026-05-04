# Architecture Refactor Handoff

## Preamble

This document is the complete state of an architectural refactor planning session for HushBox. It contains the current best design we landed on, every alternative we considered and why we accepted or rejected it, and every Q&A we discussed.

**These decisions are starting context, not gospel.** They were made in a planning conversation without code in hand. Disagree, push back, redesign as reality demands. The architectural patterns survive only if they continue to serve the work; if they don't, redraw them. Every "this is the rule" below is shorthand for "this is the rule until evidence shows otherwise."

The product has no users. A clean-slate rewrite in one branch is the working assumption. Migration ordering, coexistence, and rollback are not constraints.

---

## 1. The Current Best Design — Conceptual

### Pattern

**Modular Monolith with Vertical Slices and Hexagonal Edges.**

- Single Cloudflare Worker deployable.
- Backend code organized into **vertical slices**, one per domain feature. Each slice is self-contained.
- Inside each slice, **hexagonal architecture**: domain logic depends on port interfaces, never on infrastructure. Adapters implement ports.
- Frontend is **feature-sliced React with hooks-as-ViewModel**. Unchanged from current structure.

### Slice structure

```
slices/<feature>/
  route.ts              — Hono handler, calls runQuery / runMutation
  domain/               — Effect services, types, errors, state machines
  ports/                — interfaces + Context.Tag definitions
  adapters/             — Layer implementations
  __tests__/            — domain tests using test Layers
  index.ts              — public barrel (only cross-slice import surface)
```

### The three operation patterns

Every write operation in the system uses exactly one of these:

**Pattern A — Single Database Transaction.** Atomic all-or-nothing within one slice's tables. No external system calls inside the transaction. The default for any business operation.

**Pattern B — Single External Call In-Request.** One external system call (one email, one R2 delete, one Helcim charge), one DB update. Failure becomes an HTTP error. The client retries using the `Idempotency-Key` header which our route boundary enforces.

**Pattern C — Cloudflare Workflow + Domain Table.** Two or more external calls in sequence, long waits, compensating actions, or operations that must survive crash mid-flight. The Workflow drives execution. A slice-owned domain table records the user-visible state of the operation.

If a candidate operation doesn't fit one of these three, the slice boundary is wrong or the operation is being modeled incorrectly. There is no fourth pattern.

### Cross-slice rules

- **Transactions never cross slice boundaries.** A slice owns every table it writes to in a transaction. If an operation needs a transaction spanning tables in different slices, the slice boundary is wrong. Redraw.
- **Tables have one owning slice.** Slices may own row kinds within a shared physical table (e.g., billing owns credit-side ledger entries, messaging owns debit-side), but no row is written by two slices.
- **Cross-slice reads are free.** Slices read from each other's tables (rarely) through public query methods on the owning slice's barrel.
- **Cross-slice writes happen only via single-shot imperative calls** to sanctioned external systems (Cloudflare Queues, R2, Helcim, Resend, push providers, OpenRouter, Durable Objects). No multi-step coordination across slices. No application-tracked intermediate state across slices.

### What this eliminates

- No outbox pattern (`domain_events` table)
- No cross-slice sagas
- No application-owned coordination tables tracking multi-slice operation progress
- No event chains where slice A's event triggers slice B's event triggers slice C's event
- No orchestrators holding intermediate state about other slices' progress

### Failure handling per pattern

- **A:** Postgres rolls back. HTTP error. Client retries.
- **B:** HTTP error. Client retries with `Idempotency-Key` header; cached response replays the original outcome.
- **C:** Per-step retry policies in the Workflow. Try/catch within the workflow for compensating actions. Domain table records explicit failure states. Admin surface for manual retry of permanently-failed instances.

### Effect adoption scope

- **Backend (apps/api):** all Effect. Every service returns `Effect<A, E, R>`. Errors are `Data.TaggedError` with `_tag` discriminant. DI via `Context.Tag` + `Layer`. No DI container library.
- **Frontend (apps/web):** unchanged. TanStack Query + Zustand + hooks. The API JSON error contract (`{ code, details? }`) carries the typed discriminated union across the boundary; the frontend gets compile-time exhaustiveness on error codes without using Effect.
- **Astro marketing site:** no Effect.
- **Durable Objects:** stay on Promises. Bridge at the DO adapter layer via `runPromise`.

### Idempotency

Every persistent-state mutation is wrapped in one of four named patterns:

- `idempotent.byKey` — client-supplied `Idempotency-Key` header. Cached response in Redis (24h TTL).
- `idempotent.byUpsert` — natural-key entity creation. `INSERT ON CONFLICT`.
- `idempotent.byTransition` — state machine transition. Atomic conditional UPDATE.
- `idempotent.byEventId` — queue consumer dedup. Redis SET NX.

Type-level enforcement: port methods that mutate persistent state return `MutatingEffect<A, E, R>`. The branded type cannot be consumed except through an `idempotent.*` wrapper, which returns `Idempotent<A, E, R>`. The route boundary's `runMutation` requires `Idempotent<A, E, R>` at compile time. There is no escape hatch.

### State machines

Hand-rolled via discriminated unions + pure transition functions + DB enum + atomic conditional UPDATE. Used only when transactions are insufficient: multi-step within a single slice, time-based transitions, side effects coordinated with transitions. No state-machine library.

### Branded types

- `packages/shared` (consumed by frontend): DIY branded types (~5 lines, zero deps, zero bundle impact).
- API validation boundaries: Zod `.brand()`.
- Backend Effect services: Effect `Brand.refined`.

All three layers are interoperable.

---

## 2. The Current Best Design — Concrete

### Stack

| Layer | Technology |
|---|---|
| Runtime | Cloudflare Workers |
| Framework | Hono |
| Effect runtime | Effect-TS >= 3.20.0 |
| Database driver | `pg` (node-postgres) via Cloudflare Hyperdrive |
| ORM | Drizzle |
| Cache | Upstash Redis |
| Object storage | Cloudflare R2 |
| Durable execution | Cloudflare Workflows |
| Async messaging | Cloudflare Queues |
| Real-time | Durable Objects |
| Auth | OPAQUE (`@cloudflare/opaque-ts`) + iron-session |
| Crypto | `@noble/*`, `hash-wasm`, `@scure/bip39` |
| Validation | Zod (with `.brand()` for branded types) |
| Frontend | React 19, Vite, TanStack Router/Query, Zustand, shadcn/ui |
| Marketing site | Astro |
| Mobile | Capacitor |
| Tests | Vitest, `@effect/vitest`, `@cloudflare/vitest-pool-workers`, Playwright |

### Tooling additions

| Tool | Purpose |
|---|---|
| `@softarc/sheriff` | Cross-slice / cross-package boundary enforcement (ESLint integration) |
| `eslint-plugin-boundaries` | Intra-slice layer enforcement (route → domain → port ← adapter) |
| `ts-morph` (in Vitest) | Architecture tests for structural rules beyond imports |
| Cloudflare Hyperdrive | Postgres edge proxy, replaces `@neondatabase/serverless` WebSocket driver |
| Cloudflare Workflows | Pattern C orchestration |

### Tooling explicitly NOT adopted

| Tool | Reason |
|---|---|
| `pino` | Doesn't work on Workers (depends on `node:os`, `node:stream`, thread workers) |
| `tsarch` | Abandoned upstream |
| `type-fest` | DIY branded types + Zod `.brand()` + Effect `Brand` cover the use case |
| `consola` | `console.log` suffices for the small number of dev scripts |
| `neverthrow` | Effect's typed E channel replaces it |
| `emittery` | Effect `PubSub` replaces it |
| `p-limit`, `p-retry` | Effect `Schedule` + `Effect.forEach({ concurrency })` replace both |
| `xstate` | Hand-rolled discriminated unions are clearer for the few state machines we need |
| `awilix`, `tsyringe`, `inversify` | Effect `Context` + `Layer` is the DI mechanism |
| `dependency-cruiser` | Sheriff covers boundary enforcement with better DX (ESLint integration) |
| `@effect/sql-drizzle` | Beta, version-coupled to drizzle-orm beta. Hand-roll the Drizzle-in-Effect port. |
| `effect-hono` | Doesn't exist. Don't invent. Custom ~30 LoC bridge in `apps/api/src/lib/effect-runtime/`. |
| `@effect/platform` HttpServer | Would replace Hono. Loses `hc<AppType>` typed client and `streamSSE`. Don't migrate. |
| Effect v4 beta | Broken on Workers (`effect-smol#1404`). Stay on v3.20+. |
| Generic jobs table (pg-boss style) | Premature for our 3–5 expected Pattern C operations. Reconsider at ~10+. |
| `nonIdempotent` escape hatch | Removed for stricter `MutatingEffect` brand-based enforcement. |

### Schema additions

**Tables added:** zero, day one. Operation-specific tables added when each Pattern C operation is built (e.g., `account_deletions` when account deletion is implemented; `exports` when data export is implemented).

**Columns added:**
- `epochs.previous_epoch_id` — FK to `epochs.id`. Referentially enforces the epoch confirmation chain. Currently `chainLink` is a bytea hash; this adds the structural reference.

**Soft-delete columns** added on tables where soft delete is the deletion strategy (e.g., `users.deleted_at`).

**Tables explicitly dropped from earlier proposals:**
- `audit_log` — not needed; not a regulatory requirement at current stage.
- `domain_events` (outbox) — three-pattern rule eliminates the need.
- `idempotency_records` — Redis with 24h TTL instead.
- `processed_events` — Redis with 30d TTL instead.
- `data_migrations` — deferred until first backfill is needed.
- `feature_flags` — out of scope for this refactor.
- `blob_refs` — content-addressable storage is premature optimization.
- `user_lifecycle_requests` — replaced by FK cascades + soft delete + (when needed) per-operation Pattern C tables.
- Most `correlation_id` / `causation_id` columns — Axiom logs cover cross-table tracing via structured request IDs. Not a Postgres concern at current scale.

### Redis state (no Postgres tables)

- Client idempotency cache: `idempotency:{user_id}:{key}` → `{ status, body }`, 24h TTL
- Per-consumer event dedup: `event-processed:{consumer}:{event_id}` → timestamp, 30d TTL
- Rate limit counters: keyed by `(policy_id, actor_id, window)`
- Circuit breaker state: keyed by breaker ID, hash of `{ state, consecutive_failures, open_until }`

### Ports (the canonical inventory)

Defined as `Context.Tag` interfaces in slice `ports/` directories. Adapters live in `adapters/`. Each port implements one external dependency.

- `Db` — Drizzle over Hyperdrive `pg.Client`
- `Cache` — Upstash Redis
- `Storage` — Cloudflare R2
- `LlmGateway` — OpenRouter
- `PaymentProvider` — Helcim
- `EmailSender` — Resend
- `QueuePublisher` — Cloudflare Queues
- `Crypto` — wraps `@hushbox/crypto` primitives
- `RealtimeBroadcast` — Durable Objects (with Promise bridge)
- `WorkflowRunner` — Cloudflare Workflows
- `AuthzPolicy` — per-slice authorization (one per user-data-handling slice)
- `RateLimit` — sliding/fixed-window counters
- `CircuitBreaker` — used inside adapters wrapping external calls
- `Secrets` — typed secret access with redaction-by-default
- `FeatureFlags` — deferred (out of scope for this refactor)

Each port declares `criticality: 'required' | 'best-effort'`. Best-effort ports' interfaces have `never` in the E channel — adapter swallows errors internally.

### Code structure conventions

**Per-request `ManagedRuntime`.** Hono middleware constructs `ManagedRuntime.make(AppLayer.live(env))` per request, attaches to `c.var`, route handlers use it, outer handler calls `.dispose()` in `finally`. Module-scope runtimes are forbidden.

**ALS safety rule.** Never read `AsyncLocalStorage.getStore()` from inside a fiber. Capture auth context in the outer Hono handler, pass via `Layer.succeed(Actor, actor)` to the per-request runtime. ESLint rule bans `async_hooks` imports outside the session middleware.

**Bundle discipline.** Backend code uses namespace imports (`import * as Effect from 'effect/Effect'`), never barrel imports (`import { Effect } from 'effect'`). CI runs `wrangler deploy --dry-run --outdir=dist` and fails on bundle budget violation.

**Test Layer hygiene.** Custom `testEffect(layerFactory)` helper builds a fresh Layer per test. Never use `it.layer` directly (state leaks across tests).

### File-system structure

```
apps/api/src/
  slices/
    <feature>/
      route.ts
      domain/
      ports/
      adapters/
      __tests__/
      index.ts
  lib/
    effect-runtime/         # runQuery, runMutation, SSE bridge, queue consumer wrapper
    idempotency/            # the four idempotent.* helpers + MutatingEffect brand
    effect-test/            # testEffect helper
  workflows/                # Cloudflare Workflow classes
  jobs/                     # cron triggers (thin invocations into slice services)
  app-layer.ts              # AppLayer composition
  index.ts                  # Worker entrypoint, registers routes/workflows/queues/cron
  scheduled.ts              # cron dispatcher
```

### Hyperdrive integration

- Replaces `@neondatabase/serverless` and the Neon Proxy Docker container in local dev.
- Connection string from `env.HYPERDRIVE.connectionString`. Same in dev (via `localConnectionString` pointing to local Postgres) and prod.
- Drizzle uses `drizzle-orm/node-postgres` with `pg`. Not `drizzle-orm/neon-serverless`.
- Per-request `pg.Client` wrapped in `Effect.acquireRelease(client.connect, client.end)`. Pool lives at the edge (Cloudflare's infrastructure), not in the Worker.
- Query caching is prod-only (local dev has no Hyperdrive proxy). Code never depends on the cache for correctness. Use `--caching-disabled` for any read where staleness matters.

### Workflow + domain table pattern (Pattern C)

```
Route handler (Pattern A — single transaction):
  INSERT <operation_table> (status='pending')
  start workflow with reference to row id
  return 202 with row id

Workflow:
  step.do('cancel-helcim', async () => { ... })
    → on success, update row status='helcim_cancelled' (next step's first action)
  step.do('delete-r2', async () => { ... })
    → on success, update row status='r2_deleted'
  try {
    step.do('finalize-db', async () => {
      DELETE user CASCADE
      UPDATE operation_table SET status='completed'
    })
  } catch (err) {
    step.do('record-failure', async () => {
      UPDATE operation_table SET status='failed_<step>', failure_reason=...
    })
    throw err
  }
```

Each `step.do` body is idempotent (may re-run on retry). Step names are deterministic (no `Math.random()` or `Date.now()` in names). DB connections are created inside steps, not outside.

Domain table columns for any Pattern C operation:
- Operation-specific business columns
- `status` (typed enum including explicit failure states)
- `started_at`, `completed_at` (nullable timestamps)
- `failure_reason` (nullable JSONB)
- (No `attempt`, `scheduled_at`, etc. — Workflow runtime tracks these internally)

### Frontend boundary

API errors are `{ code: '<TaggedError._tag>', details?: object }`. Frontend's typed API client throws `ApiError` with the `code` typed as a literal union of every backend error `_tag`. Exhaustive matches on error codes are compile-checked. `friendlyErrorMessage(code)` maps to user-facing strings.

Components do not import `@hushbox/crypto`. Domain hooks in `apps/web/src/hooks/crypto/` sit between components and crypto primitives. Components express intent (`useMessageEncryption(...)`); hooks own the recipe.

---

## 3. Architectural Rules (the formal list)

These are the rules that go into ARCHITECTURE.md. Every rule has an enforcement mechanism.

### Slice rules

- A slice's `index.ts` barrel is its only public API. (sheriff)
- Domain code imports only from `ports/` within its slice. (eslint-plugin-boundaries)
- Adapters implement ports; only adapters import infrastructure libraries. (ts-morph + eslint-plugin-boundaries)
- Routes contain no business logic. (code review; ts-morph for structural smells)
- Tests colocate with source.

### Boundary rules

- Slices may not import each other's internals. (sheriff)
- Slices communicate only via barrel types or single-shot imperative calls to sanctioned external systems.
- Cross-package: `apps/*` imports `packages/*`, never the reverse. (sheriff + pnpm)
- `packages/shared` imports nothing internal beyond other shared subpaths. (sheriff)

### Operation pattern rules

- Every write operation is Pattern A, B, or C.
- Pattern A: single DB transaction, no external calls inside.
- Pattern B: single external call, error becomes HTTP error.
- Pattern C: Cloudflare Workflow + slice-owned domain table.
- No Pattern D. If something doesn't fit, the slice boundary is wrong.

### Idempotency rules

- Every `MutatingEffect` call is wrapped in `idempotent.*`. (ts-morph)
- `runMutation` requires `Idempotent<A, E, R>` at the type level.
- All mutating HTTP endpoints require `Idempotency-Key` header. (runtime)
- `Effect.retry` is composable only with `Idempotent` effects.

### Cross-slice rules

- Transactions never span slices.
- Tables have one owning slice.
- Cross-slice writes use single-shot imperative calls to sanctioned external systems.
- Sanctioned externals: CF Queues, R2, Helcim, Resend, push providers, OpenRouter, Durable Objects. List is closed; additions require explicit decision.

### Effect runtime rules

- `effect >= 3.20.0` (security advisory floor).
- Per-request `ManagedRuntime`, never module-scope.
- No reading `AsyncLocalStorage` from inside a fiber.
- DOs stay on Promises; bridge at adapter layer.
- Namespace imports only on backend (bundle discipline).
- `testEffect(layerFactory)` helper for fresh-layer-per-test.

### Frontend rules

- Components do not import `@hushbox/crypto`. (sheriff)
- API calls go through typed `api-client.ts`. No raw `fetch()` for typed-client-covered endpoints.
- Frontend stays on TanStack Query + Zustand. No Effect.

### Schema rules

- Every Pattern C operation has its own first-class table.
- Tables use atomic conditional UPDATEs for state transitions (`UPDATE ... WHERE status = expected`).
- Soft delete uses a single nullable timestamp column on the entity table.

### Documentation rules

- ARCHITECTURE.md describes patterns and rules, never inventory (no specific slice or port lists that change with the codebase).
- Rules without enforcement mechanisms are not rules; they're suggestions. Every rule names how it's enforced.

---

## 4. Decisions Considered and Rejected

### Architecture patterns rejected

| Option | Reason rejected |
|---|---|
| Microservices | Premature. Workers already scale to zero. Cross-service network hops would amplify shotgun surgery, not eliminate it. |
| CQRS / Event Sourcing | Operational burden exceeds benefit for our domain. Doesn't demand audit/replay at that level. |
| Clean Architecture / Onion | Over-ceremony for small team — DTOs between every layer, presenters, interactors. Not worth the cost at this scale. |
| Pure DDD with rich aggregates | Tactical patterns (aggregates, value objects) selectively applied where invariants compound (epochs, billing) — not wholesale. |
| Vertical slices alone (no hexagonal) | Loses port abstraction; reintroduces direct-Drizzle-in-domain pattern that hurts testability. |
| Hexagonal alone (no vertical slices) | Layer-organized, not feature-organized — reintroduces shotgun surgery for new features. |
| Full Effect everywhere (frontend included) | `@effect/platform-browser` integration with React is less mature than TanStack Query. Frontend's pain points aren't concurrency-correctness problems. Doubles ramp cost. |
| Partial Effect (some backend modules only) | Two mental models forever; conversion overhead at every cross-module call boundary; loses typed E channel at every conversion. |

### Tools rejected (with brief reasoning beyond the table in §2)

- **xstate**: HushBox has 3–4 state-machine-shaped flows total. Hand-rolled discriminated unions are clearer at this volume. Library justified at ~10+ machines.
- **`p-limit`, `p-retry`, custom race-cancel helper**: collapsed by Effect into `Effect.forEach({ concurrency })`, `Schedule`, `Effect.race` (which automatically cancels losers).
- **`neverthrow`**: typed E channel in Effect subsumes `Result<T, E>`.
- **`emittery`**: Effect `PubSub` is built-in.
- **`pino`**: Workers-incompatible. Effect Logger replaces.
- **`consola`**: tiny benefit for ~15 dev-script log lines. Use `console.log`.
- **`type-fest`**: 5-line DIY branded types + Zod `.brand()` + Effect `Brand` cover the need without adding a dependency.
- **`tsarch`**: abandoned upstream (last npm publish 2+ years ago).
- **`dependency-cruiser`**: more powerful than sheriff but enforcement-as-CLI vs sheriff's ESLint integration is a worse DX. Sheriff for boundaries; ts-morph programmatic API for structural rules.
- **`tsyringe`, `inversify`**: require `reflect-metadata`, hostile to Workers runtime. Effect `Context` is the DI mechanism.
- **`@effect/sql-drizzle`**: beta, version-coupled to drizzle-orm beta. Hand-roll the Drizzle-in-Effect port; revisit when stable.
- **`effect-hono`**: doesn't exist. Custom ~30 LoC bridge in `apps/api/src/lib/effect-runtime/`.
- **Effect v4 beta**: broken on Workers (`effect-smol#1404`). Stay on v3.20+.
- **AWS Step Functions / Temporal / Inngest**: alternatives in the durable-execution category. Cloudflare Workflows wins on no-vendor-fragmentation (we're already all-in on Cloudflare) and zero infrastructure burden. Workflows is the right step-function for this stack.
- **Generic jobs table (pg-boss, River, GoodJob)**: justifies itself at ~10+ Pattern C operations. We have 3–5 projected. Per-slice domain tables are simpler at this scale.

### Architectural mechanisms rejected

| Mechanism | Reason rejected |
|---|---|
| Outbox pattern (`domain_events` table) | Three-pattern rule eliminates the need. Cross-slice coordination via durable events doesn't exist in the design. |
| Audit log (`audit_log` table, hash-chained, append-only) | Not needed at current product stage. Removable later if compliance requirements demand. |
| `idempotency_records` table | Redis with TTL is the correct storage for ephemeral cached responses. |
| `processed_events` table | Redis with TTL is the correct storage for queue consumer dedup. |
| `data_migrations` table | Deferred until first backfill is required (no production data to backfill yet). |
| `feature_flags` table | Out of scope for this refactor; revisit when feature-flag needs concretize. |
| `blob_refs` (content-addressable storage) | Premature optimization. Use uuidv7 keys for R2 objects; revisit if duplicate uploads become a measurable storage cost. |
| `user_lifecycle_requests` (saga state) | Replaced by FK cascades + soft delete (synchronous) or per-operation Pattern C tables (async). |
| `correlation_id` / `causation_id` on transactional tables | Axiom logs cover cross-table tracing via structured request ID. Postgres columns just for debugging are unjustified at current scale. |
| `nonIdempotent` escape hatch | Removed in favor of stricter `MutatingEffect` brand-based rule. Operations that look like they need `nonIdempotent` (LLM streams, broadcasts) aren't actually mutations of persistent state. |
| Cross-slice event chains | Forbidden by the three-pattern rule. If you need a chain, the slice boundary is wrong. |
| Cross-slice sagas with state-tracking tables | Forbidden by the three-pattern rule. If a multi-step operation touches multiple slices, it lives in one slice (redraw boundaries) or uses Pattern C with a single owning slice. |
| Domain events for internal coordination | Replaced by direct imperative single-shot calls to sanctioned externals or by Pattern C workflows. |
| Reservation event mirroring (Redis reservations backed by `domain_events` writes) | Reservations are speculative cache; rebuild from Postgres `payments` + `usage_records` on Redis loss. Doubling the write cost was unjustified. |

### Migration strategy items rejected (because no users)

| Item | Reason rejected |
|---|---|
| Slice-by-slice phased migration | No users; do it all in one branch. |
| Promise↔Effect bridging | No partial migration; all backend converts together. |
| Shadow-execution / parity harness for billing | No production billing to shadow against. |
| Three-tier coverage during migration | No legacy tests to preserve. |
| "Refactoring Mode" TDD exemption | Pure TDD applies; this is fresh implementation, not refactor of existing behavior. |
| Frontend contract-delta posts | Frontend rewrites in lockstep with backend. |
| Rollback-via-dual-write | No production to roll back from. |

---

## 5. Q&A Log

Every question raised during the planning conversation, with the answer reached.

### On the architecture name

**Q: What is the current architecture's name?**
A: Layered Modular Monolith with Transaction Script and Feature Folders. Closest single label: "Transaction Script" on the backend (Fowler), "feature-sliced React with hooks-as-ViewModel" on the frontend, end-to-end typed HTTP via shared Zod/Drizzle schemas.

**Q: Is this typed HTTP or RPC?**
A: Typed HTTP via shared Zod schemas. Hono markets `hc<AppType>()` as "Typed RPC" but it's a typed fetch wrapper, not RPC in any meaningful protocol sense (no procedure call semantics, no method dispatch, no IDL).

**Q: Is the current design good or bad?**
A: 7.5/10 for what it is. Above-average for early/mid-stage SaaS. Will not gracefully absorb 5× complexity growth without addressing: anemic domain model decay, lack of repository/port layer (services call Drizzle directly), implicit DI via middleware context, god-hooks on the frontend, weak module boundaries.

**Q: What is the target architecture's name?**
A: Modular Monolith with Vertical Slices and Hexagonal Edges. Sometimes called "Componentized Monolith" (Shopify) or "Ports-and-Adapters Modular Monolith." No standardized capital-letter name.

### On choosing the pattern

**Q: Of 10 architectural alternatives, which is best?**
A: Modular Monolith with Vertical Slices + Hexagonal Edges, with Functional Core / Imperative Shell layered inside domain modules, and tactical DDD (aggregates, value objects) only where invariants justify it (epochs, billing). Microservices last. CQRS/ES rejected. Clean Architecture too ceremonial.

**Q: Is enforcement DIY or framework-provided?**
A: Mostly DIY, with 3–4 enforcement tools: pnpm workspaces (structural), sheriff (cross-slice/cross-package), eslint-plugin-boundaries (intra-slice layers), ts-morph (structural rules beyond imports). No single framework provides the whole pattern.

**Q: Should we add a DI library and event bus library?**
A: No DI library (Effect Context replaces it; decorator-based DI is Workers-hostile). For events: Effect PubSub for in-process, Cloudflare Queues for durable cross-request, Durable Objects for WebSocket fan-out. No standalone event bus library needed.

### On Effect-TS

**Q: My stack vs Effect — which is better?**
A: Effect on the backend. Effect collapses neverthrow + emittery + p-limit + p-retry + AbortSignal + factory DI + race-cancel helper into one coherent system. The stated goal was "absolute best maintainability, zero duplication, zero shotgun surgery, willing to do a massive change" — Effect serves that goal; the multi-library stack does not.

**Q: What kind of Effect adoption — pure everywhere, only backend, only some methods?**
A: All backend, no frontend, no partial. Partial-Effect-on-backend creates two mental models forever; the conversion overhead at internal boundaries eats the typed E channel benefit. Frontend on Effect is not a clear win today (`@effect/platform-browser` + React integration is less mature than TanStack Query). Astro marketing site doesn't use Effect.

**Q: How does the frontend handle backend errors without Effect?**
A: The API JSON error contract (`{ code, details? }`) carries the typed discriminated union across the boundary. The typed API client throws `ApiError` whose `code` is a literal union of every backend `_tag`. Exhaustive matches in the frontend are compile-checked. `friendlyErrorMessage(code)` maps to user-facing strings. End-to-end type safety without Effect on the client.

**Q: What do we gain conceptually from this stack?**
A: (1) Bugs become compile errors. (2) Change locality is physical. (3) Dependency graph is mechanically verifiable. (4) Tests stop needing infrastructure (test Layers). (5) Resource safety is structural (acquireRelease). (6) Concurrency correctness by default (fiber interruption). (7) Slices are independently evolvable. (8) Function signatures become complete documentation.

**Q: What is the effect on AI coding agents?**
A: Disproportionately positive. The mechanisms that help agents (strict boundaries, exhaustive matching, explicit dependencies, local task scope, compiler as primary feedback) are exactly what humans on a small team can skip on. Agents can't hold context in their heads; the architecture externalizes it. Costs: harder to write idiomatic Effect initially (narrower training distribution), worse stack traces during live debugging, two idioms during migration. Benefits dominate over a multi-year product timeline.

**Q: How would Effect concurrency help us?**
A: Four real wins: SSE streaming cancellation (fiber interruption replaces AbortController plumbing), epoch rotation fan-out (failure isolates per-fiber), group chat WebSocket broadcast (per-socket timeout, dead-socket cleanup), LLM fallback racing (`Effect.race` cancels losers automatically — `Promise.race` doesn't, leaking OpenRouter credits).

**Q: How do we handle Effect runtime on Workers specifically?**
A: Per-request `ManagedRuntime` (never module-scope). `effect >= 3.20.0` (security advisory floor). ALS rule: don't read auth from `AsyncLocalStorage` inside fibers; pass via Layer. Hand-roll Drizzle-in-Effect port (don't use `@effect/sql-drizzle` beta). Custom ~30 LoC Hono bridge (no `effect-hono` library exists). DOs stay on Promises with Promise bridge at adapter layer. Namespace imports only (bundle size). Stay on Effect v3, not v4 beta.

### On idempotency

**Q: Should we follow one strict idempotency convention?**
A: No single pattern fits every case. One strict rule: every persistent-state mutation declares a stable idempotency key + DB-enforced uniqueness guard. Four named patterns: `idempotent.byKey`, `byUpsert`, `byTransition`, `byEventId`. No check-then-act outside transactions.

**Q: Why have `nonIdempotent` as an escape hatch?**
A: We don't. Removed. Operations that seem to need it (LLM generation, broadcasts, streams) aren't mutations to persistent state — the rule never applies to them. Stricter framing: port methods that mutate persistent state return `MutatingEffect<A, E, R>`; calls in domain code must wrap in `idempotent.*`. No escape.

**Q: How is the rule enforced?**
A: Five layers: TypeScript (runMutation requires Idempotent brand), runtime (Idempotency-Key header check on mutations), Effect Schedule (retry only on Idempotent effects), ts-morph (every MutatingEffect call is wrapped), ESLint (ban direct Drizzle mutation in domain).

### On schema and tables

**Q: What is the audit log?**
A: A tamper-evident append-only record of security and privacy actions. Hash-chained, DB-role-level append-only, written synchronously, indefinite retention. (Subsequently removed — not a current requirement.)

**Q: Why have `domain_events` instead of just pushing to queues?**
A: Originally: outbox guarantees event-fires-iff-state-committed (transactional atomicity with the queue). Reconsidered: most cross-system effects either have an upstream retry source (Helcim webhooks retry) or are best-effort (`ctx.waitUntil`). After the three-pattern rule, the outbox justifies itself in zero remaining cases for HushBox. Removed.

**Q: Why have `idempotency_records`?**
A: For client-retry idempotency (mobile app retries POST after network drop). Better as Redis key→JSONB with 24h TTL. No Postgres table.

**Q: When do we need `processed_events`?**
A: Queue consumer dedup. Better as Redis SET-NX with TTL. No Postgres table.

**Q: What's the use case for `data_migrations`?**
A: Tracking long-running data backfills (resumable, idempotent). Deferred — no production data to backfill yet. Document the pattern; add the table when first backfill is needed.

**Q: Do we need `user_lifecycle_requests` for compliance?**
A: "Compliance" overstated it. Real drivers: user expectation (delete-my-account must work; data export is asked-for), and GDPR/CCPA eventually. Initial form: synchronous deletion via FK cascades. Async export deferred until built. When built, it's a Pattern C operation with its own table (`exports`).

**Q: What problem does `blob_refs` solve?**
A: Refcounting for content-addressable storage. Premature for HushBox — uploads are mostly unique, dedup savings minor. Use uuidv7 keys for R2; delete when referring entity is deleted. Add CAS only if duplicate uploads become a measurable cost.

**Q: Are correlation_id and causation_id common?**
A: Common in event-sourced/observability-heavy systems; not in typical CRUD apps. Over-scoped them on every transactional table. Reduced scope to `domain_events` only — but `domain_events` is then dropped, so these columns drop with it. Axiom logs cover cross-table tracing via structured request ID.

### On transactions and slice boundaries

**Q: For "user was charged but usage wasn't metered" — wouldn't transactions guarantee this?**
A: Yes, within a single slice. The original justification for the outbox was wrong; same-slice transactions handle this fully. Outbox is justified by cross-slice decoupling, not by database weakness.

**Q: Does the new architecture lose strength compared to current transaction script?**
A: No, if slice boundaries are drawn correctly. Every existing HushBox transaction (saveChatTurn, chargeAndTrackUsage, processWebhookCredit, maybeRenewFreeAllowance) lives cleanly in one slice under the revised slice map (messaging owns debits, billing owns credits, both write disjoint row kinds in `ledger_entries`). Atomicity preserved.

**Q: Will current transactions still work in the new system?**
A: Yes. Same `db.transaction(...)` pattern, same atomicity guarantees. Only the file location changes — into the owning slice. Effect's `Db.transaction` preserves the semantics.

**Q: Should anything ever be cross-slice?**
A: Reads, yes (free). Writes via single-shot imperative calls to sanctioned externals, yes. Multi-step coordination across slices, no — redraw the slice boundary instead.

**Q: What if something needs to touch everything?**
A: It doesn't, in practice — every candidate (account deletion, data export, admin operations) is either a read across slices, an FK cascade from one slice's owned row, or a same-slice operation that reads broadly. If you do encounter such a case, the response is to redraw the slice boundary, not to eliminate the architecture.

**Q: Should we make a hard rule: no cross-slice intermediate state outside transactions?**
A: Yes. Every operation is Pattern A, B, or C. Cross-slice multi-step coordination is forbidden. Sanctioned externals: Cloudflare Queues, R2, Helcim, Resend, push providers, OpenRouter, Durable Objects.

### On job systems

**Q: Should we build a job system for Pattern B/C operations?**
A: Yes — but not a generic one. Per-slice typed tables for each Pattern C operation. Five-column convention: `status`, `attempt`, `max_attempts`, `scheduled_at`, `last_attempted_at`, `last_error`. Slice-owned cron sweep for recovery. (Subsequently superseded by Cloudflare Workflows, which removes most of the plumbing.)

**Q: Per-slice tables vs a generic jobs table?**
A: Per-slice. Typed columns, queryable, schema changes stay slice-local. Generic justifies itself at ~10+ Pattern C operations. We have 3–5.

**Q: What invokes the next step?**
A: Originally: synchronous drive in originating request + slice-owned cron sweep. Replaced by Cloudflare Workflows runtime (handles retry/resumption automatically).

**Q: Should we have an `attempt` column?**
A: Yes, when using per-slice tables. Standard schema across pg-boss, River, Sidekiq. (Subsumed by Workflows runtime when using Pattern C with Workflows.)

### On Cloudflare Workflows

**Q: What is Cloudflare Workflows?**
A: Durable execution as a Workers primitive. Code-based (not declarative). Step results persisted to durable storage; on crash, re-invocation replays completed steps from cache and continues from the first incomplete step. Supports `step.do`, `step.sleep`, `step.waitForEvent` with multi-day waits.

**Q: Is it a step-function product?**
A: Yes — same category as AWS Step Functions, Temporal, Azure Durable Functions, Inngest, Trigger.dev, Restate. Code-based flavor (like Temporal/Durable Functions), not declarative (like AWS Step Functions / Google Workflows).

**Q: Best future-proof solution: transactions + workflows for everything else?**
A: Three patterns, not two. (A) Transaction. (B) Single external call in-request with HTTP-error-and-client-retry. (C) Workflow + domain table. Workflows for one-step external calls is overkill; Pattern B handles those.

**Q: How is failure handled in Workflows?**
A: Three layers: per-step retry policies (configured), try/catch within the workflow for compensating actions, workflow-level failure marked in dashboard with domain table reflecting final state. Admin surface for manual retry of permanently-failed instances.

**Q: Are Workflows fully locally emulatable?**
A: Yes. Wrangler ≥ 4.79 + `@cloudflare/vitest-pool-workers` ≥ 0.14.3. State persists to `.wrangler/state` (same as DO/D1/R2). Local Explorer UI at `/cdn-cgi/explorer`. Vitest helpers: `disableSleeps`, `mockStepResult`, `waitForStatus`. Doesn't work: remote bindings (`wrangler dev --remote`); long `step.sleep` durations fire in real wall-clock locally (use `envUtils` to shorten in dev).

### On Hyperdrive

**Q: What is Cloudflare Hyperdrive?**
A: Edge proxy in front of Postgres. Worker connects via standard `pg` over TCP; Hyperdrive maintains warm pooled connections to origin DB (Neon). Optional read query caching at the edge.

**Q: Does it help local dev or only prod?**
A: Both, differently. Prod gets warm pools + caching. Local dev gets simplification: drops the Neon Proxy Docker container, drops the WebSocket driver shim, drops the deferred-connect quirks. Same `pg` driver in dev and prod via `localConnectionString`. Query caching is prod-only — code never depends on the cache for correctness.

### On documentation

**Q: Are existing docs sufficient or do we need a new one?**
A: Need one new doc (`docs/ARCHITECTURE.md`) and updates to three existing ones (TECH-STACK.md, CODE-RULES.md, AGENT-RULES.md). ARCHITECTURE.md is conceptual — patterns and rules, never inventory. Adding a new slice or port should never require updating it.

**Q: Should we split ARCHITECTURE.md into multiple docs?**
A: No. One doc, with table of contents. An engineer adding a feature needs slices + boundaries + Effect conventions + events all simultaneously; fragmented docs split the mental model.

---

## 6. Open Questions / Things to Revisit

These are explicitly NOT answered in the current plan. Pick them up when relevant.

- **Will the export feature need a dedicated `user-lifecycle` slice or live in a separate `exports` slice?** Decide when building.
- **GDPR / CCPA requirements concretization.** Real legal review needed before launching to EU/CA. Architecture supports it; specifics aren't decided.
- **Admin UI surface.** Will admin operations live in a dedicated `admin` slice with separate authz, or be scoped routes within each slice? Decide when admin tooling is built.
- **Observability stack.** Sentry / PostHog / Axiom integration not yet wired. Effect Logger + structured logs feed in cleanly when adopted.
- **Mobile-app idempotency-key generation.** Typed API client should auto-generate UUIDs and reuse on retry. Specific implementation deferred.
- **Whether `correlation_id` propagation should ever be added to Postgres.** If logs alone prove insufficient for cross-table investigation, revisit.
- **The exact list of `failure_reason` taxonomies** for each Pattern C operation. Defined when each operation is built.
- **Rate-limit policies.** Exact thresholds (X requests per Y seconds per actor) defined per-policy in the slice that owns the rule. Not pre-decided.
- **Circuit-breaker thresholds.** Defined per breaker. Not pre-decided.
- **Workflow retention.** How long do completed Workflow instances stick around before being archived? Cloudflare default is current; revisit if needed.
- **Cron-triggered Workflow bindings** (PR #13467 in workers-sdk) — tracking. Until merged, use `scheduled()` Worker handler to call `env.WF.create()`.
- **DI for the Workflow class itself.** A WorkflowEntrypoint can read `this.env`; how does it get the AppLayer? Practical detail to work out during first Workflow implementation.
- **The `apps/api/src/lib/effect-runtime/` bridge** is described but not implemented. ~30 LoC: `runQuery`, `runMutation`, SSE bridge, queue consumer wrapper.
- **Whether to extract `apps/api/src/lib/effect-runtime/` into a `packages/effect-runtime/` workspace package.** Unnecessary unless a second consumer (mobile native, marketing site) appears.

---

## 7. Reference: Source Conversation Highlights

Things to know about how the design evolved (in case you want to retrace reasoning):

- The plan started from an independent codebase review identifying 10 architectural problems (god route in `chat.ts` ~890 LOC, type/schema triplication, middleware composition boilerplate, error code/message split, billing math duplicated, env config fragmentation, implicit middleware DI, scattered link auth, validation split between Zod and services, oversized files).
- The user then proposed Effect + Modular Monolith with Vertical Slices + Hexagonal Edges, which became the spine of the design.
- Initial library list (neverthrow, emittery, p-limit, p-retry, custom race helpers) was collapsed into Effect after recognizing Effect subsumes all of them with stronger guarantees.
- The first version included an outbox `domain_events` table; subsequent refinement (after pushback on whether transactions alone suffice) collapsed it once the three-pattern rule was established.
- The architecture-gap research surfaced AuthzPolicy, Audit, RateLimit, CircuitBreaker, FeatureFlags, Cron jobs, GDPR flows, content-addressable storage, correlation IDs, backpressure, health checks. About half remain in the plan; half were dropped or deferred.
- The migration-risks research identified billing-first as the wrong order, shadow-execution missing, coverage gates breaking. All became moot when the user clarified "no users, single branch."
- The data-model gap research identified missing tables (outbox, idempotency, processed events, audit log, data migrations, correlation IDs, epoch FK chain). All but `epochs.previous_epoch_id` were eventually dropped or moved to Redis.
- Hyperdrive was approved mid-design after research clarified it eliminates the Neon serverless WebSocket driver lifecycle pain and simplifies local dev.
- Cloudflare Workflows replaced the original "per-slice typed jobs tables + cron sweep" pattern after research confirmed full local emulation and mature test integration.
- The audit log was dropped at the user's request.
- `nonIdempotent` was dropped after recognizing operations that seemed to need it weren't actually mutations of persistent state.
- The state machines library decision (xstate) was retracted after user pushback that transactions handle 95% of cases; remaining flows are hand-rolled discriminated unions.
- The migration plan (4 weeks, slice-by-slice, billing first) was discarded after the user clarified there are no users and the rewrite happens in one branch.

---

## 8. Closing Note

Every rule above is a hypothesis backed by reasoning visible in §5 (Q&A). Reasoning may be wrong. Discoveries during implementation may invalidate specific decisions. The pattern's integrity does not depend on every rule being correct; it depends on disagreement being surfaced and resolved rather than worked around.

If you find a rule that no longer serves the work, the answer is to update this document (and ARCHITECTURE.md) — not to silently break the rule. The cost of a small architectural conversation is much lower than the cost of architectural drift.

Pick this up where it left off. Question what needs questioning. Build.
