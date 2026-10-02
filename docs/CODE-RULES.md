# Code Rules

---

## Core Principles

### 95% Test Coverage

- Every source file holds 95% line, branch, and function coverage, measured per file
- Tests are written before or with the implementation
- Every test runs: a test that cannot run is deleted, never left skipped or commented
- Coverage is part of `pnpm test` — a shortfall is a test failure — and is checked on
  every push

Enforcement: `config:coverage.thresholds` · `ci:test` · `doc`

### Type Safety

- Explicit return types on every function declaration and every exported function
  (an inline callback whose type its context already fixes needs no annotation). The
  rule binds TypeScript sources — a `.mjs` module cannot carry a return annotation
- Every value has a known type; `any` appears only beside a documented justification
- A test fixture sits in a position the compiler checks against the contract it
  stands in for — a declaration annotation, a declared return type on the stub or
  factory that produces it, or `satisfies`. A type assertion on a fixture needs the
  same documented justification as `any`, and a stub with no declared return type is
  the same defect without a cast
- Generated types come from Drizzle and Zod inference and are written once

Enforcement: `lint:@typescript-eslint/explicit-function-return-type` ·
`lint:@typescript-eslint/no-explicit-any` · `lint:disable-directives/require-reason` ·
`lint:vacuity/no-raw-function-type-assertion` · `arch:model-fixtures-bind-to-the-contract` · `doc`

### Fail Fast

- Validate preconditions immediately
- An error surfaces where it arises; a fallback value is never its substitute
- Missing config = immediate crash with clear message
- Invalid input = reject at boundary, not deep in logic

Enforcement: `ci:verify:env` · `doc`

### Platform Agnostic

- Every script, hook, and tooling path runs on Linux, macOS, and Windows
- Everything a contributor needs arrives via `pnpm install` — never a system package,
  never a documented manual install step
- Paths are constructed, never string-concatenated with `/`

Enforcement: `lint:no-restricted-syntax(cross-platform)` · `doc`

### Never Hide Problems

- A command's exit status reaches the caller, and its stderr stays visible
- A compiler suppression is `@ts-expect-error` with its reason beside it
- A lint suppression carries its reason after `--` on the directive
- No knip exemption tag on an export that could be imported instead. A tag records why
  the export has no importer and cannot get one — a consumer knip cannot see, or a ruling
  the tag cites; `knip.jsonc` declares the tags and what each one asserts. An export
  nothing reaches and no ruling keeps is deleted, or recorded as an audit finding when it
  is built-but-unwired work
- Dependency resolution succeeds on its own terms; a conflict is fixed in the manifest
- Committed code reaches the console only where lint allows it: `console.warn` /
  `console.error` everywhere; `log`/`info`/`debug` are additionally allowed only in
  CLI entry points under `scripts/`. Backend code logs through the Telemetry port
  regardless
- Fix the root cause

Enforcement: `lint:@typescript-eslint/ban-ts-comment` · `lint:disable-directives/require-reason` ·
`ci:lint:unused` · `lint:no-console` · `lint:redaction/no-raw-console` · `doc`

### Unattended by Construction

Every system keeps itself correct without a human hand, and lands on the highest rung of
this ladder it can reach:

- **Derived** — it has no state of its own; it is computed from its source of truth at
  use time
- **Self-recovering** — it has state and repairs it: leases, TTLs, lazy checks,
  version-keyed caches, record-on-miss
- **Refused at the gate** — the commit that would cause its drift is refused with the
  cause named
- **Watched** — its drift comes from outside the repo, and a watcher on another failure
  domain pages on failure and on absence; every chain of watchers ends at exactly one
  vendor-side monitor that pages a human

Three corollaries hold the bottom rung honest:

- A scheduled thing checks in, so its absence pages
- A curated list carries a liveness test where a dead entry changes behaviour; a
  registry derives its membership from its source of truth rather than curating it
- A pinned external fact is measured on every run rather than remembered

A system that reaches no rung is recorded in `docs/DECISIONS.md` as an exception, with
its reason and its re-entry condition.

---

## Error Handling

