# Admin slice

The operations registry and Customer-360 read surface for the admin plane. This slice
owns exactly one table — `admin_audit` — and composes every other effect through
published slice barrels. Architecture shape: `docs/ARCHITECTURE.md` §Admin plane. This
file is the permanent normative home for the rules below.

---

## The Charter

Each value names its enforcement — a rule without a mechanism is a suggestion.

1. **The Reversibility Iron Law** (formalized below): every durable admin mutation has a
   registered inverse, and no admin operation destroys state the operator cannot restore.
   _Enforce:_ `defineAdminOpContract` throws at module load on a durable mutation with no
   inverse and on any other class that names one; the interleaving battery.
2. **Invariant-preserving by construction:** every write composes published slice
   barrels inside one settlement transaction; never a raw table write. _Enforce:_ this
   slice owns only `admin_audit`; arch rule bans raw Drizzle writes in op bodies.
3. **Atomic total auditability:** the audit row commits in the same transaction as the
   effect — effect-without-audit and audit-without-effect are both structurally
   impossible. Sensitive reads are audited too. _Enforce:_ the engine writes the row
   inside the op transaction; `admin_audit` is append-only via
   UPDATE/DELETE/TRUNCATE-raising triggers (owner-level bypass accepted; the off-vendor
   backup repository on B2 is the backstop).
4. **Preview that cannot lie:** preview is execute inside a rolled-back transaction —
   the same code path, never a parallel implementation. The rollback erases the audit
   row the op would have written, so a preview records itself as a read-audit row on the
   request connection before the transaction opens — naming the op, its input and its
   target, never the result; a preview refused before that point leaves no row.
   _Enforce:_ one engine code path with a rollback sentinel; the preview≡execute test.
5. **Exactly-once:** every op runs under `runMutation` + `idempotent.byKey`;
   double-click/retry never double-applies. _Enforce:_ the shared idempotency machinery;
   the idempotency trio per op.
6. **Reason-required, and always the operator's:** every mutation's input schema includes
   `reason`, and the string that reaches the audit row is the one a person typed for that
   mutation. An undo is a mutation, so its reason is the operator's account of why they
   reversed the act, never a machine-written one. _Enforce:_ contract-shape check in the
   registry exhaustiveness test; the engine throws a defect on an op body that authors a
   `reason` inside its `inverseInput`; the per-op battery asserts that no recorded
   `inverseInput` carries a reason and that an undo's audit row records the operator's.
7. **Guardrails as data:** per-op caps (`maxAmountNanoUsd`); exceeding refuses, and the
   refusal is audited. _Enforce:_ engine checks before execute; a guardrail-trip test
   per op.
8. **One definition, many surfaces:** an op is defined once and automatically becomes a
   UI form and an API endpoint hitting the same audited engine, on the surfaces its
   `allowedRoles` admit.
   _Enforce:_ generic routes + generic form; no bespoke per-op
   wiring exists to drift.
9. **Recovery paths are authentication paths:** every way in — enrollment, recovery,
   break-glass — is pre-staged at a physical ceremony and at least as strong as the
   primary path. No email, IdP, or online tool is a trust root; the fail strength is the
   safe, not an inbox. _Enforce:_ no self-service enrollment or recovery route exists in
   code; break-glass is physical artifacts plus a tested runbook.
10. **Nothing in the repo can mint access:** no credential, enrollment store, break-glass
    flag, or access-granting policy in code, CI secrets, or any store deployable code can
    write. _Enforce:_ enforcement lives at the edge (Cloudflare dashboard config); no
    deploy-flag auth mode exists.
11. **The Single Auth Path Law:** hardware-key MFA through Cloudflare Access is the only
    production authentication path — no service tokens, no API keys, no bearer secrets,
    no non-interactive path, no second credential class. The GUI is the only production
    admin surface (there is no CLI); break-glass is the physical ladder. _Enforce:_ the
    `admin` JWT stage requires a non-empty allowlisted `email` claim, so a service-token
    assertion (`common_name`, no `email`) fails closed — pinned by test; the dev-admin
    mint is `dev-only`-classed with no production signing key. The email must also carry
    a role-map entry, or the wall refuses it.
12. **Privacy by default:** content is unreadable by construction; metadata reads are
    scoped, audited, and volume-capped; exports are reason-gated ops. _Enforce:_
    read-audit rows + rate-limit registry entries on Customer-360 loads; the SQL panel
    role is SELECT-only.
13. **One pane of glass:** HushBox-owned data lives in the admin app; vendor internals
    (Sentry stack traces) deep-link out, never duplicate.
14. **Authorization is a role on a route:** every `admin`-classed route names the roles it
    admits in one route-keyed map that default-denies; a contract names the roles that
    may invoke it; a mutation may name only the operator. _Enforce:_ the Access stage
    refuses a route absent from the map or a role it does not admit; `defineAdminOpContract`
    throws at module load on an empty or unknown `allowedRoles` and on a mutation naming
    a viewer; the engine refuses by role before any transaction.

