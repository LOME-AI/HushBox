# Architecture rules (ts-morph harness)

Structural rules that ESLint cannot express — one file per rule under
`rules/`, each pinning an invariant that is visible in the repository's syntax
but that no single module's types can hold. `rules/` is the list and
`pnpm arch:check` prints the count; this file describes the layer, never
surveys it. Related structural rules that ESLint CAN
express live in the eslint layer instead — no-raw-Drizzle-in-domain is
`eslint-plugin-boundaries` (`boundaries.config.mjs`) and ValueStore isolation
is the vendored `engine-node-purity` rule (`engine-purity.config.mjs`); one
mechanism per rule, never both. Run via `pnpm arch:check` from the repo root;
also a CI step. The scanned trees are the workspace patterns
`lib/source-scope.ts` declares — `ads`, `apps/*`, `e2e`, `ops`, `packages/*`
and `scripts` — less the trees and directories the same module subtracts.

## Layout

- `run.ts` — the CLI: builds one ts-morph project over the globs
  `lib/source-scope.ts` declares, loads all rules, exits non-zero on
  violations.
- `lib/source-scope.ts` — the declared scope: which workspaces are scanned,
  which are deferred and why, and the globs both derive from.
- `lib/harness.ts` — discovery/loading/running, independent of the rule set.
- `lib/` (the rest) — the readings rules share. A fact two rules would each read
  off the repository — a path, a reference form, a route shape, a call spelling, a
  registry's members — has one reading here, because a second copy is one rule
  reading the repository differently from its neighbour, and the difference hides
  exactly where a hole is: a form one walk skips is a silent pass in one rule and a
  silent green in the other. Each module owns a reading and nothing else — what to
  do with what it reads stays with each rule — and its header states what it owns,
  what it leaves to the rules, and its reach. The directory is the list; before
  writing a walk inside a rule, read `lib/` for the one that already exists.
- `rules/*.rule.ts` — one rule per topic-named file, the extension slot.
- `types.ts` — the `ArchRule` contract.

## Contract for adding a rule

- Add **one new file** named `<topic>.rule.ts` under `rules/`. Each file owns
  exactly one rule; never edit the harness to add behavior. **"Behavior" means
  rule logic** — a rule implemented as a special case inside the runner instead
  of as a file. Widening `lib/source-scope.ts` changes _which files the rules
  see_, not what any rule does, and is the sanctioned way to change scope: that
  module is the statement of scope, and rules are
  contracted to receive every in-scope file and filter inside `check`. Measure
  the blast radius when you widen it — every rule gains the new files at once.
- Default-export an `ArchRule` (`{ name, check(project) }` from `../types.js`).
  A malformed rule file fails the whole run loudly — there is no silent skip.
- Read the syntax where the invariant is visible in it, and resolve — through the
  checker or an exports map — where it is not; several rules do. Resolution is the
  rule's own, which is why `lib/module-references.ts` owns the reference forms and no
  rule's resolution.
- Rules receive every in-scope source file; filter paths inside `check` if the
  rule targets a subset (see `do-classes-live-in-realtime.rule.ts`).
- Ship a colocated `*.rule.test.ts` exercising the rule against in-memory
  ts-morph projects (violating and passing shapes) — written test-first.

## What a rule looks like

**`rules/` is the list, and `pnpm arch:check` prints the count.** The four
entries below are a fixed illustrative selection, not a survey: they are chosen
for what each teaches about writing rules in this layer and are deliberately
never grown as rules are added, so nothing here is a claim about how many rules
exist. Between them they answer why a rule belongs here at all, how its scope is
made falsifiable, how a clause avoids enumerating, and what a rule cannot prove.
Everything specific to one rule lives in that rule's own file and colocated
test — the only place it stays true.

- **Why a rule belongs in this layer** — `money-internals-owners-only`: the
  affordability module's internals are reachable only from **price owners** (code
  that _produces_ prices), never from consumers. The export map already draws a
  wall over _paths_; this rule draws the one the export map structurally cannot —
  over _importers_. That gap is the test for whether a rule belongs here rather
  than in package exports or an ESLint boundary.