- Every caught error is handled or rethrown; a catch that does neither is a defect
- Use custom error classes with context
- Log with sufficient detail for debugging
- Best-effort surfaces (push, email, telemetry) may degrade; money, auth, and
  persistence fail fast and never degrade
- Every external call wrapped in try/catch

Enforcement: `lint:catch-swallow/no-silent-catch` · `doc`

---

## Patterns

### Single Source of Truth

- Drizzle schema defines database types
- Zod schemas define API contracts
- Types flow from these sources, never duplicated

Enforcement: `doc`

### One Implementation, Shared

- Logic whose correctness depends on being identical in two places is written **once** and imported by every caller — never re-implemented. It lives at the **narrowest scope that covers all its callers**: co-located in the owning package when every caller is inside it, hoisted to a shared package (`packages/shared`, `packages/crypto`, …) only when callers cross the package boundary. Never hoist to `packages/` speculatively.
- A **sync contract is the smell, not the solution**: a `keep in sync with X` comment, a mirrored constant, a golden cross-check test, or "both sides follow the spec" all permit drift. The resolution is one shared implementation: if you are writing a test to prove two implementations agree, delete one and share the other. One class is admitted, because the compiler cannot reach it: a file a vendor reads (a `wrangler.toml` trigger list, a workflow's env block) or a script the browser runs before modules load (the pre-paint accessibility script) is generated from the constants it shares, or held equal to them by a test that names them. Enforcement: `doc` · vendor-read files: `test:apps/api/src/whole-app/scheduled.test.ts`, `ci:generate:env`
- Strongest across the `apps/web` ↔ `apps/api` boundary: shared validation, pricing/markup math, formatting, serialization/encoding, crypto (AAD tuples, wrap order, compression), and constants live in a shared package and are imported by both — never re-typed on each side.
- **Identical ≠ complementary.** The ban is on copies that must agree to be correct — apply the test _"if these two drift, does something break?"_ Independent authorities that need not match are not duplication: client validation for UX plus server-authoritative re-validation (server wins), or a client-side defense the server does not trust. Do not collapse those — merging them destroys defense-in-depth.
- `jscpd` sees textual copy-paste and nothing else; logic re-implemented differently on each side is caught by review. A duplication you cannot collapse now is a **design question for the human**, never a silently added second copy.
- **Unit and integration test files are outside the duplication gate by decision** (`.jscpd.json` is the map of record): an explicit fixture repeated in ten tests reads better than a shared helper that hides what each case asserts, and the human reviewer, not the gate, catches a copy-pasted test helper. Playwright E2E `*.spec.ts` files are measured like any other source.

Enforcement: `ci:lint:duplication` · `test:apps/api/src/whole-app/scheduled.test.ts` · `doc`

### Environment Detection

- Environment branching reads `envUtils` (from `createEnvUtilities()`), which names the
  mode we are in; `NODE_ENV`, `CI` and `E2E` are read there and nowhere else
- A branch asks which mode we are in, never whether a variable exists
- `envConfig` defines every variable's value for every mode, so a variable has no
  fallback and no `??` default
- If a variable is missing at runtime, fail-fast with a clear error
- Backend middleware: use `c.get('envUtils')` (set by `envMiddleware()`)
- Middleware running before `envMiddleware()`: call `createEnvUtilities(c.env)` directly
- Service factories: accept `EnvContext` and call `createEnvUtilities()` internally

Enforcement: `lint:env-detection/no-direct-env-branch` · `ci:verify:env` · `doc`

### Idempotency

- Every operation safe to retry; every mutating route requires `Idempotency-Key` or
  declares a registered exemption class, each of which the architecture rule proves
  structurally
- Every mutation passes through one of the five `idempotent.*` wrappers (`byKey`,
  `byUpsert`, `byTransition`, `byEventId`, `byExternalPreClaim`); `runMutation` accepts
  only `Idempotent<T>`
- A state change is one atomic conditional update (`UPDATE … WHERE expected_state`)
  that asserts rows affected; on 0 rows, read the actual state — already-done is a
  no-op, illegal-state is a defect
- Storage keys are uuid, never content-addressed

Enforcement: `arch:mutating-routes-prove-idempotency` · `arch:idempotency-exemption-wrappers` ·
`lint:idempotency/no-brand-cast` · `lint:idempotency/no-brand-import` · `doc`

### Direct Resource Access

- A resource is reached directly, through its type-safe wrapper, with no service in between
- Type-safe wrappers for all external resources
- Packages provide safety without network hops

Enforcement: `doc`

### API Client

- `apps/web/src/lib/api-client.ts` is the single source for all typed API calls
- All server state management uses TanStack Query hooks wrapping the typed client
- Every call to an endpoint the typed client covers goes through the typed client
- Hono route definitions are the single source of API types (via `AppType` export)
- A response body with a client-side twin binds to a shared Zod schema in
  `packages/shared` at the body-building function — annotate a constructed body with
  the schema's type, or `satisfies` the schema type on an inline literal — so a
  schema rename is a compile error in `apps/api` (mechanics: `apps/api/CLAUDE.md`
  §Routes)

Enforcement: `lint:web-api-client/no-raw-fetch` · `arch:web-mutations-declare-idempotency` ·
`arch:route-handlers-stay-inferred` · `doc`

### Error Responses

- API errors return `{ code: string, details?: object }`, with no message field
- `code` is a machine-readable constant exported from `packages/shared/src/errors/error-codes.ts`
- Frontend maps `code` to user-facing message via `friendlyErrorMessage()` from `@hushbox/shared`
- All user-facing error messages live in `packages/shared/src/errors/error-codes.ts` (the `ERROR_MESSAGES` map); `error-messages.ts` holds only the branded `UserFacingMessage` type
- New error codes need: (1) constant in shared error schema, (2) entry in `friendlyErrorMessage` map
- Budget/billing notifications use `generateNotifications()` (separate system, already user-friendly)
- Every API error response is built by `createErrorResponse(code, details?)`

Enforcement: `lint:error-responses/error-response-constructor` · `arch:domain-error-status-map-has-one-home` · `doc`

### Serverless Mindset

- Handle cold starts gracefully
- State lives in the database or Redis; nothing persists in memory across requests

Enforcement: `doc`

---

## Backend Doctrine

The backend's binding rules, grouped by principle. Mechanisms are described in
`ARCHITECTURE.md`; these are the constraints on code you write.

### Money & Settlement

- Nothing commits mid-run; all money and content commit in the one `settle()` transaction,
  entered only with the branded `SettlementTx` handle
- The ledger is double-entry: signed legs per `transactionId` summing to zero — violating
  writes must fail at commit
- Money is nano-USD `bigint`; serialize as `NanoUSD` strings at JSON boundaries; never
  `Number()`-coerce money; intermediate markup math in `numeric`
- Fees are baked at the two seams (catalog ingestion: ceil; provider-cost conversion at
  the ModelProvider port: half-even); settlement receives already-billable amounts
- Admission is the only balance gate; settlement charges unguarded, and negative
  balances are legal states
- The ledger is the truth of money; Redis holds and snapshots are advisory
- Group budgets are lifetime cumulative allowance rows written at settlement; the free
  daily allowance is day-keyed — never reset jobs

Enforcement: `type:SettlementTx` · `lint:money/fee-seams` · `arch:money-internals-owners-only` ·
`arch:web-prices-through-producers` · `arch:no-external-call-in-transaction` ·
`test:packages/db/src/schema/shape/money.test.ts` · `doc`

### Jobs & Async

- Every must-happen async task is a `jobs` row inserted in the caller's transaction,
  registered with a payload schema and a mandatory idempotency class
- Cron hosts only pollers, retention deletes, and read-only auditors — never delivery
- No message queues, no DLQs; dead jobs are rows, redriven or discarded explicitly
- Every job must be able to succeed for every legal payload; already-done is success (the
  idempotent no-op). Execution is at-least-once. A job that cannot reach success is a code
  defect, never an operational state — the enqueuer, handler, or schema is wrong
- Malformed payloads are rejected at enqueue (Zod, inside the caller's transaction) — they
  fail the enqueuing operation, never create a doomed row
- A dead row has exactly two dispositions: fix the cause and redrive, or discard by audited
  admin action; discarded rows prune on retention. An unresolved dead row is never
  auto-deleted

Enforcement: `arch:cron-hosts-no-delivery` · `arch:job-wakes-have-one-path` · `doc`

### Crash Recovery

- Recovery is in-mechanism: leases, TTLs, and lazy checks; read paths never depend on a
  purge or cleaner having run
- Auditors detect and page; repair is explicit redrive; never add a backup mechanism or a
  silent self-healing sweep
- Retry and timeout policies only; no in-isolate circuit breakers

Enforcement: `lint:runtime-primitives/no-external-cockatiel` · `doc`

### Boundaries

- One writer per table; cross-slice writes only through published APIs — the barrel or a
  `public/` entry module — inside the orchestrator's transaction
- Slice code writes only its own slice's schema objects
- Routes hold no business logic and never import repositories; domain imports only its
  slice's ports

Enforcement: `lint:boundaries/dependencies` · `arch:single-writer-per-table` ·
`arch:no-drizzle-operators-in-barrels` · `arch:barrels-hold-exports-only` · `doc`

### Telemetry

- Log only through the typed `SafeLogFields` logger; `msg` accepts compile-time literals
  only
- A log line carries codes and identifiers only; message content, prompts, outputs,
  keys, ciphertext, PII and request or response bodies stay out of every log
- Errors carry codes, never content; domain code returns `Result`, adapters translate
  throws at ports, an exception reaching a route is a defect (500 + Sentry)
- Error and analytics capture is backend-only; the client carries no such SDK. The one
  client-side emitter is the marketing site's in-house visit beacon, which never runs on
  the app origin and whose counts never join an account (`docs/GROWTH-MEASUREMENT.md`)
- Every metric names its watcher (auditor, dashboard, or alert) or doesn't ship

Enforcement: `lint:redaction/logger-msg-literal` · `lint:redaction/no-sensitive-log-argument` ·
`lint:redaction/no-raw-console` · `lint:runtime-primitives/must-use-result` ·
`lint:no-external-sentry/no-external-sentry` · `lint:no-restricted-imports(client SDKs)` · `doc`

### Registries

- Env vars exist only as `env.config` registry entries (per-mode values, Zod, no fallbacks)
- Redis keys exist only as typed key-registry entries (schema + TTL + buildKey)
- Model metadata (capabilities, pricing, ParamSpecs, ZDR-reachability) is auto-discovered
  from OpenRouter's live catalog + `/endpoints/zdr`; unrepresentable data (unknown pricing
  unit or model type) is excluded with a warning

Enforcement: `ci:verify:env` · `arch:redis-keys-come-from-the-registry` · `doc`

### Crypto

- Every blob is versioned; AAD binds the full location tuple including `senderId`
- Keys are branded types; wraps are domain-separated; nonces are fresh per blob
- Decompression aborts mid-stream at an absolute byte cap; it is a client-side defense —
  the server takes plaintext for inference and never inflates client bytes

Enforcement: `test:packages/crypto/src/primitives/format-vectors.test.ts` ·
`test:packages/crypto/src/primitives/bounded-inflate.test.ts` · `doc`

### Admin Operations

- Every admin mutation is a registered operation declaring its effect class; a durable
  one names a registered inverse, and no admin operation destroys state the operator
  cannot restore (the Reversibility Iron Law)
- The `admin_audit` row commits in the same transaction as the operation's effect
- Preview is execute inside a rolled-back transaction — the same code path
- Operations compose published slice barrels inside one settlement transaction; the
  admin slice owns no table but `admin_audit`
- No credential, enrollment store, or break-glass path exists in code, CI secrets, or
  any store deployable code can write
- **The Single Auth Path Law:** hardware-security-key MFA through Cloudflare Access is
  the only production authentication path to the admin plane, and the GUI is the only
  production admin surface; the `admin` JWT stage enforces it in code by requiring a
  non-empty allowlisted `email` claim, so an assertion lacking one fails closed

The charter, effect classes, op anatomy, dependency partitioning and the mandatory test
battery: `apps/api/src/slices/admin/CLAUDE.md`

Enforcement: `lint:admin-ops/op-purity` · `arch:admin-op-purity` ·
`arch:admin-ephemeral-ops-take-no-transaction` · `arch:admin-external-ports-stay-post-commit` ·
`test:packages/shared/src/admin/contract.test.ts` · `doc`

### Changing the Architecture

- Before adopting an excluded service, reversing a deliberate limit, or proposing a gate,
  lint rule, doc mechanism or dependency, consult `docs/DECISIONS.md` — the re-entry
  conditions are the decision. Enforcement: `doc`

---

## Code Organization

### Naming

- Filenames: `kebab-case` (e.g. `two-factor-setup.tsx`, `use-delete-account.ts`)
- Component symbols: `PascalCase` (the export name, not the filename)
- Hook/utility symbols: `camelCase`
- Constants: `SCREAMING_SNAKE_CASE`
- Types: `PascalCase`
- Tests: `*.test.ts`

Enforcement: `doc`

### Durable Naming

- Code lands at its final, orthodox paths with final names from day one
- A name carries what the thing is; its version lives in git history, and a file, dir,
  export, pg object, pnpm script or config key carries no version suffix
- Code, comments and test names describe the code; a task id or plan reference
  identifies a run and lives in the run record
- A wrong or transitional name is treated like a wrong comment — worse than none

Enforcement: `doc`

### Structure

- Colocate tests with source
- Shared code in `packages/`, never copy-pasted — logic that must stay identical across places is shared, not synced (see **One Implementation, Shared**)
- One component/function per file
- A module stays under 800 lines counted without blank and comment lines; a data table
  that exceeds it says so where the cap is lifted, with its reason on the directive
- `index.ts` for exports only. Coverage excludes `**/index.ts` on the
  same premise, so logic in a barrel is not only misplaced — it is unmeasured

Enforcement: `lint:max-lines` · `arch:barrels-hold-exports-only` · `doc`

### Imports

1. Node built-ins and external dependencies
2. Workspace packages (`@hushbox/*`), then the app-local source alias (`@/*`)
3. Relative imports
4. Type imports last

Enforcement: `lint:import/order`

---

## Testing

### Requirements

- Unit tests for all business logic; integration tests for database and API operations;
  E2E tests for critical user flows
- Every behaviour is proven at the highest of three rungs it can reach: locally, against
  the real local stack; in CI with an evidence row, where a vendor cannot be emulated; in
  production, only for a best-effort mechanism that fails open, recorded in
  `docs/DECISIONS.md` with its reason. Money, auth and persistence have no production
  rung. Enforcement: `config:coverage.thresholds` · `ci:verify:evidence` · `doc`
- An invariant over all inputs — a codec round-trip, a conservation law, an ordering
  guarantee — is property-tested beside the module that holds it, with the generator
  named in the test
- Integration-first: tests run against real local infra; mocks exist only at true external
  seams (gateway, payments, email, push) — never for internal slices
- Tests must not depend on execution order
- No hardcoded dates or times anywhere in a test — every instant comes from the shared
  test-time module, with the clock mocked to it
- Test behavior, not implementation

Enforcement: `config:coverage.thresholds` · `ci:verify:evidence` ·
`lint:no-restricted-syntax(vi.mock slice barrel)` · `arch:no-evidence-from-mocked-seam` ·
`arch:test-vite-servers-name-their-cache` · `ci:privacy:sweep` · `doc`

Running tests, coverage mechanics, cassettes, and when to write an E2E test:
`docs/TESTING.md`

### What to Test

- Happy paths
- Error conditions
- Edge cases and boundaries
- Idempotency
- Input validation

Enforcement: `doc`

---

## Security

- Validate all external input with Zod
- An identifier a client sends is resolved against the caller's own rows before it is acted on
- User input reaches a query only as a bound parameter
- A secret lives in the env registry and reaches no source file and no log
- Every route declares a rate-limit posture in the route-keyed posture map, and the
  pipeline default-denies a matched route whose posture is absent; every counted limit
  declares its failure posture per route. Which routes earn a named limit or an IP layer
  is review judgement: `docs/RATE-LIMITING.md`
- One counting implementation, no exceptions: exactly `maxAttempts` admitted under any
  concurrency — a cap beatable by issuing it in parallel is not a cap, and a hand-rolled
  counter is a defect
- Secret-guessing surfaces clear their counter on verified success; abuse throttles
  never clear

Enforcement: `arch:public-routes-prove-authorization` · `lint:no-secrets/no-secrets` ·
`ci:gitleaks:scan` · `lint:redaction/no-sensitive-log-argument` ·
`arch:declared-route-keys-match-disjoint-paths` · `arch:rate-limit-exemptions-prove-their-obligation` ·
`arch:rate-limit-registries-publish-where-routes-count` · `lint:rate-limit/fails-closed` ·
`lint:rate-limit/no-window-counter-shape` · `arch:event-counting-in-rate-limit` ·
`arch:no-lossy-counter-gate` · `doc`

---

## Performance

- Measure before optimizing
- Add indexes for common queries
- Cache expensive computations
- Paginate list endpoints
- Stream large responses
- Work expected to exceed ~5 seconds runs as a `jobs` row through the dispatcher,
  never in the request path

Enforcement: `doc`

---

## Documentation

### When to Comment

Default to no comment. Write one only when a future reader with no context cannot derive the fact from the code, names, types, or tests, and the fact is load-bearing on correctness or future modification and survives the current task.

Examples:

- Non-obvious business or domain logic
- Source-of-truth designations
- Hidden coupling between files or modules
- Race conditions and ordering constraints
- Security or regulatory requirements the code enforces but doesn't explain
- Performance traps
- Library, browser, or external API quirks
- Rejected alternatives with the reason for rejection
- Code that looks removable but isn't
- Exceptions to established rules
- Subtle edge cases

A comment is one line, two when the fact needs two. Length follows the size of the durable fact, never the size of the change: a rejected-alternative record or a hidden-coupling warning may run longer, but a paragraph explaining ordinary code means the code is wrong.

A wrong comment is worse than no comment. If you can't state the durable fact precisely, leave it out.

A comment can also decay: true when written, false once the thing it describes grows. A count, a list of call sites, or "this catches X and nothing else" all rot without anyone editing them. Prefer stating the derivation over the enumeration — "the router's verbs less `get`/`options`" survives a new verb; the list does not. Position decays on insertion the way a count decays on growth: "the branch above" is falsified by anything later slipped between, so name the thing rather than its place — "the branch the guard clause rejects" survives an insertion; "above" does not. An ordinal is a position wearing a different word: "the third symptom" is falsified by a fourth being added ahead of it, exactly as "above" is. Where the thing named is code, name it through a reference that resolves — `{@link symbolName}` for a symbol, a backticked path for a file — so an editor can follow it and a rule can check it.

An enumeration's decay depends on where it sits: in the predicate, or trailing a
quantifier as examples. "The wrapper owns release order and concurrency" makes the
list the claim — a third owned thing falsifies the sentence while the rule it stood
for is unchanged. "Anything that reaches ESLint by another route — a scoping filter, a
reporting run, a package's own `eslint .` — lints without the flag" asserts its
predicate of the general subject; the items only illustrate it, and a fourth route is
already in scope. Same punctuation, opposite decay. Apply the test in both
directions: rewrite the first shape as the second, and never "fix" the second into
the first — it was not a list.

Where a count is not itself the claim, delete it rather than correct it. A corrected count rots on the next adjacent edit exactly as the original did; the claim it was standing in for does not.

### When Not to Comment

- Obvious operations
- Self-explanatory names
- Standard patterns
- What code does (code shows this)
- Code you didn't change
- Restating the adjacent code in prose
- Anything that belongs in the commit message or PR description

Enforcement: `lint:comments/resolvable-cross-reference` · `doc`

### What a Comment Leaves Out

A comment carries what stays true across the code's life: it names a module by role
rather than by a path that may move, states a dependency by what it requires rather than
by a version number, describes cost by its shape rather than by a timing estimate, and
identifies a thing by what it is rather than by an ephemeral value such as a container id
or a hash. Work that remains to be done belongs in the run record or the issue, never in
a `TODO` or `FIXME`; a task id or plan reference is Durable Naming's concern and stays
out for the same reason.

### Doc Lifecycle

Every doc in the repo is exactly one of three things:

1. **Loaded** — lives in or is imported by a `CLAUDE.md` (the root chain, or a nested
   `CLAUDE.md` that loads when working in its directory). Must describe the current
   system.
2. **On-demand** — listed in `docs/DEVELOPMENT.md`'s doc index with the trigger for
   reading it. Must describe the current system.
3. **History** — lives in `docs/history/`. Never updated, never cited as current.

Tier decides what a doc may carry. A loaded doc carries only what binds every task in
its scope: a line enters one when an agent on a task that never touches the line's
subject would still act differently for having read it. Everything else — mechanics,
gotchas, the facts one task needs — lives in the on-demand doc whose index trigger names
that task, and a fact with no such home gets a new on-demand doc and its index line in
the same change, never a line in a loaded doc.

A nested `CLAUDE.md` is the loaded tier for one directory: it loads for every task in
that tree and for none outside it. A directory earns one when it is a workspace package,
an app, or a lint- or arch-governed subtree with its own layer rules, and it holds rules
that bind every task inside the tree and no task outside it. A rule binding tasks across
trees goes in the root chain; a fact one task needs goes in an on-demand doc; a
single-file fact is a comment. Content is written in the file, never imported from
`docs/`. A directory that fits and has none gets one in the same change as the first
rule it would hold.

A doc that fits none of these is deleted. When a change supersedes documented
behavior, the same change updates every affected doc — loaded or not; if a doc cannot
be brought current in that change, it moves to `docs/history/` instead of staying
stale in place. A stale doc presented as current is a wrong comment at file scale —
worse than none.

Three directories are exceptions. `docs/runs/` holds subagent-driven-dev run
directories (plan, ledger, task reports); they are run records, not docs — they stay in
place after the run and are never updated or cited as current. `docs/audits/` holds one
directory per audit run: a ruled findings set that is the single source of truth for the work
it describes, live until every approved finding in it is closed, and thereafter a record
of what was decided and why. An audit doc is never a description of the current system,
so it is never stale in the sense this section means; it is dated, and its date is what
scopes it. `docs/DECISIONS.md` is the register of declined proposals and recorded
exceptions: each entry carries the date it was ruled, the reason, and the condition that
would reopen it, and an entry is edited only by the ruling that supersedes it; the
register describes decisions, never the current system, so it is on-demand and never
stale. `docs/history/` remains for document-level records: superseded or completed
docs whose active life has ended.

Doc lines earn their place: for each line, ask whether removing it would cause an agent
or reader to make a mistake. If not, cut it — bloated docs get ignored.

---

## Enforcement

A rule that is not enforced is a suggestion. Every rule in this document names the
mechanism that holds it, as an `Enforcement:` clause of tags; a rule whose only mechanism
is review says `doc`. The tags, each machine-checked against the mechanism it names:
`lint:<rule>` (an ESLint rule id at error severity in the shared config, with a selector
or path in parentheses where one rule carries several) · `arch:<rule>` (an architecture
rule under `packages/config/arch/rules/`) · `test:<path>` (a test file) · `fixture:<name>`
(a Playwright fixture) · `ci:<script>` (a root pnpm script a CI step runs) ·
`config:<key>` (a configuration key) · `type:<symbol>` (an exported type) ·
`report:<name>` (a wired reporter) · `doc`. A mechanism named in prose stays in plain
text; a backticked token in an `Enforcement:` clause is a tag and reddens the citations
test when it resolves to nothing.

- Pre-commit regenerates derived files and runs the privacy gate over the staged diff;
  pre-push runs every lint and typecheck gate, then the full test suite; CI runs the
  full gate set with coverage. The gates, the hooks, and `pnpm privacy` over the working
  tree: `docs/BUILD-AND-CI.md`
- Custom rules live in `packages/config`: `eslint-extensions/` (vendored ESLint rules)
  and `arch/` (ts-morph structural rules, `pnpm arch:check`) — each has a README
- Review: Human judgment on patterns and quality

No exceptions.