---

## The Reversibility Iron Law — formal statement

For every admin mutation `A` with registered inverse `A⁻¹`, any starting state `S`, and
any sequence of user/system actions `U₁…Uₙ` executable after `A`:

```
S → A → U₁…Uₙ → A⁻¹   ≡ₑ   S → U₁…Uₙ
```

where `≡ₑ` compares the **effective-state projection**: balances, lock state, session
validity, entitlements, quotas, catalog exposure, share validity. **Excluded from the
projection by design:** append-only trails (ledger legs, `admin_audit` rows) and
timestamps — the record of the act and its reversal is permanent; that is a feature, not
a violation — and **share-link guest membership**: `share.revoke` departs the seated
guest, and its inverse restores link validity only, by founder ruling (admins hold no key
material, so the member-initiated revoke stays the cryptographic path). A departed guest
re-enters through the normal link flow, never through the undo.

Three precision rules, without which the test harness will be built wrong:

- **Feasibility divergence is accepted, not a violation.** If `A` _enabled_ a user
  action (a credit let admission pass), the control run blocks that action and the two
  runs cannot be literally identical. The testable invariant is: **the op's own delta
  nets to exactly zero across any interleaving** (credit +5 … clawback −5 ⇒ net 0, even
  if spent in between — the balance goes negative, and a negative balance is a legal
  state, consistent with billing's unguarded-settlement doctrine), and no other artifact
  of the op survives reversal.
- **Content-equivalent, not row-identical — and an inverse may refuse.** `≡ₑ` compares
  effective state, so an inverse that RECREATES what its op removed satisfies the Law even
  though the replacement row carries a fresh id and `createdBy`: `newsletter.cancel`'s undo
  re-schedules an identical issue from the cancel-time snapshot rather than reviving the
  cancelled row, which is why that pair's projection is a row count over matching issues and
  not an id comparison. The cost of that reading is bounded and accepted — the undo runs the
  real `newsletter.schedule` body, so it refuses with a validation error once the issue's
  scheduled time has passed, and a cancel is therefore undoable only up to the send time it
  was cancelling. Reversibility is a guarantee about effective state, not a promise that
  every inverse succeeds from every later moment.
- **Effect taxonomy — the Law's scope.** Every op declares one of three effect classes, and
  the class decides what it owes. `durable` is state the operator originated (rows,
  balances, flags): it must be exactly invertible and must name a registered inverse.
  `ephemeral` leaves nothing durable behind, because its body takes no settlement
  transaction handle at all — the `admin-ephemeral-ops-take-no-transaction` arch rule
  checks that structurally, so the class cannot be claimed by a body that writes.
  `system-owned` has a durable effect that is an obligation the system already owed rather
  than an operator-originated change, and states that case in its contract, where a
  reviewer reads it at authoring time and the operator reads it in the op modal. Neither
  non-durable class may name an inverse — declaring one throws at module load, so the two
  are a narrower scope for the Law, never a soft opt-out of it. One boundary is
  load-bearing and unenforced: `newsletter.testSend` is `ephemeral` because its blast
  radius is the acting admin, whose address is the engine-supplied Access identity and
  never an input field. An op that mails anyone else at execute time is outside that
  rationale, and a sent message cannot be recalled, so it has no durable class either —
  which is why `newsletter.schedule` sends nothing itself and stays cancellable until its
  send time.

Consequences the Law forces — deliberate, do not "fix" them:

- **No admin card refunds.** A processor refund is irreversible external money movement.
  Real refunds happen in the Helcim dashboard; the ledger consequence is recorded via
  `wallet.clawback`.
- **Payment verdicts move the row, never the card.** The `payment.*` ops record what the
  operator established in the Helcim dashboard about a `payments` row the verify job could
  not resolve; none calls the provider. Each is an atomic conditional update on the row's
  current status, so an op racing the webhook or the verify job loses cleanly, and an
  inverse refuses once another writer has moved the row — the precision rule that an
  inverse may refuse, on a money path.
- **No admin account deletion.** Deletion is irreversible by definition; it remains the
  user-initiated, step-up-gated flow. Lock the account meanwhile if needed.
- **No external calls in op bodies.** Op dependencies are partitioned: a body holds
  only what the settlement transaction scopes, and a capability whose effect a
  rollback cannot undo reaches op code only after commit, as the argument handed to a
  registered post-commit effect.
- `job.discard` is a restorable marker, never a delete.

---

## The edge and break-glass

One Cloudflare Access app fronts both the admin SPA and the `admin`-classed routes: an
hardware-security-key MFA, AAGUID-restricted, with keys enrolled at a physical ceremony.
The Worker re-verifies the Access JWT on every `admin`-classed route through `jose`
against the remote JWKS, fail-closed, and admits only the intersection of the exact-match
email allowlist and the role map: an allowlisted address with no role entry is refused
(401); a role the route's map entry does not admit is refused (403) with one Sentry event
and nothing recorded durably. Execution is
instant — there are no delay tiers. Guardrails (the per-op money cap) are op metadata; rate
limiting is mounted per route and reads no op metadata. Break-glass is a physical ladder —
pre-enrolled backup key → Cloudflare dashboard → offline Neon and R2 credentials plus the
runbook — never a code path or a deploy flag.

---

## Op anatomy

Three pieces per operation, no more:

1. **Contract** in `packages/shared/src/admin/` — name (`'wallet.credit'`), title, kind
   (`mutation`/`read`), a **flat** Zod input schema (mutations always include
   `reason: z.string().min(1)`), `allowedRoles` (non-empty, over the closed role set; a
   mutation may name only `operator` — definition-time law, enforced by
   `defineAdminOpContract`), `inverse`, `effectClass`, optional guardrails. Flat
   means flat, with exactly one sanctioned exception — the **repeatable group**: a
   field may be `z.array(z.object({...}))` whose sub-fields are all flat scalars
   (string/number/boolean/enum, optionally optional; no unions, no nesting, no
   catchall — loose/catchall elements fail at definition time), rendered by the
   generic form as repeatable rows. Any other nested or conditional input moves the
   complexity into the op body, not the schema — the generic form renderer depends
   on it.
2. **Implementation** in `domain/operations/<name>.ts` — an `execute(ctx, input)` that
   composes other slices' published `*WithinTx` helpers on the engine-owned
   `SettlementTx` and returns typed `effects` (rendered by preview) plus `inverseInput`
   (stored in the audit row; consumed by undo). It may also register an optional
   `prefill(deps)` resolver — the op's current-state input (sans `reason`), served
   unaudited by the generic prefill route outside the engine; resolvers return only
   non-sensitive, admin-authored configuration. No `fetch`, no adapter imports, no raw
   Drizzle, no `Date.now`/random. **Inverse snapshot semantics:** `inverseInput` is
   captured from pre-state at execute time, never recomputed at undo time — e.g.
   `user.unlock` records the original `lockReason` so its undo restores `chargeback`,
   not a default `admin`. An inverse that applies defaults instead of restoring
   snapshots fails the interleaving battery. An `inverseInput` never carries a `reason`:
   it holds what the undo must reproduce about the target, and a justification is not a
   fact about the target — the operator types it at undo time. The engine throws a defect
   on an `inverseInput` that carries one.
3. **Registration** in `domain/registry.ts` — both directions of an inverse pair. The
   registry fail-fasts on a durable mutation without a registered inverse.

A `read` op is the same three pieces with a narrower body: it executes through the same
engine but opens no settlement transaction, returns data rather than effects, and names
no inverse, because it lands no durable state. It writes a read-audit row and answers a
result discriminated from a mutation's (`kind: 'read'`).

The engine (`domain/engine.ts`) owns everything else: transaction, guardrails,
idempotency, the audit row in the same transaction, the preview-rollback sentinel, and
undo. Ops never open transactions, never write audit, never check authorization: the
engine refuses by role before a transaction opens, writes no audit row for a refusal and
captures one Sentry event for it; an executed op's audit row records the actor's role.

---

## The mandatory test battery

Every op ships `describeAdminOp(op)` — the registry exhaustiveness test fails the build
for any op without it:

1. **Interleaving invariance** (the Iron Law test; durable ops): seeded property test — factory
   state → op → generated user-action sequence → inverse → effective-state projection
   equals the control run; the op's delta nets to zero even when interleavings consumed
   it. Mandated seeds + replay artifacts.
2. **Preview ≡ execute** — preview's effects equal the committed diff.
3. **Audit atomicity** — exactly one audit row per execute; injected mid-op failure
   rolls back effect and audit together.
4. **Idempotency trio** — duplicate delivery, retry-after-crash, concurrent race (money
   ops add the settlement races). Undo included: two concurrent undos of the same audit
   row commit exactly one — the undo's audit insert claims the `undoes` unique column.
5. **Conservation post-condition** (money ops) — `runConservationAudit` clean after
   execute and after undo.
6. **Authz is not an op concern** — ops never check auth. The identity seam and the
   route-keyed role map are enforced at the route layer and pinned by
   `routes.integration.test.ts` / `routes-reads.integration.test.ts` (no/invalid JWT,
   non-allowlisted email or no role entry ⇒ 401; a role the route does not admit ⇒ 403;
   zero effect either way), not by this per-op battery.
7. **Guardrail trip** — over-cap refuses; the refusal is audited.
8. **Reason + input validation** — missing reason refused at the boundary.
9. **Role refusal at the engine** — every role the contract does not admit is refused
   before any transaction, with no audit row and no effect; `describeAdminOp` derives
   the refused set from the closed role set minus `allowedRoles`.
10. **Reads run the read branch** — a `read` op skips the mutation items (interleaving,
    preview ≡ execute, idempotency trio, conservation, guardrail) and asserts its
    read-audit row, the absence of a settlement transaction, and the refusal items.

Integration-first against real local Postgres/Redis; never mock internal slices.