- **How a rule's scope is made falsifiable** — `public-routes-prove-authorization`:
  a guest-reachable route is `public`-classed **plus** an in-handler credential
  gate, so the route class alone does not say
  whether a route is anonymous or credential-gated and the pipeline authorizes
  neither. A `public` route that acts on one conversation (a `:conversationId`
  path param, or a conversation id read from the body — the link-guest send) or
  that names the link credential (`LINK_CREDENTIAL_HEADER`, or the header string)
  must lexically resolve its caller: `resolveConversationCaller` /
  `resolveMediaCaller`, directly or through a helper carrying one that is
  declared in the registering module or imported from a sibling module of the
  same slice's `routes/` directory. Both bottom out in identity's
  `resolveLinkGuestPrincipal`. A handler defined in another file fails —
  authorization cannot be proven at the route seam.
  Scope is read from signals that survive deleting the gate, which is what makes
  the rule falsifiable rather than self-satisfying; there is no exception list,
  because an exception list is the laundering hole the rule replaces.
- **How a clause avoids enumerating** — `effort-availability-has-one-publisher`:
  the effort-availability channel has ONE writer and ONE call site, in two
  clauses. The first counts calls of
  `useEffortAvailabilityPublisher`: exactly one, in the composer's effort
  control. The second refuses the bypass the first cannot see — a surface that
  skips the publisher and writes the store's graded field itself, by naming the
  setter, by destructuring it out, or by reaching zustand's `setState` while
  holding the store. Why: the publisher grades the effort ladder against the
  payer whose funding the calling instance holds, and several budget instances
  are live at once against different payers, so two publishers neither agree nor
  converge — each write wakes the other until React aborts the render. Structure
  put the publisher inside the effort control; nothing but this rule stopped a
  second caller being added. The writer clause closes over the two write
  CAPABILITIES rather than over syntactic positions, because two earlier
  enumerating versions were each one position short. Its exemptions are
  declarations, not files — the publisher's own body, and the store's
  `create(...)` initializer plus the type spelling its shape — since a whole-file
  exemption is what let a second publisher declared beside the first escape both
  clauses at once. Test files are out of scope: the regression test renders two
  publisher instances on purpose.
- **What a rule does not prove** — `no-evidence-from-mocked-seam`: no backend
  file may both fake the HTTP transport and enable a `service_evidence` write.
  The invariant it guards, why the fcm/webpush/resend sender factories are
  **correct and must not be "fixed"**, and how a fake is told apart from a
  real-delegating wrapper are all in the rule file's header, where they stay true.
  What belongs here is the limit. The rule catches a **shape**, never an intent:
  it cannot show that an evidence write in a passing file followed a genuine
  network call, and no static rule can. It keys on the statically visible shape
  (fake transport + open evidence gate), which is broader than the harm it exists
  to prevent — a faked transport sitting next to a **real database connection**
  (`createDb`), the combination that lands a real row from a call that never left
  the process. A test that fakes the transport but hands the adapter a fake db
  cannot write a real row at all.

  **Verified escapes — do not read the guard as total.** Each of these passes the
  rule today:

  - An in-file hand-written fake that touches no `vi.*` at all, such as an
    `async () => Response.json({ name: 'x' })` bound to `fetchImpl`. This is the
    repo's own prevailing style (`payment-helcim-fixtures.ts`'s
    `createFixtureFetch`, `gateway-metadata.test.ts`), so it is the likeliest
    escape, not a contrived one.
  - `isCI` passed as a shorthand or a variable rather than a `true` literal — a
    one-token mutation of the actual `push-fcm` violator.
  - `globalThis.fetch = vi.fn()` / `global.fetch = vi.fn()` assignment (only
    `vi.stubGlobal('fetch', …)` is recognized).
  - msw's `setupServer` and module-level `vi.mock('./transport.js')`, which fake
    the transport without ever naming a `fetch` slot.
