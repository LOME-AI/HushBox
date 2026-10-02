# Billing behaviour catalogue

Every individually testable billing behaviour, one statement at a time. Each entry carries a
stable id and a pass/fail statement, where the behaviour is stated, the sharp edges most likely
to break it, and what an observer would see if it worked or broke.

The ids are the point of the catalogue. `packages/config/behaviour-ledger.json` carries one row
per id naming the proof that would catch that behaviour's break, and its checker parses this file
for the id set: a behaviour declared here with no row fails `@hushbox/config`, and a row naming an
id this file does not declare fails it too. The two are deliberately separate artifacts — the
check is only worth running because the id set comes from somewhere other than the rows. So the
meaning of an id lives here and nowhere else, and the ledger holds ids, layers and proofs and
never restates a behaviour.

Adding or retiring a behaviour is therefore two edits: the declaration here and its row there. An
id is never reused for a different behaviour — the row's proof would silently come to stand for
something it does not prove.

An id is declared by the bold or `###` line that opens its entry, with the id as that line's first
token; a run of consecutive ids is declared with `through`. An id mentioned mid-sentence declares
nothing, so cross-references between entries are safe to write.

---

## Part 1 — behaviours `docs/BILLING.md` states

`docs/BILLING.md` is the specification of record; this part enumerates it statement by statement.
Each entry cites the doc, and a citation that no longer resolves means the specification moved and
the entry needs re-reading against it. Part 2 holds the behaviours the code has and the
specification does not, so a behaviour absent here is not necessarily absent from the system.

## 1. Money & funding primitives

**FUND-1 — Money is a nano-USD `bigint`, serialized as a decimal `NanoUSD` string at every JSON
boundary, never a JS `number`.**
Citation: BILLING.md §Units and rates (NanoUSD).
Sharp edges: any code path that `Number()`-coerces a money value, or that serializes a money
field as a JSON number instead of a string, silently loses precision past 2^53 or introduces
float error.
Observability: the wire type of a money field (string vs. number) in any API response body;
a garbled balance is the downstream user-visible symptom.
Visibility: internal-but-observable via API response shape; indirectly user-visible.

**FUND-2 — The billable rate (provider rate with the 15% fee baked in) is the only rate that
exists anywhere in storage or calculation; the raw provider rate is never persisted or priced
against directly.**
Citation: BILLING.md §Units and rates (billable rate).
Sharp edges: a stray "provider rate" value reaching a calculation or a stored row bypasses the
one fee-baking seam and produces an under- or un-fee'd price everywhere downstream.
Observability: catalog row's stored rate value vs. a known provider rate (DB read); indirectly,
the price shown to the user.
Visibility: internal-but-observable via DB.

**FUND-3 — `fixedCosts` = input tokens × input rate + `inputStorage` + `classifierReserve` (only
when a classifier will run) + each persisting answer's framing allowance + any additive
dimension's requirement.**
Citation: BILLING.md §Units and rates (fixedCosts).
Sharp edges: omitting any one term under-reserves (a real charge later exceeds the hold);
double-counting a term (e.g. counting `classifierReserve` when no classifier will actually run
because the pool resolved to one distinct choice) over-reserves and can produce a false refusal.
Observability: internal only — the hold size is invisible outside the admission script; only
indirectly observable via whether a marginal-affordability turn is admitted or refused.
Visibility: internal-only.

**FUND-4 — `variableRate(m)` includes a storage term only when the turn persists; trial turns
(which never persist) use output rate alone.**
Citation: BILLING.md §Units and rates (variableRate(m)).
Sharp edges: a persisting turn missing the storage term under-reserves; a trial turn that
incorrectly includes a storage term shrinks its effective per-message headroom below what the
doc guarantees.
Observability: internal-only for the reservation math; indirectly visible as the trial
per-message cap's effective headroom, or the final displayed cost on a persisting turn.
Visibility: internal-only, indirectly user-visible.

**FUND-5 — A decision that gates _who pays_ may consume only bounds (`minTurnCost`), never a
priced estimate — resolving the payer-decision circularity is one pass, never an iteration.**
Citation: BILLING.md §Units and rates (A decision that gates pricing may consume only bounds, never prices).
Sharp edges: any code computing a full priced estimate as an input to, or as part of, the payer
decision has reintroduced the circularity the doc says has no fixed point.
Observability: `FundingInputs`' type shape carries no estimate field (see FDM-2); testable by
attempting to construct a `FundingInputs` with an estimate — should not type-check.
Visibility: internal-only (type-level).

**FUND-6 through FUND-12 — the funding vocabulary.** `balance` = payer's purchased-wallet ledger balance, may be negative
(BILLING.md §Funding (balance)). `allowance` = remaining free daily allowance, day-keyed (BILLING.md §Funding (allowance)).
`cushion` = paid-tier-only permitted negative excursion, `MAX_ALLOWED_NEGATIVE_BALANCE_CENTS` = 50¢
(BILLING.md §Funding (cushion)). `effectiveBalance` = paid: balance+cushion; free: allowance; trial: fixed per-message
ceiling; guest: none of its own, the payer's applies (BILLING.md §Funding (effectiveBalance)). `holds` = Σ payer's
unexpired admission holds (BILLING.md §Funding (holds)). `spendable` = effectiveBalance − holds, one number per payer, no
token quantity or per-model term (BILLING.md §Funding (spendable)). `spendable` is a property of the **payer**, never the
sender (BILLING.md §Funding (spendable is a property of the payer)).
Sharp edges: mixing up payer-vs-sender on any of these six terms is the single most repeated
sharp edge in the whole document (see TIER-4/5, GF-1). `effectiveBalance` for trial is a _fixed_
ceiling that does not read a wallet at all — a trial-session code path that tries to read a
balance is wrong by construction.
Observability: `GET /billing/spendable` response fields `spendableNanoUsd`/`heldNanoUsd`
(FUND-14); DB `wallets`/`ledger_entries` rows for balance; Redis hold keys for `holds`.
Visibility: internal-but-observable via API/DB.

**FUND-13 — `affordable` (empty basis, `effectiveBalance`) and `admissible` (composed basis,
`spendable`) are produced by one core evaluated twice inside one call, never independently
computed by two callers.**
Citation: BILLING.md §Funding (Two funding inputs, two option sets), restated as Principle 2 at BILLING.md §Principles (One entry point, evaluated twice).
Sharp edges: any surface that computes `affordable` using a non-empty basis, or that lets a
caller supply its own "empty" basis rather than the producer substituting it internally, breaks
the guarantee that `affordable` is keystroke-stable and that the two sets "cannot disagree."
Observability: internal-only — provable only by inspecting whether two independent call sites
ever compute diverging `affordable` sets for the same payer/catalog snapshot; from outside, only
visible as a picker row that greys/ungreys inconsistently with the send gate.
Visibility: internal-only; symptom is user-visible (inconsistent greying).

**FUND-14 — Both money numbers a client needs are already served by `GET /billing/spendable`
(`spendableNanoUsd`, `heldNanoUsd`); `effectiveBalance` is derivable as their sum; no second
endpoint or field independently serves it.**
Citation: BILLING.md §Funding (Both funding numbers are derivable from what the wire already serves).
Sharp edges: a UI computing `effectiveBalance` from a different source (e.g. `GET
/billing/balance`, which is raw ledger truth per AFFP-10) would silently disagree with the picker
whenever a hold is outstanding.
Observability: API response body of `/billing/spendable` vs. `/billing/balance` — directly
comparable in an HTTP trace.
Visibility: internal-but-observable via API.

**FUND-15 — A link guest reads the same funding snapshot the admission gate uses through a
guest-reachable conversation-scoped read, not a second derivation; `/billing/spendable` itself is
billing-token-classed and refuses guests.**
Citation: BILLING.md §Funding (A link guest reads the same snapshot through a different door).
Sharp edges: a guest client that composes its own funding figure from two different responses
(its own + the conversation's) rather than consuming one served number would be exactly the kind
of second-derivation the doc forbids.
Observability: guest-accessible API response vs. the admission gate's own number for the same
turn — should agree exactly.
Visibility: internal-but-observable via API (guest-facing).

**FUND-16 — `promptChars` = systemChars+instructionChars+historyChars+inputChars; affordability
consumes only counts, never content.**
Citation: BILLING.md §The prompt basis (Affordability consumes counts, never content), BILLING.md §The prompt basis (promptChars);
enforced by the `PromptBasis` type shape (BILLING.md §What the payer's situation is (PromptBasis), see DS-3).
Sharp edges: the type carries components not the total, so a bug where `historyChars` alone
exceeds the derived total `promptChars` is unrepresentable — testable by attempting to construct
such a state.
Observability: internal-only; the components never appear in any API response (by design — see
CODE layer purity, WCL-1).
Visibility: internal-only.

**FUND-17 — `inputTokens = ceil(promptChars / charsPerToken(tier))` — always rounds up.**
Citation: BILLING.md §The prompt basis (inputTokens).
Sharp edges: any floor/round-to-nearest implementation under-counts input tokens, under-reserving
the turn.
Observability: internal-only (feeds the hold, not directly visible).
Visibility: internal-only.

**FUND-18 — `inputStorage` is counted exactly once per turn (not once per sibling in a
multi-model turn), attributed to the first successful charge.**
Citation: BILLING.md §The prompt basis (inputStorage), BILLING.md §Multi-Model Turns (inputStorage).
Sharp edges: a naive per-sibling implementation of a multi-model turn double- or N-times-charges
storage for the identical prompt.
Observability: `usage_records` rows for a multi-sibling turn — only one row should carry the
storage-fee component; a `content_items` fee total across all siblings summing to N× the correct
storage fee is the failure signature.
Visibility: internal-but-observable via DB (`usage_records`).

**FUND-19 — The client holds the entire history locally and computes `promptChars` there,
identically to the send path, so pre-send affordability preview needs no network round-trip.**
Citation: BILLING.md §The prompt basis (The client holds the entire history).
Sharp edges: any drift between the client's local character-counting logic and the server's for
the identical prompt would break Affordability Principle 5 ("identical inputs") — a client
preview that shows one ceiling and a server that computes a different one for the same text.
Observability: user-visible — the picker's displayed ceiling vs. the actual admitted ceiling for
an unchanged prompt.
Visibility: user-visible.

---

## 2. Model bounds & predicates

**MB-1 — `contextHeadroom(m) = contextLength(m) − inputTokens`.**
Citation: BILLING.md §Model bounds (contextLength(m) − inputTokens).

**MB-2 — `budgetBuys(m) = floor((funding − fixedCosts) / variableRate(m))`; `funding` is
`effectiveBalance` for the affordable set, `spendable` for the admissible set, computed once per
set.**
Citation: BILLING.md §Model bounds (floor((funding − fixedCosts) / variableRate(m))).
Sharp edges: floor (not ceil) rounding; using the wrong funding source for a given set silently
computes the other set instead.

**MB-3 — `B(m,e)` (reasoning budget) is clamped to the model's limits with a 1024-token protocol
floor.**
Citation: BILLING.md §Model bounds (B(m, e)).
Sharp edges: interaction between the 1024-token floor and a model whose native max sits below
1024 — which bound wins is the edge to pin.

**MB-4 — `ceiling(m) = min(providerCap(m), contextHeadroom(m), budgetBuys(m))`.**
Citation: BILLING.md §Model bounds (ceiling(m)).
Sharp edges: a three-way min — tests must independently vary each term to confirm it can be the
binding constraint; also the precedence rule for user-facing notices depends on which term binds
(see NR-4).

**MB-5 — `H(m,e) = ceiling(m) − B(m,e)`, the answer headroom.**
Citation: BILLING.md §Model bounds (Answer headroom).

**MB-6 — `MINIMUM_OUTPUT_TOKENS = 1000`, one constant, platform-wide.**
Citation: BILLING.md §Model bounds (MINIMUM_OUTPUT_TOKENS).

**MB-7 — The ceiling is capability ∧ affordability and nothing else — there is no
product-imposed maximum answer length; a payer who can afford a model's full output capability
receives it.**
Citation: BILLING.md §Model bounds (The ceiling is capability ∧ affordability, and nothing else).
Sharp edges: any hardcoded max-answer-length unrelated to money or model capability directly
contradicts this.
Visibility: user-visible (answer length actually delivered).

**MB-8 — Reasoning tokens are billed at output rate and drawn from the _same_ token pool as the
answer; `ceiling(m)` bounds both together, not two separate pools.**
Citation: BILLING.md §Model bounds (Reasoning tokens are output tokens).
Sharp edges: an implementation that reserves or bills reasoning tokens from a separate pool
either double-reserves or under-reserves relative to the true combined ceiling.
Visibility: internal-but-observable via `llm_completions.reasoningTokens` vs. total billed
tokens.

**PRED-1 — `feasible(m,e) = B(m,e) + MINIMUM_OUTPUT_TOKENS ≤ ceiling(m)`.**
Citation: BILLING.md §Predicates (feasible(m, e)).

**PRED-2 — `e_min(m)` = Min when the model can disable reasoning, else the model's lowest
offered level; a mandatory-reasoning model's cheapest option is never free.**
Citation: BILLING.md §Predicates (e_min(m)).
Sharp edges: code that treats `e_min` as free for every model under-reserves for
mandatory-reasoning models.

**PRED-3 — `eligible(m) = ceiling(m) ≥ B(m,e_min(m)) + MINIMUM_OUTPUT_TOKENS`, graded on the
resolved cheapest corner — never an unreachable zero.**
Citation: BILLING.md §Predicates (eligible(m)).

**PRED-4 — `outlier(m) = maxCallCost(m) > 20 × median(maxCallCost)` over the _priceable catalog
pool_, explicitly never the eligible pool.**
Citation: BILLING.md §Predicates (outlier(m)); restated with full rationale at Smart Model rule 3,
BILLING.md §Smart Model (High-cost outliers are excluded from the pool) (see SM-3).
Sharp edges: computing the median over the eligible pool instead of the priceable pool makes the
exclusion set payer-balance-dependent, breaking the doc's explicit reproducibility requirement —
this is the same rule stated twice in the doc (catalog-general and Smart-Model-specific) and both
must agree.
Visibility: internal-but-observable — the excluded-model set for a fixed catalog snapshot should
be identical regardless of which payer/balance is asking.

**COST-1 — `cost(m,tokens) = inputTokens×inputRate(m) + tokens×variableRate(m)`; a non-persisting
turn (trial) carries no storage term; a tool-carrying call's cost is its loop's (HOLD-5).**
Citation: BILLING.md §Cost (cost(m, tokens)).

**COST-2 — `maxCallCost(m) = cost(m, min(providerCap(m), contextHeadroom(m)))` — the most a call
could ever cost for this prompt; money-only, balance-independent, payer-independent.**
Citation: BILLING.md §Cost (maxCallCost(m)).
Sharp edges: this is deliberately NOT clamped by `budgetBuys` — a rich-vs-poor payer must compute
the identical `maxCallCost` for the same prompt/model (this is what makes PRED-4's outlier test
payer-invariant).

**COST-3 — `minTurnCost` (text shape) prices T = max over siblings of (B(mᵢ,e_min)+
MINIMUM_OUTPUT_TOKENS), never Σ over siblings.**
Citation: BILLING.md §Cost (The token ceiling is solved ONCE across siblings and every sibling is priced at it — the widest corner — so the token term is `maxᵢ`, never a per-sibling `Σᵢ`).
Sharp edges (the sharpest single edge in the document): the doc gives exact worked numbers
illustrating a Σ-based (per-sibling-sum) computation as _insufficient_ (27,954,400) against the
correct max-based figure as _exactly sufficient_ (54,168,800) — "leaving a sibling ineligible at
admission." A per-sibling-sum implementation of `minTurnCost` under-reserves in exactly this
numerically pinned way. One nano-USD below the correct figure fails; the correct figure is tight.
Observability: internal-only pre-send (the payer decision), but its consequence — a turn admitted
by the pre-send matrix that then fails real admission — is directly user-visible as a "permanent
refusal band" (see COST-11).
Visibility: internal-only, with a user-visible failure mode if wrong.

**COST-4 — `minTurnCost` must be the _whole_ corner (all fixed terms + the reasoning term); a
partial-term computation yields a smaller number that a real turn can clear in preview and then
fail at actual admission.**
Citation: BILLING.md §Cost (it must be the whole corner).
Sharp edges: a test asserting only that "some smaller number" clears headroom would pass a
false-positive "fundable" verdict that the real admission gate then rejects.

**COST-5 — `T × Σrates` (summed-rate approximation) is explicitly a comparison bound only, never
a figure to actually charge or hold.**
Citation: BILLING.md §Cost (`T × Σrates` is a bound, not a reserve); restated at Multi-Model Turns
rule 2, BILLING.md §Multi-Model Turns (Reserving `T × Σrates` is not permitted) (see MM-2).
Sharp edges: code that mistakenly uses `T×Σrates` as the actual hold/charge amount instead of
`Σᵢcost(mᵢ,ceiling(mᵢ))` mis-reserves (the doc says it "over-reserves besides," i.e. it is not
even a safe substitute in the conservative direction it might seem).

**COST-6 — `trialTurnCost` carries no storage term at all, unconditionally (trial never
persists), so the per-message cap buys strictly more than a storage-inclusive reading would
allow.**
Citation: BILLING.md §Cost (trialTurnCost).

**COST-7 — There is exactly one premium/trial-classification implementation in the money module;
a second copy of the percentile/recency logic anywhere is a defect, not a legitimate variant.**
Citation: BILLING.md §Cost (There is exactly one premium/trial classifier).
Sharp edges: hard to catch behaviourally unless two code paths actually disagree for some
model/moment; a regression test would need to independently compute premium classification via
two call sites (trial turn vs. paid turn) for the identical model at the identical instant and
assert they agree.
Visibility: internal-but-observable (would require reading source, not just API/DB).

**COST-8 — `classifierReserve` prices the classifier's own provider call, provider leg only — no
storage reserved or charged (the classifier's prompt/output are never persisted); the classifier
engine is the cheapest priceable model, which is sound only because Catalog Admission rules 1
and 2 (zero-price exclusion, price floor) put a floor under "cheapest."**
Citation: BILLING.md §Cost (classifierReserve); cross-referenced explicitly at BILLING.md §Catalog Admission (This section is load-bearing beyond the catalog) (see CAT-10).
Sharp edges: if catalog admission's price floor were ever bypassed, the classifier engine could
resolve to a free model and `classifierReserve` would collapse toward zero — a load-bearing
cross-section between two areas of the doc.

**COST-9 — `mediaTurnMinCost` prices Σᵢ(perUnitPrice(mᵢ)+storedBytes(mᵢ)) + inputStorage through
the deterministic per-unit path, never a token approximation; it equals what admission actually
holds "by construction, not by agreement."**
Citation: BILLING.md §Cost (mediaTurnMinCost).
Sharp edges: any code path approximating media reservation via token math violates this; more
subtly, the builder used for the pre-send bound and the admission hold must literally share
implementation, not merely happen to compute the same number today — a refactor that forks them
would still pass today's tests and then silently drift.

**COST-10 — `smartModelTurnMinCost` is undefined in two textually distinct conditions that must
be handled identically, never conflated: pool prices nothing at all, OR every candidate prices
but none leaves room for a minimum answer.**
Citation: BILLING.md §Cost (smartModelTurnMinCost).
Sharp edges: conflating these two "undefined" causes, or handling one but not the other, is the
specific edge; both must resolve to the identical downstream behaviour (turn refused pre-send,
never spend).

**COST-11 — Across all three shapes (text/media/smart), `minTurnCost` must be ≤ what admission
will actually hold for the same turn: above it, the pre-send matrix over-refuses; below it, a
payer is admitted into the matrix and then hard-fails at real admission — "the permanent-refusal
band reopens."**
Citation: BILLING.md §Cost (minTurnCost ≤ what admission will hold for the same turn).
Sharp edges: this is a monotonicity/consistency invariant between the payer-decision bound and
the actual admission hold. A regression shows as either false pre-send refusals, or (worse) sends
that clear the matrix and then fail at admission with a spend the user believed was already
cleared.
Visibility: user-visible failure mode (a send that looked fundable gets refused after commit to
send).

**COST-12 — An undefined `minTurnCost` is never a shape exemption; it means nothing in the
selection prices, and such a send is refused before any spend.**
Citation: BILLING.md §Cost (Across all three shapes).

---

## 3. Sharing one token budget across siblings

**SHARE-1 — `T` = the largest token count with `Σᵢcost(mᵢ,T) ≤ funding−fixedCosts`; each
sibling's `ceiling(mᵢ) = min(providerCap(mᵢ), contextHeadroom(mᵢ), T)`.**
Citation: BILLING.md §Sharing one budget across siblings (largest token count with Σᵢ cost(mᵢ, T) ≤ funding − fixedCosts).

**SHARE-2 — The bound is exact: `Σᵢcost(mᵢ,ceiling(mᵢ)) ≤ funding`; when a sibling's own physical
cap binds below `T`, the total hold comes out _smaller_, never padded back up to `T`.**
Citation: BILLING.md §Sharing one budget across siblings (It is exactly bounded).
Sharp edges: a tight-context sibling capping below `T` must shrink the overall hold, not be
compensated back to the shared `T` figure.

**SHARE-3 — Siblings receive _equal_ token ceilings (not money-proportional allocation) — a
deliberate fairness/comparability choice.**
Citation: BILLING.md §Sharing one budget across siblings (Equal token ceilings are the point).
Sharp edges: two siblings with very different per-token prices must receive the same
`ceilingTokens` (subject to their own physical caps), never dollar-proportional token counts.
Visibility: user-visible (per-sibling ceiling shown/used).

**SHARE-4 — No sibling's `contextHeadroom`/`providerCap` constrains another sibling's ceiling —
these are strictly per-model.**
Citation: BILLING.md §Sharing one budget across siblings (No sibling constrains another's context).
Sharp edges: pairing a small-context sibling with a large-context sibling must not shrink the
large one's ceiling.

**SHARE-5 — The single-model turn is the degenerate case of the N-sibling solve — its ceiling
formula must be literally the same code path, not an independently maintained special case.**
Citation: BILLING.md §Sharing one budget across siblings (A single-model turn is the degenerate case).
Sharp edges: consistency check — the shared-T solve with one sibling must reduce exactly to the
Model Bounds formula (MB-4); a fork here would let single-model and multi-model math silently
diverge.

---

## 4. The hold

**HOLD-1 — General hold formula: Σ over nodes of `(fixed items + ceiling×variableRate) × fan-out
width × max iterations`, + `inputStorage` once per run; a tool-carrying node's items are its
whole loop.**
Citation: BILLING.md §The hold (The general form, for any workflow).

**HOLD-2 · Chat-turn specialization: fan-out = iterations = 1; hold =
Σ pinned-sibling costs + MAX over candidates (the smart slot) + `classifierReserve` (iff a
classifier will actually run) + `inputStorage` once.**
Citation: BILLING.md §The hold (A chat turn is the specialisation where fan-out width is 1).
Sharp edges: MAX is correct for the smart slot (exactly one candidate ever answers) vs. Σ for
pinned siblings (every pinned sibling answers) — using Σ for the smart slot grossly over-reserves;
using MAX for pinned siblings under-reserves and is a direct money defect.

**HOLD-3 — When a smart slot is present, its MAX (worst-candidate) term feeds into the shared
`T`-solve, so pinned siblings' ceilings are sized against the worst candidate the classifier could
still pick — not computed independently of the smart slot.**
Citation: BILLING.md §The hold (`MAX` is correct for the smart slot because exactly one candidate answers).
Sharp edges: an implementation that solves pinned-sibling ceilings before/independently of the
smart slot's worst-case term breaks the shared-T coupling.

**HOLD-4 · The tool-call cap follows the effort rung: across all of a turn's tools, linear over
the ladder's positions from 2 at the bottom rung to 10 at the top, and 10 with no reasoning
ladder; a tool-carrying node declares calls + 1 steps.**
Citation: BILLING.md §A tool loop (`C`, `S`).

**HOLD-5 · A tool-carrying node is priced as its loop, never one call times max steps: the
prompt and the output ceiling on every step, earlier steps' output and each result re-sent, each
call's fee, and the tools' record storage, with the result and fee bounds the largest over the
node's tools.**
Citation: BILLING.md §A tool loop (A tool-carrying call's cost).

**HOLD-6 · On an Auto turn carrying a tool, each rung the classifier may pick is priced at its
own loop and ceilings; the hold is the largest of those, the decided rung runs every node at its
own, and verdicts are graded at the lowest offered rung's loop.**
Citation: BILLING.md §The hold (An Auto turn carrying a tool holds its dearest rung).

---

## 5. Core invariants (pinned by test, not prose — per the doc's own framing)

**INV-1 — `reserve ⊇ bill`: the hold ≥ Σ actual charges for every reachable outcome.** The master
invariant every other billing behaviour ultimately serves.
Citation: BILLING.md §Invariants, as equations (reserve ⊇ bill).
Visibility: internal-but-observable — hold (Redis) vs. final `usage_records` sum for the same
`runId`.

**INV-2 — Re-partition invariant: `cost(m,ceiling(m))` is identical for every presented option of
every open dimension on a tool-free turn: options may only redistribute between resource classes
(for example reasoning-vs-answer tokens), never change the total priced cost.**
Citation: BILLING.md §Invariants, as equations (re-partition).
Sharp edges: any dimension whose options carry differing total cost at the same ceiling breaks
this.

**INV-3 — Zero-sum ledger: Σ legs of a `transactionId` = 0.**
Citation: BILLING.md §Invariants, as equations (zero-sum ledger).
Visibility: internal-but-observable via `ledger_entries` (DB constraint at commit).

**INV-4 — `admissible ⊆ affordable`, per model and per option, always.**
Citation: BILLING.md §Invariants, as equations (admissible ⊆ affordable), proven at BILLING.md §Invariants, as equations (`admissible ⊆ affordable` holds because both inputs that differ between the sets push the same way) (see INV-6).

**INV-5 — `presented ⟺ feasible`, scoped to notions 3 and 4 (the classifier-facing sets) and the
option lists of notion 2 — the admissible set.**
Citation: BILLING.md §Invariants, as equations (presented ⟺ feasible), precise scope restated at BILLING.md §The four notions (Scope of `presented ⟺ feasible`) (see AFF-9).

**INV-6 — `admissible ⊆ affordable` holds because both differing inputs (spendable≤
effectiveBalance, and the real composed prompt basis ≥ the empty basis) push in the same
direction — shrinking `budgetBuys` and shrinking `contextHeadroom`/raising `fixedCosts`
respectively — so every admissible ceiling ≤ its affordable counterpart, for every model.**
Citation: BILLING.md §Invariants, as equations (`admissible ⊆ affordable` holds because both inputs that differ between the sets push the same way).
Sharp edges: this is a monotonicity proof stated in prose. A randomized test that finds ANY
model/option where the admissible ceiling exceeds the affordable ceiling for the same model has
found a real regression — this is exactly what "guarantees the send gate never permits something
the picker greyed" and is directly testable across randomized inputs.
Visibility: internal-but-observable, symptom user-visible (send gate contradicting picker).

**INV-7 — Re-partition invariant mechanics: an open dimension may only redistribute an
already-priced ceiling, never enlarge it. On a tool-free turn the ceiling never reads the chosen
option, so effort has zero marginal money cost; on a tool-carrying turn a higher rung costs more.**
Citation: BILLING.md §Invariants, as equations (The re-partition invariant is the one that makes a runtime choice safe under a hold placed before that choice is known).
Sharp edges: on a tool-free turn, choosing a lower reasoning-effort level must never change the total money
reserved/billed for the turn — only the split between reasoning and answer tokens. A test picking
the cheapest vs. most expensive effort option for the same model/prompt should see identical total
`cost`.
Visibility: internal-but-observable via `usage_records` total charge, invariant across effort
choice.

---

## 6. User tiers

**TIER-1 — Tier table.** Trial: basic models only, no persistence, message/per-message/daily
caps. Guest: payer's model access, persists via shared link, group budget only — never own funds.
Free: basic only, full persistence, welcome credit + daily allowance. Paid: all models, full
persistence, prepaid via card.
Citation: BILLING.md §User Tiers (Model Access).
Visibility: user-visible.

**TIER-2 — `getUserTier`: unauthenticated → trial (or guest via shared link); authenticated with
balance>0 → paid; balance=0 → free.**
Citation: BILLING.md §User Tiers (Tier derivation).
Sharp edges: exactly-zero balance is `free`, not `paid` — an off-by-one at `balance===0`
(inclusive vs. exclusive) is the edge; a wallet that lands at exactly $0 after a send must flip
to free on the next read.
Visibility: user-visible (which tier's model access/UI the user sees).

**TIER-3 — Premium model access is paid-only, of the _payer_ — an owner-funded guest reaches
whatever the owner reaches.**
Citation: BILLING.md §User Tiers (Premium model access is paid-only).
Visibility: user-visible.

**TIER-4 — Two distinct tiers exist on one turn: sender tier (who is sending — may be guest or
trial) vs. payer funding tier (what funds this — paid or free); guest sits only on the sender
axis, never the payer axis.**
Citation: BILLING.md §User Tiers (`guest` sits only on the first).
Sharp edges: every funding-derived property (effective balance, ratios, cushion, premium access,
modality) must use the _payer's_ tier for a guest turn; using the sender's (guest) tier for any of
these leaks or denies access incorrectly. This is the single most repeated sharp edge across the
whole document.

**TIER-5 — Only identity-derived properties use the sender's tier; wherever both appear together
the payer's tier is named `payerTier` specifically, to prevent accidental crossing.**
Citation: BILLING.md §User Tiers (Two different tiers exist on one turn, and only one word has been doing both jobs).
Sharp edges: this is a naming/type-level guard — testable structurally by checking every call
site that reads tier for a funding decision reads `payerTier`, never a bare `tier` that could be
the sender's.
Visibility: internal-only (naming convention), symptom user-visible if violated.

---

## 7. Catalog admission

**CAT-1 — Zero-priced models are excluded unconditionally, checked first, before any exemption
including the top-context exemption.**
Citation: BILLING.md §Catalog Admission (Zero-priced models are excluded unconditionally), exemption ordering reaffirmed at BILLING.md §Catalog Admission (It never bypasses rule 1) (CAT-7).

**CAT-2 — Models below `MIN_PRICE_PER_1K_TOKENS_NANO` (200,000n, i.e. $0.0002/1K combined) are
excluded, tested against the _raw pre-fee_ provider rate, not the post-fee billable rate.**
Citation: BILLING.md §Catalog Admission (Models below the price floor are excluded).
Sharp edges: a model priced just under the floor pre-fee but over it post-fee (or vice versa) is
the exact boundary to pin — the doc is explicit that the pre-fee rate is what's tested.

**CAT-3 — Models older than two years are excluded (age cutoff).**
Citation: BILLING.md §Catalog Admission (Models older than two years are excluded).

**CAT-4 — Exclusion is soft-delete via `excludedReason`/`excludedAt`, never a row delete;
exposure filters on `excludedReason IS NULL AND adminDisabledAt IS NULL` and on the sighting
window (CAT-11).**
Citation: BILLING.md §Catalog Admission (Exclusion is a soft delete, not a skip).
Sharp edges: a model that later requalifies (e.g. price clears the floor) must have
`excludedReason` cleared automatically by the next hourly refresh, with no human action; a model
an admin has manually disabled must NOT be reinstated by that same refresh.
Visibility: internal-but-observable via DB (`modelCatalog` row).

**CAT-5 — `excludedReason` is derived (recomputed every hourly refresh) and `adminDisabledAt` is
asserted by a human — kept in two separate columns specifically so refresh cannot clear an
admin's manual disable, and an admin disable cannot suppress the derived reason from being
recorded.**
Citation: BILLING.md §Catalog Admission (The two columns are separate authorities and must stay separate).
Sharp edges: exactly the failure this two-column design prevents — a refresh clearing an admin's
disable, or vice versa — is the regression to test for.
Visibility: internal-but-observable via DB.

**CAT-6 — Rows whose descriptor is unbuildable (unknown pricing unit, unclassifiable modality)
are still marked with a reason (never skipped/omitted from the table), since any exclusion reason
can newly start applying to an already-present row.**
Citation: BILLING.md §Catalog Admission (Rows are marked, not created).

**CAT-7 — `TOP_CONTEXT_PERCENTILE` (0.95, over the ZDR-filtered pool) bypasses the price floor
and age cutoff, but never the zero-price rule.**
Citation: BILLING.md §Catalog Admission (The top context percentile earns an exemption).
Sharp edges: a free model with a huge context window must still be excluded by rule 1 — the
context exemption is not a universal override.

**CAT-8 — The commercial rules (price floor, age cutoff, context exemption) apply to _text_
models only; image/video/audio bypass per-token floor logic entirely and instead have one
admission rule: a row declaring no aspect-ratio domain is unrepresentable and is excluded with an
alert.**
Citation: BILLING.md §Catalog Admission (The commercial rules apply to text models only).

**CAT-9 — Every exclusion is counted and reported per-reason in the hourly refresh summary; an
expected exclusion (a cheap model) is counted without an alert, while an exclusion forced by a
shape the system cannot represent warns.**
Citation: BILLING.md §Catalog Admission (Every exclusion is counted and reported).
Sharp edges: inverting these severities — alerting on a routine cheap-model exclusion, or staying
silent on an unrepresentable-data exclusion — is the exact defect this rule guards against. A
reason roster restated in this entry is a second source that drifts from `EXCLUDE_REASONS`; cite
the set instead.
Visibility: internal-but-observable (refresh summary / alert channel).

**CAT-10 — Catalog admission is load-bearing beyond the catalog itself: the classifier engine is
the cheapest priceable model, sound only because rules 1 (zero-price) and 2 (price floor) put a
floor under "cheapest" — without them, classifier selection could resolve to a free model and
`classifierReserve` would collapse to zero.**
Citation: BILLING.md §Catalog Admission (This section is load-bearing beyond the catalog); consumed by COST-8.
Sharp edges: testable indirectly by confirming classifier-engine selection never lands on a model
excludable by rules 1/2, across catalog states.

**CAT-11 — A model the gateway stops offering is never marked: a refresh writes only the models
its fetch returned, so a retired row keeps its descriptor, its `NULL` mark and its kill switch, and
only its `lastSeenAt` stops advancing. The catalog read hides a row unsighted past its staleness
window, silently, and keeps it, so the model returns by itself when the gateway lists it again.**
Citation: BILLING.md §Catalog Admission (A model that has vanished from OpenRouter is never marked).
Sharp edges: a listed model cannot go stale — the skip-unchanged path still stamps the sighting —
and nothing but a fresh sighting un-hides a stale one; a read of `model_catalog` that filters on
the two columns alone serves retired models indefinitely, and a guard built on such a read is
blind to retirement.
Visibility: internal-but-observable via DB (`modelCatalog.lastSeenAt`).

**CLASS-1 — Premium = combined price ≥ `PREMIUM_PRICE_PERCENTILE` (75th) OR released within
`PREMIUM_RECENCY_MS` (~6 months); Basic = everything else.**
Citation: BILLING.md §Model Classification (Premium).

**CLASS-2 — Classification is computed on the fly whenever models are processed, never stored.**
Citation: BILLING.md §Model Classification (Classification is computed when models are processed from the catalog, not stored).
Sharp edges: a stored/cached premium flag would go stale as the pool shifts or the recency window
elapses — testable by advancing time (a model aging out of the 6-month window) and confirming
classification flips with no data write.
Visibility: internal-but-observable — no DB write should accompany a classification change.

---

## 8. Affordability & reservation — the four notions

**AFF-1 — Notion 1 (Model floor): can this payer call this model at all, at cheapest
configuration, minimum answer, zero-length prompt? Uses `effectiveBalance`. Consumer: model
picker/menus. Necessary, not sufficient; prompt-independent so rows never churn while typing.**
Citation: BILLING.md §The four notions (Model floor).
Visibility: user-visible (greying).

**AFF-2 — Notion 2 (Selection verdict): given the exact selection and the actual prompt, can the
turn send right now? Uses `spendable`. Consumer: send button, queue drain, regenerate.
Whole-turn — membership is not separable, the budget is shared.**
Citation: BILLING.md §The four notions (Selection verdict).
Visibility: user-visible (send gate).

**AFF-3 — Notion 3 (Smart-slot candidate set): given pinned siblings' committed cost and the
actual prompt, which candidates may fill the smart slot and up to what ceiling each? Uses
`spendable`. Consumer: classifier's option set AND the hold. `presented ⟺ feasible` governs
this set.**
Citation: BILLING.md §The four notions (Smart-slot candidate set).

**AFF-4 — Notion 4 (Solo candidate set) = notion 3 with zero pinned siblings — the largest set,
informally "the affordable models."**
Citation: BILLING.md §The four notions (Solo candidate set).

**AFF-5 — `3 ⊆ 4 ⊆ {models passing notion 1}`, and notion 3 shrinks _monotonically_ as pinned
siblings are added — pinning an expensive sibling can empty it entirely.**
Citation: BILLING.md §The four notions (3 ⊆ 4 ⊆ {models passing 1}).
Sharp edges: adding a pinned sibling must never grow the smart-slot candidate set; a test should
assert strictly non-increasing candidate-set size as siblings are pinned one at a time.

**AFF-6 — The floor (notion 1) is hold-blind; the verdict (notions 2-4) is hold-aware — a hold is
a transient reservation, not poverty, and the two sets deliberately keep those causes apart.**
Citation: BILLING.md §The four notions (The floor is hold-blind; the verdict is hold-aware).

**AFF-7 — Three deliberate consequences of AFF-6: (a) greying reflects money only, the send gate
reflects money+holds — a payer whose funds are merely held sees a normal (ungreyed) picker but a
blocked send; a payer genuinely out of funds sees the picker grey. (b) The picker is stable
against hold churn: `effectiveBalance` moves only when money moves (settlement or payment), while
`spendable` moves on every run start and finish — rows must not flicker as the payer's own turns
come and go. (c) The classifier is presented the `admissible` set, never `affordable` — the hold
comes out of `spendable` and must cover the worst option the classifier can pick; presenting the
affordable set would let it choose an option the hold doesn't cover.**
Citation: BILLING.md §The four notions (Three consequences, all deliberate); (c) explicitly flagged by the doc itself: "This is the one place where using the
wrong set is a money defect, and it is pinned by test" (BILLING.md §The four notions (The classifier is presented the `admissible` set, never `affordable`)).
Sharp edges: (b) is directly testable — starting a run (placing a hold, reducing `spendable`)
must NOT grey/flicker any picker row, since the picker reads `effectiveBalance` not `spendable`.
(c) is the doc's own highest-confidence flag of a real money-correctness edge.
Visibility: (a)/(b) user-visible; (c) internal-only until it manifests as an overspend.

**AFF-8 — Scope of `presented ⟺ feasible`: binds notions 3 and 4 (the classifier-facing sets)
_and_ the option lists of notion 2 (i.e. the admissible set) — deliberately does NOT bind notion 1.**
Citation: BILLING.md §The four notions (Scope of `presented ⟺ feasible`).
Sharp edges: notion 1 (the picker) is explicitly exempt from this equivalence — a test asserting
"every picker row shown is feasible" would be testing something the doc does not claim; the
picker is allowed to show discrete-act-dependent state that doesn't track every keystroke or
hold.

**AFF-9 — The `affordable` set is evaluated against an _empty_ prompt basis specifically because
notion 1 must not re-grey rows as the user types (prompt-dependent) or repaint the whole catalog
as unaffordable for a hold that resolves in seconds (hold-dependent); it does react to _discrete_
acts (sibling set, pinned dimensions, modality) because those are deliberate choices, not
keystrokes.**
Citation: BILLING.md §The four notions (Scope of `presented ⟺ feasible`).

**AFF-10 — The floor is asked once per way a picker row can be activated: the producer
publishes one verdict for replacing the answer set with the row and one for joining it as a
sibling, and a surface reads the arm matching the click it implements. A candidate row's own
`availability` answers whether the classifier may bind it, not what a click does.**
Citation: BILLING.md §The four notions (The floor is asked once per way a row can be activated).
Sharp edges: reading the joining arm for a replacing click dresses every row in a pinned
sibling's refusal; reading the replacing arm for a joining click offers a row whose addition
would refuse; forecasting a click from `availability` greys every row the classifier cannot bind
in its current role. Each is one surface holding one verdict and re-deriving the other.
Visibility: user-visible (greying, per picker mode).

---

## 9. Affordability principles (1-11, doc's own numbering; "9" and "10" are described inline as

principle numbers 9 and 10 in the doc text at BILLING.md §Principles (Tier ratios, and the assumption they carry) /
BILLING.md §Principles (Reservation ⊇ bill), offset from the earlier numbered list — cited by position below)

**AFFP-1 (Principle 1 — one verdict, one producer) — client and server compute affordability
through the same shared implementation; every surface renders one produced value. Divergence-prone
inputs are served as numbers, never re-derived: `GET /billing/spendable` returns the
`FundingSnapshot` and fails closed (503) when Redis is down, matching admission (which also
refuses paid runs without Redis); the conversation-budgets endpoint serves hold-aware remaining;
holds are read via the same Lua fragment the admission script uses. Freshness rides existing WS
frames (`run-started`, `run-finished`, reconnect catch-up) plus window focus — zero
per-keystroke API calls.**
Citation: BILLING.md §Principles (One verdict, one producer).
Sharp edges: `/billing/spendable`'s 503-on-Redis-down must exactly match admission's fail-closed
behaviour — a mismatch (one degrades gracefully, the other hard-fails) breaks the explicit
"matching admission" claim; directly testable via HTTP status code with Redis down.
Visibility: internal-but-observable via API status codes.

**AFFP-2 (Principle 2 — one entry point, evaluated twice) — `getTurnOptions` is called once with
the composed basis; it internally evaluates the same pure core over (effectiveBalance, empty)→
affordable and (spendable, composed)→admissible. The empty basis is substituted internally by the
producer, never supplied by any caller — no surface can obtain a prompt-dependent affordable set
or a hold-blind send gate.**
Citation: BILLING.md §Principles (One entry point, evaluated twice) (see also FUND-13 and CODE surface entry WCL-2).
Sharp edges: whether a caller can even attempt to pass its own basis for the `affordable` half is
an API-shape question — worth checking whether `getTurnOptions`'s signature structurally forbids
it (it does per the public-surface table, WCL-2) or merely by convention.

**AFFP-3 (Principle 3 — client advisory / server authoritative) — the client computes per
keystroke from served numbers and its own character counts; the server recomputes send from its
own fresh funding numbers and its own count of what it actually received; the hold is taken
against what the classifier is presented. A client-supplied count is never the final basis for a
charge — settlement bills observed usage.**
Citation: BILLING.md §Principles (Client advisory, server authoritative).
Sharp edges: a security-relevant boundary — the server must independently recompute
`promptChars` from the received payload rather than trust a client-declared count; a manipulated
client count that biases the server's admission estimate should have no effect on the actual
charge.
Visibility: internal-but-observable — compare a manipulated request's declared basis to the
server's recomputed one; final charge should reflect the latter only.

**AFFP-4 (Principle 4 — staleness contract) — served numbers are point-in-time snapshots with
bounded accepted divergence: a hold placed by another of the payer's own tabs stays invisible
until the next fetch (bounded by the hold's TTL); admission gates on a short-TTL Redis balance
snapshot (bounded preview-vs-gate skew); two sends racing the same funds are decided solely by the
one atomic admission script. `GET /billing/balance` remains ledger truth for
payment-confirmation display only, never an affordability input.**
Citation: BILLING.md §Principles (Staleness contract).
Sharp edges: a genuine concurrency test — two simultaneous sends against funds that cover only
one must resolve to exactly one success, decided by the atomic script, never by both succeeding
or a lost-update race.
Visibility: user-visible (which of two racing sends wins) + internal (DB/Redis outcome).

**AFFP-5 (Principle 5 — identical inputs) — preview and send measure the _identical_ prompt
through the same construction code path, counted by the same function; client money math is
nano-USD bigint end-to-end — cents/dollars exist only at display formatting.**
Citation: BILLING.md §Principles (Identical inputs).
Sharp edges: directly duplicates FUND-19's edge — any drift between preview-time and send-time
character counting is the failure mode this principle exists to prevent.

**AFFP-6 (Principle 6 — minimum-viable-answer floor) — a model is callable iff
`fixedCosts + minimum-answer-at-cheapest-resolved-configuration` is affordable. Below the floor,
the model greys in the picker with a tooltip (never hidden); the server refuses. Above the floor,
low balance only shrinks the ceiling — a low-balance user is never blocked from a model they can
afford at _some_ ceiling.**
Citation: BILLING.md §Principles (The minimum-viable-answer floor is THE minimum).
Visibility: user-visible.

**AFFP-7 (Principle 7 — worst-case reservation, triply bounded) — restates MB-4:
`ceiling(m)=min(providerCap,contextHeadroom,budgetBuys)` — never reserve beyond what the model can
physically emit, what the prompt leaves free, or what the payer can pay.**
Citation: BILLING.md §Principles (Worst-case reservation, triply bounded).

**AFFP-8 (Principle 8 — cushion is spendable-side) — paid tier gets +$0.50 spendable everywhere;
free tier gets daily allowance only, no cushion. Cushion is applied once, server-side, by a single
`spendableFundsNanoUsd` seam; `/billing/spendable` returns the already-cushioned number; the
client consumes it verbatim and never re-derives it from raw balance in either direction. No
cushioned/raw variant exists, and no second code path exists for the group case — the group-owner
dimension routes through the identical seam as self.**
Citation: BILLING.md §Principles (Cushion is spendable-side).
Sharp edges: explicitly, in the doc's own words — the client re-adding cushion is a
"double-cushion bug," the client stripping it is a "false-refusal bug." Both directions are named
failure modes.
Visibility: user-visible (spendable figure shown), internal-but-observable via API.

**AFFP-9 — Cushion must reach the client, not stay admission-only, for two reasons of different
magnitude: (a) admission gates on the cushioned figure, so a client gating on the raw figure would
refuse turns the server would accept — on the group-owner dimension this bands the _full_ cushion
width (up to $0.50) of substantial harm. (b) Without cushion, a balance below the cheapest turn's
cost could never be spent to exactly zero, so the tier could never flip paid→free — this
stranded-state risk is a fraction of a cent (cheapest admissible turn: 200,000-800,000 nano-USD
against a 500,000,000 nano-USD cushion — covered 625×-2,500×), closed by cushion applying at
exactly the threshold `balance>0` where tier would otherwise strand.**
Citation: BILLING.md §Principles (Cushion is spendable-side).
Sharp edges: after a single send lands raw balance at exactly $0 or negative, tier must flip to
free on the very next read; the residual negative amount must not "stick" as a debt blocking free
eligibility (see also TIER-2, GF-2). Numerically pinned test candidate.
Visibility: user-visible (tier badge/model access flips).

**AFFP-10 — `GET /billing/balance` is raw-ledger-truth display only, never an affordability
input; cushion belongs only in the `/billing/spendable` gating path. Trial has a fixed $0.01
effective balance, quota-gated, no holds (a trial session has no funding endpoint read at all). A
guest never takes the trial ceiling — always owner-funded per Group Funding 1.**
Citation: BILLING.md §Principles (Cushion is spendable-side).
Sharp edges: a guest turn that somehow computed a trial-style fixed ceiling instead of routing
through the owner's funding would be a category error the doc explicitly rules out.

**AFFP-11 (Principle 9 — tier ratios) — input estimation: paid tier 1 token per 4 chars, all
other tiers 1 token per 2 chars. Output-storage estimation is _inverted_: paid 2 chars per token,
others 4 chars per token — so every tier over-reserves both input AND output storage. Always
round against the user (ceil).**
Citation: BILLING.md §Principles (Tier ratios, and the assumption they carry).
Sharp edges: the inversion (paid gets the _denser_ input ratio but the _sparser_ output-storage
ratio) is easy to transpose by mistake; a test should confirm both ratios independently per tier,
not assume symmetry.

**AFFP-12 — The tier ratios are an explicit, acknowledged assumption, load-bearing specifically
on the input leg: output is wire-capped (an output-token miss cannot exceed the ceiling), but
input is NOT wire-capped — if real tokenization is denser than the assumed ratio, the input charge
could in principle exceed what was reserved for it. Two things bound this risk instead of a
structural guarantee: the output ceiling dominates the hold (absorbing a small input overshoot),
and the cost circuit caps total run exposure regardless. A future ratio change is explicitly
called a change to `reserve ⊇ bill`, not a display tweak.**
Citation: BILLING.md §Principles (Tier ratios, and the assumption they carry).
Sharp edges (high value — one of the doc's most important self-flagged gaps): this is a place
where `reserve ⊇ bill` is NOT structurally guaranteed, only empirically/probabilistically bounded.
A test could attempt to construct a prompt whose real tokenization is denser than the assumed
ratio and confirm that the _cost circuit_ (not the reservation itself) is what prevents overspend
in that scenario — i.e. this is a defense-in-depth claim, testable as such.
Visibility: internal-only, with the cost-circuit trip (a single Sentry event) as the only external
signal if the bound is ever actually exercised.

**AFFP-13 (Principle 10 — reservation ⊇ bill mechanics) — every billable component is priced in
reservation through the same shared folding; estimates only ever over-reserve: cache reads are
priced at the full input rate (never a cheaper cached rate), reasoning is folded into output, and
a tool loop is priced at its full call cap.**
Citation: BILLING.md §Principles (Reservation ⊇ bill).

**AFFP-14 (Principle 11 — estimate visibility) — estimated cost drives decisions/notices
internally; it is surfaced to the user only where generation is priced per unit (media shows an
estimate before generating). Text turns display the FINAL cost only, at completion — never a
pre-send estimate.**
Citation: BILLING.md §Principles (Estimated cost drives decisions and notices).
Sharp edges/user-visible: a text-turn UI that shows a pre-send dollar estimate (as opposed to
just a ceiling/ability-to-send) would violate this; media SHOULD show a pre-send estimate, text
should NOT — the asymmetry itself is the thing to test.

---

## 10. Reservation mechanics (estimation & pricing detail)

**RESV-1 — An estimate manifests as line items in two classes: provider items (input tokens,
output tokens, media generation, classifier tokens — billable rates) and storage items (input
chars, output chars, media bytes — pass-through, never fee-bearing, dropped entirely on
non-persisting turns).**
Citation: BILLING.md §Principles (Reservation mechanics).

**RESV-2 — Per-node worst case = fixed items + ceiling×variableRate; node reservation = per-node
worst case × declared fan-out width × max iterations, a tool-carrying node's being its loop; run's hold = Σ nodes +
`inputStorage` once.**
Citation: BILLING.md §Principles (Reservation mechanics).

**RESV-3 · A tool loop is priced on each tool-carrying node (the turn's answer nodes, never the
smartModel node itself, which has no tools field), scaled by enclosing fan-out width and loop
iterations only.**
Citation: BILLING.md §Principles (Reservation mechanics).
Sharp edges: a mixed turn (pinned siblings + smart slot) must price the loop only on the
answer/pinned side, never on the smart slot.

**RESV-4 — Image reserves its deterministic per-unit price (a token bound is meaningless for
per-unit pricing) and is billed exactly as estimated, no reconcile step. Video reserves
per-second×resolution, storage via fixed byte estimates.**
Citation: BILLING.md §Principles (Reservation mechanics).
Sharp edges: image's `isEstimated=true` with "no reconcile" is a distinct billing path from
text/video (which use inline provider cost) — a test should confirm image billing never attempts
to reconcile against a later "actual" figure the way text/video's fallback path does.

**RESV-5 — Inline provider cost (`usage.cost`) is billing truth for text and video when it can
stand as the whole cost of the node's model steps: every step reported one and the figure passes the sanity bound;
otherwise settlement bills the billable catalog estimate over observed usage, flagged
`isEstimated` plus exactly one Sentry alert.**
Citation: BILLING.md §Principles (Reservation mechanics).
Sharp edges: the "implausible" sanity check's threshold is not stated numerically here — worth
checking source if a test needs to trigger it deliberately. A multi-step run where any single
step omits its cost is on the fallback path.

**RESV-6 — Charges are idempotent per `${runId}:${nodeKey}`.**
Citation: BILLING.md §Principles (Reservation mechanics).
Sharp edges: classic idempotency test — retrying/replaying the identical charge key must be a
no-op, never a double charge.
Visibility: internal-but-observable via `usage_records`/ledger (no duplicate rows for a replayed
key).

**RESV-7 — A zero-value hold is a defect, rejected at estimation.**
Citation: BILLING.md §Principles (Reservation mechanics).
Sharp edges: any turn whose computed hold is exactly 0 must be refused before admission, never
silently admitted with no reservation at all.

**RESV-8 — The DAG-derived multipliers (fan-out width, step counts, iteration counts) are passed
to the shared money layer as opaque integers computed by the engine; the money layer never
inspects nodes/edges, never reads a clock/database/random source.**
Citation: BILLING.md §Principles (Where the DAG lives).
Sharp edges: an architectural purity claim — testable as "the estimator's only inputs are
counts/rates/identifiers," cross-referenced by the "Where the Code Lives" purity claims (WCL-1).

**RESV-9 · Each successful tool call is billed at its tool's after-fee per-call rate on its node's
charge, added after the inline-or-estimate decision, so the estimate fallback never drops it.**
Citation: BILLING.md §Principles (Reservation mechanics).

**RESV-10 · A tool call that fails or that the cap refuses is not billed, and a failed node's tool
spend is absorbed, never charged.**
Citation: BILLING.md §Principles (Reservation mechanics).

**ADM-1 — Admission is the ONLY balance gate: one atomic Redis script checks concurrent-run cap
(5 per wallet), `spendable ≥ estimate`, every budget scope, then writes the hold (TTL = run
deadline + margin) — all atomically.**
Citation: BILLING.md §Principles (Admission invariants).
Sharp edges: a race between two runs against the same wallet must be serialized entirely by this
one script — no application-level locking is the mechanism.

**ADM-2 — Settlement itself is unguarded — negative balances are legal states.**
Citation: BILLING.md §Principles (Admission invariants).

**ADM-3 — Saved ⟺ billed: content and every charge commit in one settlement transaction; an
involuntary kill bills nothing; explicit user stop settles the billable partial; a settlement
refusal is the one carve-out (ADM-6).**
Citation: BILLING.md §Principles (Admission invariants).

**ADM-4 — Cost-circuit trip (observed accrual > hold×5) bills nothing — absorbed as platform
loss, exactly one Sentry event.**
Citation: BILLING.md §Principles (a cost-circuit trip (observed accrual > hold × 5) bills nothing — absorbed platform loss, one Sentry event).

**ADM-5 — Redis down ⇒ paid admission refuses; there is no degraded mode.**
Citation: BILLING.md §Principles (Admission invariants).
Sharp edges: this is stated specifically for paid admission; whether trial admission (which also
depends on Redis per Trial Usage's dual-identity quota and global spend cap) fails closed
identically, or has a different failure mode, is worth checking directly against TRIAL-6/TRIAL-7
below — both trial mechanisms are independently stated as "Redis down fails closed," so the
behaviour appears consistent across tiers, but this is stated in two separate sections rather
than once.

**ADM-6 · A settlement refusal bills every charge the run collected to the payer in the same
transaction, with no storage fee and nothing saved; a sender whose row is gone is recorded as
null.**
Citation: BILLING.md §Settlement (Refusals).

**ADM-7 · A refusal whose payer's account is gone is absorbed and captured under
`workflow_refusal_absorbed`.**
Citation: BILLING.md §Settlement (Refusals).

---

## 11. Dimension framework

**DIM-1 — Every dimension is either pinned (user fixed it) or open (contributes an option set) —
determined _only_ by whether the user fixed it.**
Citation: BILLING.md §Pinned or open (Every dimension is either pinned or open, and which one depends only on whether the user fixed it).

**DIM-2 — Dimension table: model (pinned=specific models selected, open=Smart Model slot);
effort (pinned=level chosen, open=Auto); web search (pinned=toggled, open=reserved for future);
media aspect/resolution/duration (pinned=chosen, open=reserved; duration not enumerable).**
Citation: BILLING.md §Pinned or open (media aspect / resolution / duration).

**DIM-3 — A pinned dimension contributes a fixed requirement that shrinks the budget before
anything is presented; an open dimension contributes an option set the classifier picks from, and
the hold covers the worst option in that set. Both are treated identically by the framework
(effort itself moves between both modes, proving this).**
Citation: BILLING.md §Pinned or open (A pinned dimension contributes a fixed requirement that shrinks the budget before anything is presented).

**DIM-4 — Pinning a dimension must re-grey any option set that depends on it (e.g. toggling web
search changes which models are affordable).**
Citation: BILLING.md §Pinned or open (Consequence worth stating plainly).
Sharp edges: a reactive-recompute requirement — pinning search must cause the model picker to
re-evaluate greying, not leave stale availability displayed.
Visibility: user-visible.

**DIM-5 — Resource table: `money` (nano-USD out of spendable), `completionTokens` (tokens out of
`ceiling(m)`), `none` (consumes neither — a free dimension, e.g. aspect ratio).**
Citation: BILLING.md §Cost classes and resources (completionTokens).

**DIM-6 — `moneyPerToken` is a rate, not an amount: `nanoUsdPerToken × ceiling ≠
cost(m,ceiling)` because the input leg is prompt-sized, not ceiling-sized. A consumer needing
money must price `cost(m,ceiling(m))` via the estimator (MAX over an open dimension, Σ over pinned
siblings) — treating the rate as a multiplication target is explicitly named a defect.**
Citation: BILLING.md §Cost classes and resources (A resource names a requirement's units).
Sharp edges: code multiplying a per-token rate by a ceiling to directly compute a cost figure
(bypassing the estimator) is the named defect pattern.

**DIM-7 · The model dimension's cost class is `additive`, resource `moneyPerToken`: a per-token
rate, never a hold amount.**
Citation: BILLING.md §Cost classes and resources (The model dimension's cost class is `additive`).

**DIM-8 — Cost class table: `partition` (redistributes an already-priced pool, zero marginal
money on a tool-free turn: reasoning effort); `additive` (adds a fixed requirement: media resolution); `multiplicative`
(scales another declared bound — agentic depth, media duration); `free` (no requirement in any
resource — aspect ratio).**
Citation: BILLING.md §Cost classes and resources (Redistributes an already-priced pool).

**DIM-9 — Resource disjointness is NOT a safety property — money buys tokens, so a
money-consuming dimension changes what token-consuming dimensions can afford. The feasible set is
computed _exactly_ over the active option space; any per-dimension summary shown to the
user/classifier is a compression whose losslessness is asserted by test, never by argument.**
Citation: BILLING.md §Cost classes and resources (Resource disjointness is not a safety property).
Sharp edges: the doc explicitly says this is proven "by test, never argument" — implying a real
regression here shows as a presented option that is not actually feasible in combination with
another dimension's simultaneous choice (a cross-dimension interaction bug).

**DIM-10 — `multiplicative` dimensions deliver _at the held ceiling_ — because the hold precedes
the open dimension's resolution, even choosing the cheapest multiplicative option still delivers
at the worst-case (held) ceiling, not a relaxed/re-computed one. Declared explicitly via
`deliversAtHoldCeiling` so this consequence is visible rather than silently discovered.**
Citation: BILLING.md §Cost classes and resources (`multiplicative` dimensions deliver at the held ceiling).
Sharp edges: directly testable — pick the cheap end of a multiplicative dimension and confirm the
delivered ceiling equals the worst-case reservation, not a smaller/relaxed figure.
Visibility: user-visible (the actual ceiling/answer length delivered).

**DIM-11 — `ordered` property: options monotone in requirement order ⇒ the feasible set is a
downward-closed prefix, so a single ceiling losslessly represents it; unordered dimensions must
present a list instead.**
Citation: BILLING.md §Ordering, enumerability, and what that permits (ordered).

**DIM-12 — `enumerable` property: option set finite ⇒ only enumerable dimensions may be open. A
continuous dimension (e.g. a duration slider) can be pinned but never handed to the classifier —
quantizing makes it classifiable.**
Citation: BILLING.md §Ordering, enumerability, and what that permits (enumerable).
Sharp edges: an attempt to expose a continuous/unbounded dimension as classifier-selectable (open)
should be structurally impossible, not merely discouraged.

**DIM-13 — The prefix property (DIM-11) is not an assumption: reasoning budgets are non-decreasing
along the ladder and clamping is monotone, so if a level fits, every lower level fits — no gaps.**
Citation: BILLING.md §Ordering, enumerability, and what that permits (The prefix property is not an assumption).

**DIM-14 — Two "derived, never declared" rules: (1) resolution is a closed set, never a callback
— a model not offering the requested option resolves via a declared rule
(`nearestBelow`/`lowestOfferedWhenMandatory`), never a free-form resolver. (2) A classifier is
bought iff an open dimension has ≥2 distinct _resolved_ requirements — distinctness is measured on
resolved requirement, not label, so two differently-labeled options clamping to the same budget
count as one option and buy no classifier call.**
Citation: BILLING.md §Derived, never declared (A classifier is bought iff an open dimension has ≥ 2 distinct resolved requirements).
Sharp edges (2): two differently-labeled options that resolve to the identical clamp must NOT
trigger a classifier call — e.g. if a model's ladder collapses two nominal levels to the same
budget, the dimension must be counted as having only 1 distinct choice, not 2.

---

## 12. Reasoning effort & the classifier

**RE-1 — Ids (`lite<low<medium<high<max`) and labels (Lite, Low, Mid, High, Max, + Min =
reasoning-off) are different vocabularies; `medium`/`Mid` are the same rung. Ids appear on
wire/storage, labels appear wherever a human or classifier reads an option — one mapping used by
every surface; there is no separate "None" concept distinct from Min.**
Citation: BILLING.md §Reasoning Effort & the Classifier (Vocabulary — ids and labels are different things).

**RE-2 — Ladder assignment: lite=2048, low=4096, medium=12288, high=32768, max=65536 tokens
(founder-tunable), clamped to the model's cap with a 1024-token protocol floor. Positional mapping
from native vocabulary size: 1 level→[high]; 2→[low,high]; 3→[low,medium,high];
4→[low,medium,high,max]; ≥5→strongest five. Budget-native models (no enumerated efforts) offer the
full ladder clamped to token tiers; a mandatory-reasoning model with exactly one native level
offers exactly that one rung (no choice, but priceable — `e_min` is never an unreachable zero). One
function is the sole normalization authority for the menu, server validation, and the classifier's
options alike.**
Citation: BILLING.md §Reasoning Effort & the Classifier (Ladder assignment).
Sharp edges: each of the four positional-mapping rules (2, 3, 4, ≥5 native levels) is distinct — a
model with, say, 6 native levels must map to "strongest five" (dropping the weakest), never keep
all six or evenly resample; this is a per-cardinality rule set, easy to get subtly wrong at one
cardinality while the others pass.

**RE-3 — Wire `maxTokens = B(m,e) + H(m,e)`; a level is enabled iff `feasible(m,e)` — the _same_
predicate the server admits on, so the menu never enables a level the server would refuse.
Disabled levels grey with a reason, never hidden, for every tier including trial. Every tier may
pin an explicit level (trial included); a pin no candidate can offer is refused, never silently
answered at another rung. A stored/stale preferred level that later becomes infeasible must be
shown in its _lowered_ (actually resolvable) form in the control — never silently sent at the
stale value and left to the server to refuse, and never sent-but-displayed-as-if-still-valid.**
Citation: BILLING.md §Reasoning Effort & the Classifier (Sizing).
Sharp edges: UI-vs-server consistency — the client must reflect the ACTUAL currently-resolvable
level in its control display when a previously-valid stored preference becomes infeasible.
Visibility: user-visible (control display value).

**RE-4 — Rule 4, one effort per turn: user/classifier picks a single effort; the multi-model
option set is the union of all selected models' offered levels (+Min if any model can disable).
Per-model resolution: a model lacking the chosen level falls to its nearest offered level _only
downward_; the one upward exception is a mandatory-reasoning model whose entire ladder sits above
the chosen level, which runs at its lowest offered level (downward being impossible for it). One
resolver implements this for menus, server validation, and classifier output alike.**
Citation: BILLING.md §Reasoning Effort & the Classifier (One effort per turn).

**RE-5 — "As asked" is precise: a turn's chosen level is never swapped for a different level — it
runs at the level asked for, or refuses. Per-model resolution downgrade is a _declared mapping_,
not substitution — which is why the resolved level per generation is recorded and surfaced on the
answer (RE-10); resolution the user cannot see would be substitution in everything but name.**
Citation: BILLING.md §Reasoning Effort & the Classifier (One effort per turn).
Sharp edges/user-visible: every generation's reasoning row must label its _own_ resolved level,
even in a multi-sibling turn where siblings resolve to different rungs than the label the user
picked.

**RE-6 — Rule 5, Auto: Auto is always selectable. ≥2 distinct resolved choices ⇒ one classifier
call decides; exactly 1 distinct choice ⇒ deterministic, no call, no reserve. No static
effort-preference order exists anywhere in the system — every Auto resolution with ≥2 choices is
classifier-driven; if no classifier can be built, send fails with a typed error, never a silent
static fallback. Explicit levels remain usable even when the classifier is unavailable.**
Citation: BILLING.md §Reasoning Effort & the Classifier (Auto is a classified dimension).
Sharp edges: "no static fallback order" is an explicit negative claim — a regression introducing
e.g. "default to medium if classifier fails" would silently violate this; the correct behaviour is
a typed error surfaced to the user.
Visibility: user-visible (typed error vs. silent substitution).

**RE-7 — Rule 6, one classifier call per turn: all open dimensions ride ONE call on the cheapest
priceable text model, sharing one 4,000-char-truncated context; worst-case cost ≈0.1¢ (why trial
turns fit inside the 1¢ per-message cap). The classifier is presented EXACTLY the options the turn
funds, in the user's own labels (incl. Min/Lite/Max), one labelled line per dimension (so adding a
dimension can't break the parser). The classifier carries no tools; the Smart slot's own
`smartModel` node has no tools field either — a slot-only turn carries no search tool anywhere; a
mixed turn carries search only on pinned siblings. Classifier tokens are never streamed to the
client.**
Citation: BILLING.md §Reasoning Effort & the Classifier (One classifier call per turn).
Sharp edges: a slot-only (Smart-Model-only, no pinned siblings) turn with web search enabled must
still carry NO search tool on any node — a naive implementation might attach search to the
classifier or the smartModel node.

**RE-12 · Rule 5 on a tool-carrying turn: the effort call is bought on funded rungs while the
reserve is deducted whenever two or more rungs are offered; one funded rung closes the axis; none
refuses a non-slot Auto turn with 402 `INSUFFICIENT_ADMISSION` and closes a slot turn's axis at the
lowest offered rung.**
Citation: BILLING.md §Reasoning Effort & the Classifier (On a tool-carrying turn a rung can be offered yet unfunded).

**RE-8 — Rule 7, reserve⟺classify: the classifier reserve is held whenever the classifier MAY
run, determined by candidate-_pool size_ (shared predicate between estimator and executor) — never
by the presented-set size, because the presented-set predicate has no fixed point (the reserve
itself shrinks what's presentable, so keying on presented-set would re-buy the reserve
circularly). The executor may skip the actual call when the presented set collapses to one option;
the unspent reserve is simply never charged, keeping `reserve⊇bill` intact. Reserve covers the
provider call only (no storage — classifier output is never persisted).**
Citation: BILLING.md §Reasoning Effort & the Classifier (Reserve ⟺ classify).
Sharp edges: a genuinely subtle circularity-avoidance rule — the reserve _decision_ must be based
on pool size, never on the (derived) presented-set size, or the system creates a self-referential
fixed-point bug. Directly testable: construct a scenario where pool size ≥2 but the presented set
collapses to 1, and confirm the reserve is still held (even though the call is skipped).

**RE-9 — Rule 8, classifier cannot fail into an infeasible state: options are feasible by
construction (no repair search). An answer naming something outside the presented set resolves to
the declared cheapest presented option; an answer exceeding the printed ceiling clamps to it; the
effort then clamps down to a rung the bound candidate answers at, which every node runs. This
cannot fail because no infeasible configuration was ever presented in the first place.**
Citation: BILLING.md §Reasoning Effort & the Classifier (The classifier cannot fail into an infeasible state).

**RE-10 — Rule 9, resolved level persisted + displayed: each generation records the effort it
actually ran at, alongside reasoning tokens consumed — the pair exposes a model ignoring its
budget. The level is the label of the answer's reasoning row. If a model cannot reason, or was
called with no reasoning wire, no level is recorded; explicit Min records `off`, because "user
chose no reasoning" and "reasoning does not apply" are different facts.**
Citation: BILLING.md §Reasoning Effort & the Classifier (The resolved level is persisted and displayed).
Sharp edges: the record holds three distinct states — (a) no level (model can't reason / not
requested and not applicable), (b) `off` (Min, explicitly chosen), (c) a rung (Lite..Max) — and
`off` must never collapse into (a) on its way to storage or the share read. The display carries
less: a turn that produced no trace has no reasoning row, so neither (a) nor (b) shows a rung and
a Min turn shows nothing; the row's label distinguishes only (c) from its absence.
Visibility: user-visible (the reasoning row's label); internal-but-observable via `llm_completions` (resolved
effort + reasoningTokens columns).

**RE-11 — Rule 10, ruled edge cases: (a) chosen effort below the model's entire ladder +
reasoning disableable → Min. (b) below ladder + reasoning mandatory → model's lowest offered rung.
(c) exactly one distinct resolved choice → deterministic pick, no classifier call, no reserve,
Auto still selectable. (d) no priceable classifier engine → typed error; explicit levels remain
usable. (e) a persisted Auto preference is never clamped away — Auto is valid for every model. (f)
a Smart-Model-resolved model lacking the turn's effort → same downgrade rule as (a)/(b).**
Citation: BILLING.md §Reasoning Effort & the Classifier (Ruled edge cases).

**RED-1 — The classifier is an ordinary model call, not a special node type; its answer joins the
turn's prompt through a registered reducer that parses/clamps/applies the declared fallback in one
pure function, producing a typed decision envelope. Every consumer (each sibling, the Smart slot)
reads the envelope through an ordinary single input port and applies the decision via one shared
wire-derivation function.**
Citation: BILLING.md §How the decision reaches the answer (The classifier is an ordinary model call).

**RED-2 — The definition priced is the definition that executes — nothing is recompiled after the
classifier answers; the envelope is data flowing through a static graph.**
Citation: BILLING.md §How the decision reaches the answer (The definition that is priced is the definition that executes).
Sharp edges: this is the estimate⟺executed-identity property; a regression (definition mutated
post-classification) would break admission's guarantee that what was priced is what actually runs.

**RED-3 — The classifier call is optional; its absence is an absent value the reducer handles by
declaration — the failure path is typed, not a caught exception around a missing classifier
answer.**
Citation: BILLING.md §How the decision reaches the answer (The failure path is typed, not caught).

**RED-4 — Streaming is withheld by graph structure, not a flag: a node whose output is consumed
rather than displayed emits nothing because that's already computable from the compiled
definition — a declared per-node stream flag would be a second, contradictable authority for a
fact the graph already fixes.**
Citation: BILLING.md §How the decision reaches the answer (Streaming is withheld by the graph, not by a flag).
Sharp edges: testable indirectly — classifier tokens should never appear on the client stream
under any configuration, because there is structurally no flag that could turn them on.

**RED-5 — The classifier's charge has no content of its own; it is anchored onto the turn's first
_persisted_ content. A turn-level charge with no anchor would be silently absorbed by the platform
(making `reserve` a lie relative to what actually gets billed).**
Citation: BILLING.md §How the decision reaches the answer (The classifier's charge has no content of its own).

**RED-6 — The run-level prompt-storage fee is NOT a precedent for a hypothetical future
turn-level classifier charge node: the storage fee is not anchored at all (it's folded onto charge
index 0, riding whichever charge succeeded first). A genuinely turn-level charge would break two
things simultaneously if it reused the storage-fee's un-anchored pattern: (a) the storage fee
(currently piggybacking on index 0) would attach to a charge with no persisted anchor and silently
vanish; (b) an all-siblings-failed turn would stop having zero charges, so the "no charges ⇒
everything failed" detector would stop firing — settlement could commit having persisted nothing
and billed nothing while reporting success.**
Citation: BILLING.md §How the decision reaches the answer (The run-level prompt storage fee follows the same rule, reached the same way).
Sharp edges: this is an explicit forward-looking warning about a feature interaction that does not
exist yet. The only currently-testable form of it is the invariant it protects: an all-siblings-
failed turn must currently report failure and bill/persist exactly nothing (see MM-4) — any future
turn-level charge implementation must be checked against these same two named regressions.
Visibility: internal-only (settlement-transaction-scoped), with (b)'s symptom (false success
report) being user-visible if it ever regresses.

---

## 13. Smart Model

**SM-1 — Rule 1, pool pricing: candidates are ordered by a total order on turn cost with an
identifier tiebreak, so pool/classifier option order is reproducible from catalog+prompt size
alone, never DB row order. The cheapest priceable model is the classifier engine; the fixed
reserve = `classifierReserve` + `inputStorage`.**
Citation: BILLING.md §Smart Model (Pool pricing).
Sharp edges: reproducibility from catalog+prompt alone means two runs with an identical catalog
snapshot and prompt must produce byte-identical candidate ordering, independent of DB read
order/timing.

**SM-2 — Rule 2: each candidate's ceiling is solved against the same per-model math as a direct
pick, from the budget remaining after the fixed reserve AND any pinned siblings' committed cost;
candidates survive iff `eligible(m)`.**
Citation: BILLING.md §Smart Model (Per-candidate ceilings).

**SM-3 — Rule 3, outlier exclusion: `outlier(m)` removes a candidate from the
classifier-_selectable_ set only — never from the product; explicit selection of that model
remains fully available. Structural justification: the hold is MAX over the pool, so one extreme
candidate sets the hold for EVERY turn the pool appears in ("it taxes the other candidates").
Median is taken over the _priceable catalog pool_ (not the eligible pool) specifically to keep the
outlier test payer-balance-independent — median over the eligible pool would make the exclusion
set depend on the payer's balance, breaking catalog reproducibility. The test is a ratio-to-median
(20×), not a quota, so it fires only on genuine tails. It measures `maxCallCost` specifically
(not e.g. average cost) since that's the quantity the hold maximizes — catching both
expensive-per-token AND enormous-capacity models by the same mechanism.**
Citation: BILLING.md §Smart Model (High-cost outliers are excluded from the pool) (restates PRED-4).
Sharp edges: two payers of very different balance, presented the same catalog/prompt at the same
moment, must see the identical outlier-excluded set — payer-invariance is directly testable.

**SM-4 — Rule 4: the hold is MAX, never Σ, over surviving candidates — exactly one candidate
answers, so `hold ≤ spendable` by construction.**
Citation: BILLING.md §Smart Model (The hold is MAX, never Σ).

**SM-5 — Rule 5, biconditional threshold: a balance-independent minimum
(`classifierReserve` + cheapest-candidate floor) below which admission returns EMPTY — one shared
function so client refusal ⇔ server refusal exactly, pinned by what the doc calls a "balance-sweep
parity test."**
Citation: BILLING.md §Smart Model (The biconditional threshold).
Sharp edges: names an existing test _type_ (balance-sweep parity) — client-side refusal
prediction and server-side actual refusal must agree across a swept range of balances, not merely
at one sampled point.

**SM-6 — Rule 6: the picker entry greys when the candidate set WOULD BE empty, so a send whose
smart slot has no candidate is not constructible client-side; if one arrives anyway (race/stale
client), the server answers with a typed refusal before any hold or provider call.**
Citation: BILLING.md §Smart Model (The picker entry greys when the candidate set would be empty).

**SM-7 — Rule 7: Trial Smart Model substitutes the fixed per-message ceiling for a wallet and
runs the identical math, classifier included.**
Citation: BILLING.md §Smart Model (Trial Smart Model substitutes the fixed per-message ceiling for a wallet and runs the same math).

**SM-8 — Rule 8, equivalence: Smart Model composes as a multi-model sibling; its resolved model
is sized EXACTLY as a direct pick minus the classifier cost from the available budget — pinned by
what the doc calls an "invariant test."**
Citation: BILLING.md §Smart Model (Equivalence).
Sharp edges: a strong numeric equivalence, directly testable — compare a direct-pick turn's
ceiling against a Smart-Model turn (resolving to the same model) minus `classifierReserve`; they
should match exactly.

**SM-9 — Rule 9a: two Smart slots are unrepresentable — the turn-source list admits at most one
`smart` source; the `Selection` type carries a boolean `smartSlot` rather than a count, so a
second slot has literally nowhere to be represented (type-level, not a runtime check).**
Citation: BILLING.md §Smart Model (Three combinations are unrepresentable, each closed by a shape rather than a guard).

**SM-10 — Rule 9b: per-sibling effort is unrepresentable — the turn body carries one
`reasoningEffort` selection for the whole turn; siblings differ only through shared downward
resolution (RE-4).**
Citation: BILLING.md §Smart Model (Three combinations are unrepresentable, each closed by a shape rather than a guard).

**SM-11 — Rule 9c: Smart+media is unrepresentable — refused in the body shape both paid routes
(send and regenerate) parse, because the slot names no model and no media-candidate derivation
would give it one; a media body carrying a smart slot would silently generate one fewer answer
than requested if not rejected.**
Citation: BILLING.md §Smart Model (Three combinations are unrepresentable, each closed by a shape rather than a guard).
Sharp edges: a media-generation request including a smart slot must be REJECTED with a typed
error, never silently dropped to N-1 answers.
Visibility: user-visible (typed error vs. a silently short-changed result).

---

## 14. Multi-model turns

**MM-1 — At most 5 answer sources (`MAX_SELECTED_MODELS`); N direct picks sharing one prompt, N
sibling calls each priced/reserved/billed/persisted per its own model under one `runId`.
`inputStorage` counts ONCE, attributed to the first successful charge. Smart Model is composable
as one sibling among regular models — the slot occupies one of the five sources.**
Citation: BILLING.md §Multi-Model Turns (A multi-model turn (≤ 5 answer SOURCES, `MAX_SELECTED_MODELS`) is N direct picks sharing one prompt).

**MM-2 — One formula, one distinction: affordability and reservation use the same authoritative
per-model math summed across siblings, same implementation client+server. The shared `T` is a
solve variable, never the charge basis — the charged/priced basis is always
`Σᵢcost(mᵢ,ceiling(mᵢ))` with each ceiling clamped by its own physical bounds. Reserving
`T×Σrates` directly is explicitly forbidden (restates COST-5), and it over-reserves besides.**
Citation: BILLING.md §Multi-Model Turns (One formula, and one distinction inside it).

**MM-3 — Per-model ceilings: each sibling's wire cap is its own `B(m,e)+H(m,e)` against its own
context/output bounds; a tight-context sibling must not constrain a large-context sibling's
ceiling.**
Citation: BILLING.md §Multi-Model Turns (Per-model ceilings).

**MM-4 — Partial success bills the successful subset; all-siblings-fail bills nothing and
persists nothing; explicit user stop settles the partial.**
Citation: BILLING.md §Multi-Model Turns (Partial success bills the successful subset).
Sharp edges: "all-siblings-fail" must be EXACTLY zero charges AND zero persisted content — the
detector referenced at RED-6 depends on this being exactly zero, not merely small.

**MM-5 — Group/member/conversation budget scopes gate a single SUMMED ceiling atomically at
admission, not per-sibling gating.**
Citation: BILLING.md §Multi-Model Turns (Group/member/conversation scopes gate the single summed ceiling atomically at admission).
Sharp edges: a scenario where the group budget covers 2 of 3 siblings' individual costs but not
their sum must refuse the whole turn atomically, never admit a subset of siblings.

**MM-6 — All ≤5 siblings execute concurrently under the platform's 6-connection cap; each
successful sibling persists as its own assistant message under one parent, and the LAST one to
_complete_ (not send order) becomes the fork tip.**
Citation: BILLING.md §Multi-Model Turns (All ≤ 5 siblings execute concurrently under the platform's 6-connection level cap).
Sharp edges: with concurrent siblings, completion order is not send order — the fork tip must
track actual completion order, a race-order-dependent behaviour that needs controlled completion
timing to test deterministically.
Visibility: user-visible (which sibling's response becomes the conversation's active fork tip).

---

## 15. Data structures / type-level invariants

**DS-1 — `ModelId` is a branded string type, load-bearing not stylistic — same class as other
prose-guarded invariants in this document.**
Citation: BILLING.md §Data Structures (Identifiers are branded, not bare strings).

**DS-2 — `FundingSnapshot` carries `payerTier` (never the sender's tier — named explicitly to
prevent conflation, see TIER-5) and `payer: 'self'|'owner'` (structural, not funding-derived —
whether the sender is the conversation owner; zero spendable is explicitly NOT a third payer
kind, which is why the union stays closed at two values).**
Citation: BILLING.md §What the payer's situation is (FundingSnapshot).
Sharp edges: a payer with $0 spendable must still be represented as either `'self'` or `'owner'`,
never a distinct/undefined third state — testable by constructing the zero-spendable case and
confirming the discriminant is still one of the two legal values.

**DS-3 — `PromptBasis` carries only components (systemChars/instructionChars/historyChars/
inputChars/attachmentBytes), never a total — `promptChars` is always derived, so "history count
larger than the whole prompt" is unrepresentable by the type (restates FUND-16).**
Citation: BILLING.md §What the payer's situation is (FundingSnapshot).

**DS-4 — `Selection` requires at least one answer source (`NonEmpty<ModelId>` or
`smartSlot:true`) — an empty turn is unrepresentable by the type.**
Citation: BILLING.md §What the user has fixed (Selection).

**DS-5 — `TurnOptions` pairs `affordable`+`admissible`+`holdNanoUsd`; `hold` is undefined unless
`admissible.sendable` — an "affordable-side hold" has no meaning and is not representable.**
Citation: BILLING.md §What the one producer returns (TurnOptions).

**DS-6 — `OptionSet` is a discriminated union: `sendable:false` carries a `refusal`
(`RefusalCode`) + `all` + `turnDimensions`; `sendable:true` carries a `NonEmpty`
`runnable` + `all` + `turnDimensions`. Both arms carry `all` and `turnDimensions` — an
unsendable set must STILL render every row greyed with a reason, because greying what the
payer cannot afford is the point (hiding it is not).**
Citation: BILLING.md §What the one producer returns (TurnOptions).
Sharp edges/user-visible: even a fully-blocked send state (`sendable:false`) must show every model
row, greyed with a reason — a UI that hides the model list entirely when nothing is sendable
violates this.

**DS-7 — `ceilingTokens` on a row for turn-unresolved slots is the BEST CASE (cheapest admissible
resolution of every unresolved slot); the hold, by contrast, is priced on the WORST arrangement.
This asymmetry is deliberate to keep both figures monotone — the doc notes the conservative
"worst presented ceiling" alternative is provably NOT monotone (a richer payer could see a
_smaller_ ceiling due to remainder effects), which would break `admissible ⊆ affordable`.**
Citation: BILLING.md §What the one producer returns (ceilingTokens).
Sharp edges: a genuinely non-obvious math property — a payer-richness-vs-displayed-ceiling
monotonicity test is the direct check.

**DS-8 — `Availability` always carries a reason when false — a surface can never grey silently
(the type shape enforces `{available:false, reason: RefusalCode}`).**
Citation: BILLING.md §What the one producer returns (Availability always carries its reason, so a surface cannot grey silently).

**DS-9 — `ModelEntry` has two kinds with DIFFERENT shapes: `candidate` rows carry `dimensions`
(decision-bearing, rungs the effort control may read); `pinned` rows have NO `dimensions` field at
all — an own-fit diagnosis only ("is this sibling blocking the turn"), not an arrangement the
classifier can pick. Consuming a pinned row's diagnosis as a decision is a COMPILE ERROR, not just
a documented mistake, because the field doesn't exist. Code must narrow on `kind`, never re-derive
kind from `Selection`.**
Citation: BILLING.md §What the one producer returns (TurnOptions).

**DS-10 — `DimensionAvailability.options` is `NonEmpty`, and options are NEVER filtered — an
unavailable option is present in the list and marked unavailable, never absent.**
Citation: BILLING.md §What the one producer returns (An unavailable option is present and marked, never absent).

**DS-11 — The pair (affordable, admissible) derives the refusal _reason_ structurally: a
selection outside `affordable` is a money problem; a selection inside `affordable` but outside
`admissible` is a hold problem. The cause is not a flag anyone sets — it's purely which set the
selection fell out of — so greying and its explanation cannot drift apart.**
Citation: BILLING.md §What the one producer returns (The pair derives the reason).

**DS-12 — `runnable` is non-empty whenever `sendable:true` (the empty case lives structurally in
the other union arm, DS-6); options are marked, never filtered — every unavailable option carries
a typed reason.**
Citation: BILLING.md §What the one producer returns (Three deliberate properties).

**DS-13 — `DimensionSpec` fields are all declarative (id, param, resource, costClass, ordered,
enumerable, support, requirement, wire, resolution, promptDescription, deliversAtHoldCeiling) —
`resolution` is a closed enum (`'nearestBelow'|'lowestOfferedWhenMandatory'`), never a callback.**
Citation: BILLING.md §What a dimension declares (A closed choice, never a callback).

**DS-14 — `PriceableModel` is a narrow projection (modelId, inputRateNanoUsd, outputRateNanoUsd,
contextLength, providerCap, reasoning, releasedAtMs) — the money layer never sees the full catalog
row, so a new catalog field or new modality cannot reshape money-layer inputs; testable against
hand-built fixtures with no catalog knowledge at all.**
Citation: BILLING.md §What a dimension declares (`PriceableModel` is load-bearing).

---

## 16. Turn stories (worked scenario-level behaviours)

**STORY-1 — (Story 1: 2 pinned + Smart slot, pinned High effort) The effort dimension collapses
to a single option and DEACTIVATES entirely — no prompt section, no answer line, doesn't count
toward "an open dimension exists" — because it's pinned.**
Citation: BILLING.md §Story 1 — Smart Model on a multi-model turn, effort pinned (While typing).

**STORY-2 — Per-candidate feasibility for pinned-High: a model lacking High falls to its nearest
lower rung; a mandatory-reasoning model whose ladder sits entirely above High runs at its lowest
rung; a candidate survives iff BOTH resources fit — money for all three siblings +
`classifierReserve`, AND `B+MINIMUM_OUTPUT_TOKENS` inside every sibling's ceiling.**
Citation: BILLING.md §Story 1 — Smart Model on a multi-model turn, effort pinned (Per-candidate feasibility).

**STORY-3 — Pinned siblings are a HARD GATE, not chooseable: if EITHER pinned sibling cannot fit
High's budget + minimum answer, High is unavailable for the WHOLE turn (not just that sibling).
An explicit pick refuses rather than silently substitutes — the user sees High greyed with reason,
and a "send anyway" is a typed refusal at admission before any provider spend.**
Citation: BILLING.md §Story 1 — Smart Model on a multi-model turn, effort pinned (The pinned siblings are a hard gate).
Sharp edges: asymmetric with candidate (smart-slot) handling — pinned-sibling infeasibility blocks
the WHOLE turn's effort option, unlike candidates which simply don't survive individually (SM-2).

**STORY-4 — Candidate presentation with pinned effort: no effort labels shown (effort is pinned);
every affordable candidate is shown minus high-cost outliers (excluded because their mere presence
would shrink every other candidate's ceiling, per SM-3).**
Citation: BILLING.md §Story 1 — Smart Model on a multi-model turn, effort pinned (Presentation).

**STORY-5 — The hold for this scenario: one shared `T` solved so the summed cost of all 3
siblings (2 pinned + worst surviving candidate) fits funding after fixed costs; each sibling's
ceiling = `min(own providerCap, own contextHeadroom, T)`; hold = `classifierReserve` + each
sibling's cost at its own ceiling + `inputStorage` once, placed BEFORE the graph walks.**
Citation: BILLING.md §Story 1 — Smart Model on a multi-model turn, effort pinned (The hold).

**STORY-6 — Execution order: run claims key → hold lands → THEN the classifier call runs against
the closed candidate list; classifier tokens withheld from client stream; an unparseable answer →
declared cheapest presented candidate; the Smart Model slot consumes the envelope instead of
classifying and binds its model; all 3 siblings stream in parallel, each with its own `B+H`.**
Citation: BILLING.md §Story 1 — Smart Model on a multi-model turn, effort pinned (Execution).

**STORY-7 — Settlement for the scenario: one transaction, 3 generations + 3 charges + the
classifier's charge anchored onto the FIRST persisted sibling; each generation records the effort
it resolved to + reasoning tokens consumed; each answer's reasoning row labels that level — a
sibling that fell to a lower rung says so rather than appearing to have run at High.**
Citation: BILLING.md §Story 1 — Smart Model on a multi-model turn, effort pinned (Settlement).
Sharp edges/user-visible: a sibling that downgraded from the requested High must show its actual
resolved level on its reasoning row, never inherit the turn-requested label.

**STORY-8 — (Story 2: same shape, Auto effort) The ladder is pruned against pinned siblings
FIRST — any effort level where a pinned sibling can't fit `B+MINIMUM_OUTPUT_TOKENS` is gone
TURN-WIDE regardless of the smart slot (pinned models cap the whole turn).**
Citation: BILLING.md §Story 2 — the same turn on Auto effort (Prune the ladder against the pinned siblings first).

**STORY-9 — Each candidate's effort ceiling (highest feasible level after per-model resolution,
capped by the tightest pinned sibling) is computed; candidates whose entire ladder has NO feasible
level drop out entirely.**
Citation: BILLING.md §Story 2 — the same turn on Auto effort (Compute each candidate's effort ceiling).

**STORY-10 — Presentation is a list PLUS a per-candidate ceiling, not a full cross-product
rectangle — presenting the rectangle (efforts every candidate supports) would hide a large
fraction of what's actually affordable; the annotated form is exact, at a prompt cost that grows
with candidate count, not the dimension product.**
Citation: BILLING.md §Story 2 — the same turn on Auto effort (Presentation is a list plus a ceiling, not a rectangle).

**STORY-11 — Because the ordered dimension's feasible set is a downward-closed prefix, a ceiling
("up to High") is a lossless representation — every level at/below the printed one is feasible, no
gaps (restates DIM-13 for this scenario).**
Citation: BILLING.md §Story 2 — the same turn on Auto effort (Because an ordered dimension's feasible set is a downward-closed prefix).

**STORY-12 — The hold has the same shape as Story 1; effort is `partition`-class with zero
marginal money cost with search off; with search on each funded rung is solved at its own loop and
the hold is the largest.**
Citation: BILLING.md §Story 2 — the same turn on Auto effort (The hold).

**STORY-13 — One classifier call, one labelled line per dimension; labels that clamp to the same
budget count as ONE option — a turn whose "choices" are indistinguishable buys no classifier
call (restates DIM-14(2)).**
Citation: BILLING.md §Story 2 — the same turn on Auto effort (One classifier call, one labelled line per dimension).

**STORY-14 — No repair by construction: both returned values are feasible; an effort above a
printed ceiling clamps down to a rung the bound candidate's cap executes (cannot fail: infeasible
candidates already excluded), turn-wide with search on; a model outside the list binds the cheapest
candidate.**
Citation: BILLING.md §Story 2 — the same turn on Auto effort (Repair is bounded, not absent).

**STORY-15 — Apply/stream/disclose: the chosen effort is the turn's single effort resolved per
model — each sibling gets its own budget/headroom; 3 streams, one settlement, 3 generations + the
anchored classifier charge. Each generation's reasoning-row label matters MORE here than Story 1
because the user never named a level at all — that label is the ONLY place the classifier's
choice becomes visible.**
Citation: BILLING.md §Story 2 — the same turn on Auto effort (Apply, stream, and disclose).
Visibility: user-visible (the reasoning row's label is explicitly called the sole visibility
surface for an Auto decision).

**STORY-16 — Menu honesty (rule 8): an effort is enabled iff AT LEAST ONE candidate can honor it,
and pinning that effort culls the candidate set to those that can — enabling only what EVERY
candidate honors (intersection) would silently reintroduce coverage loss.**
Citation: BILLING.md §Story 2 — the same turn on Auto effort (The menu stays honest).
Sharp edges: the "union not intersection" rule for the multi-model effort menu — an implementation
showing only efforts ALL candidates support instead of the union would silently hide affordable
options from the user.
Visibility: user-visible (which effort levels appear enabled in a multi-model turn's menu).

---

## 17. Funding decision matrix

**FDM-1 — 6-priority matrix, evaluated in order: (1) Group conversation headroom (min of member
allowance, conversation allowance, owner wallet's spendable=balance+cushion clamped at zero) AND
the turn's `minTurnCost` fits within that headroom → owner pays, premium allowed; insufficient →
signed-in members fall through to personal billing, guests refused. (2) Premium model + user
without premium access → denied. (3) Paid user with sufficient spendable (cushion applies) →
user's purchased balance; insufficient → denied. (4) Free user + basic model + sufficient daily
allowance (regenerate lifts the basic-model term) → free daily allowance; insufficient → denied.
(5) Link guest with no group budget → denied (guests never pay from own funds). (6) Trial,
estimated cost within the per-message cap → absorbed (no charge); over cap → denied.**
Citation: BILLING.md §Funding Decision Matrix (Conversation owner pays).

**FDM-2 — Priority 1 compares `minTurnCost` against headroom, NOT merely headroom against zero —
a positive remaining balance that cannot cover THIS turn is not fundable and must present as
unfundable BEFORE the user commits a prompt. It is `minTurnCost`, never a full estimate — enforced
by TYPE: `FundingInputs` carries `minTurnCostNanoUsd` and has NO estimate field at all, so a full
estimate is unrepresentable at the payer decision, not merely discouraged by convention.**
Citation: BILLING.md §Funding Decision Matrix (Priority 1 compares `minTurnCost` against headroom).
Sharp edges: this is compiler-enforced per the doc's own claim — a regression here would require a
TYPE change (adding an estimate field to `FundingInputs`), which an ordinary behavioural test
would not catch but a type-level/structural test could.
Visibility: internal-only (type-level), symptom user-visible (unfundable groups shown before
prompt entry).

**FDM-3 — Regenerate runs the SAME matrix minus priority 2 — a regenerate is a paid action gated
by affordability in full; premium entitlement ALONE does not gate it. ANY model may be
regenerated if affordable, INCLUDING funding a premium model from the free daily allowance
(priority 4's basic-model term is the SAME predicate as priority 2, so lifting entitlement on
regenerate lifts it there too). This is ruled deliberately: the free allowance is a real budget
and a regenerate it covers is affordable — reach stays bounded by the allowance itself (one day's
remaining allowance must cover the priced ceiling), and it reaches premium-by-recency models more
often than premium-by-price ones. A model withdrawn from the catalog is still refused (availability
≠ entitlement).**
Citation: BILLING.md §Funding Decision Matrix (Regenerating an answer runs this same matrix minus priority 2).
Sharp edges (high-value, non-obvious, explicitly "ruled deliberately not inherited" from send):
regenerating a PREMIUM model on a FREE-tier account must succeed if the daily allowance covers its
ceiling — a naive implementation ("premium always requires paid tier") gets this wrong. Directly
testable and user-visible.

---

## 18. Group funding

**GF-1 — Owner-funded means owner-priced: an owner-funded turn is estimated, reserved, and
billed exactly as if the owner sent it — the payer's tier drives ratios/premium/modality on
client and server alike, and the served spendable number is the PAYER's, not the sender's. The
sender's own tier applies only when the sender pays.**
Citation: BILLING.md §Group Funding (Owner-funded means owner-priced).

**GF-2 — The cushion exception follows BALANCE, not tier: `getCushionNano` is non-zero only when
the payer's purchased balance is above zero, so a wallet spent to exactly zero carries NO cushion
even though its tier was `paid` a moment earlier. Keyed on balance specifically so "spent to zero →
no cushion" is a property of the one `spendableFundsNanoUsd` function, not a convention every call
site must remember; applies on the served figure for self AND group-owner dimensions alike.**
Citation: BILLING.md §Group Funding (The cushion is the exception, and it follows the BALANCE rather than the tier) (cross-referenced to AFFP-8/AFFP-9).
Sharp edges: a wallet balance transitioning from positive to exactly zero within a turn (e.g. as
the last credits are spent) must immediately lose cushion on the NEXT read — testable at the
`balance=0` boundary exactly.

**GF-3 — One fall-through decision: headroom covers the estimate → owner pays; it doesn't →
signed-in members fall through to personal funds; guests are ALWAYS refused (no wallet, ever — a
typed error code with shared copy).**
Citation: BILLING.md §Group Funding (One fall-through decision).

**GF-4 — Sender and payer are first-class on every billed row — `usage_records` records BOTH,
independently queryable.**
Citation: BILLING.md §Group Funding (Sender and payer are first-class on every billed row).

**GF-5 — Membership lifecycle owns budget rows: removing a member removes its budget row; owner
deletion cascades conversations AND budgets.**
Citation: BILLING.md §Group Funding (Membership lifecycle owns budget rows).

**GF-6 — Owner state (tier, balance) is read FRESH per turn, never cached across turns; negative
owner balance = zero headroom.**
Citation: BILLING.md §Group Funding (Owner state (tier, balance) is read fresh per turn).

**GF-7 — A link's allowance is PER-LINK, not per-guest — this is what makes a bearer credential
safe. The budget row is keyed to the link's member row, created when the link is minted; an
ABSENT row means zero (an unfunded link spends nothing; a funded one is capped no matter how many
people hold the URL — everyone sharing the link races for the SAME cumulative allowance through
the same atomic check).**
Citation: BILLING.md §Group Funding (A link's allowance is per-link, not per-guest, and that is what makes a bearer credential safe).

**GF-8 — Item 6(a): the owner's concurrent-run cap is SHARED with the link, so a busy link can
crowd out the owner's own turns — an accepted consequence.**
Citation: BILLING.md §Group Funding (A link's allowance is per-link, not per-guest, and that is what makes a bearer credential safe).
Sharp edges: a link user starting many concurrent runs can exhaust the owner's OWN concurrent-run
slots — accepted-but-real cross-tenant resource contention, directly testable (owner's own send
blocked by link traffic).
Visibility: user-visible (owner's send blocked with a wait-for-message-to-finish state, NR-9).

**GF-9 — Item 6(b): the served figure discloses the owner's spendable amount whenever the owner's
wallet is the binding term — bounded by the cap the owner sets, zero when none set. 6(b) covers
_only_ the balance disclosure — it is explicitly NOT authority for withholding the cushion (the
served owner dimension is cushion-inclusive, per AFFP-8/AFFP-9), and it says nothing about holds
or payer identity (payer identity is Notices & Refusals item 5, NR-5).**
Citation: BILLING.md §Group Funding (A link's allowance is per-link, not per-guest, and that is what makes a bearer credential safe).
Sharp edges: this is a citation-discipline note the doc makes about _itself_ — see the "internal
ambiguity" flag in the final report section below; the race/exhaustion-at-admission rule is
explicitly NOT item 6(b) despite living in the same numbered item's neighborhood — it is item
7(b) (GF-11).

**GF-10 — Ruled edge case 7(a): pre-send exhaustion → members fall through to personal funds,
guests refused.**
Citation: BILLING.md §Group Funding (Ruled edge cases).

**GF-11 — Ruled edge case 7(b): exhaustion discovered only AT ADMISSION (a race) → hard refusal,
no in-admission re-resolve; the client's retry re-resolves. The doc explicitly directs: cite this
rule as "§Group Funding 7(b)," never as "6(b)."**
Citation: BILLING.md §Group Funding (Ruled edge cases), citation-discipline note at BILLING.md §Group Funding (Cite the race rule as §Group Funding 7(b), never as 6(b)).
Sharp edges: directly testable concurrency scenario — a link/group send that races the exhausting
transaction must hard-refuse with no silent re-resolution inside the same admission attempt.

**GF-12 — Ruled edge case 7(c): a budget edit below accrued spend is validated and rejected AT
THE EDIT — never silently clamped, never deferred to the next send.**
Citation: BILLING.md §Group Funding (Ruled edge cases).

**GF-13 — Ruled edge case 7(d): member removal deletes the member's budget row; owner deletion
cascades (restates GF-5 as an explicitly ruled edge case).**
Citation: BILLING.md §Group Funding (Ruled edge cases).

**GF-14 — Ruled edge case 7(e): negative owner balance → zero headroom, clamped, not an error
(restates GF-6).**
Citation: BILLING.md §Group Funding (Negative owner balance → zero headroom (clamped, not an error)).

**GF-15 — Ruled edge case 7(f): owner tier and balance are read fresh per turn, never cached
across turns (restates GF-6).**
Citation: BILLING.md §Group Funding (Ruled edge cases).

---

## 19. Balance consumption

**BC-1 — Charges land on the payer's purchased wallet; every user also has a free wallet
(ALWAYS balance 0) through which daily-allowance-accounted charges write a day-keyed
allowance-spending row.**
Citation: BILLING.md §Balance Consumption (Charges land on the payer's purchased wallet).

**BC-2 — Free allowance applies to basic models only on SEND, but to ANY affordable model on
regenerate (per FDM-3). It is day-keyed (unique on user+day, UTC), NEVER offsets a negative
purchased balance, and there are NO midnight-reset jobs — a new day is simply a new row.**
Citation: BILLING.md §Balance Consumption (The free allowance applies to basic models only on a send).

**BC-3 — Member budgets and conversation spending are LIFETIME CUMULATIVE rows, unique per
member per conversation: budget=total allowance, remaining=allowance−accrued spend, accrual keyed
by SENDER. Budget edits validate against accrued spend. No period keying, no reset jobs
whatsoever.**
Citation: BILLING.md §Balance Consumption (Member budgets and conversation spending are lifetime cumulative rows).
Sharp edges: directly contradicts a naive "daily/monthly budget" mental model — group budgets
NEVER reset; a test asserting a group budget resets after a day/month/period would be testing the
wrong behaviour entirely.

---

## 20. Billing flow

**BF-1 — One flow every turn: (1) funding decision picks the source; (2) admission gates the run
and places the hold — nothing spent yet, nothing commits until step 4; (3) the run streams —
OpenRouter returns charged `usage.cost` inline for text/video, converted to billable by the
ModelProvider port (the ONLY markup application on the money path at this seam); image is priced
at its deterministic billable catalog estimate; (4) settlement: a single transaction persists
content + calls `chargeWithinTx` (unguarded — negative balances legal), charging the
already-billable amount + storage, writing the usage record (payer wallet AND sender) + zero-sum
ledger legs [+ idempotency-key flip]. A run killed before settlement saves nothing/bills nothing;
explicit user stop settles/bills the partial.**
Citation: BILLING.md §Billing Flow (Settlement).

**BF-2 — The operative form of `reserve ⊇ bill` as a rule for adding new charge terms: "if
settlement can charge for it, admission must reserve for it." Media byte-storage and prompt
char-storage are held for exactly this reason — a new charge term shipped without a matching
reservation term is the specific defect this rule exists to catch.**
Citation: BILLING.md §Billing Flow (The operative consequence of `reserve ⊇ bill` (stated as an equation in Math & Terms) is a rule for adding terms).
Sharp edges: for every charge type that CAN appear in a settlement, there must be a corresponding
reservation line item covering it at estimation time (cross-references RESV-1/RESV-2) — testable
as a structural property (enumerate settlement charge types, confirm each has a hold-side
counterpart), not just a scenario test.

---

## 21. Notices & refusals

**NR-1 — Reasons are typed; copy is derived from the SAME typed reason that drives greying — one
place produces human copy per reason, so a condition cannot acquire a second phrasing on a second
surface. A send disabled while the funding read is still settling (loading state) is NOT a
refusal — no verdict yet, so nothing is said.**
Citation: BILLING.md §Notices & Refusals (Reasons are typed; copy is derived).
Sharp edges: the loading/settling state must be visually/semantically distinct from an actual
refusal — no error message should render during that window.
Visibility: user-visible.

**NR-2 — One condition, one wording: a pre-send notice and a wire refusal describing the same
condition read IDENTICALLY. Divergent phrasings for one cause are a defect, not a nuance.**
Citation: BILLING.md §Notices & Refusals (One condition, one wording).
Sharp edges: directly testable via string comparison — the pre-send notice text and the actual
refusal's derived copy for the same `RefusalCode` must be byte-identical.

**NR-3 — Every notice names an action ("Add credit", "Shorten your message", "Remove a model",
"Ask the conversation owner for budget", "Wait for the message to finish"). A cause without an
action leaves the user guessing which of several inputs to change; "wait" IS an action, an absent
action is not.**
Citation: BILLING.md §Notices & Refusals (Every notice names an action).

**NR-4 — When two constraints bind, precedence is deterministic: a ceiling is
`min(providerCap, contextHeadroom, budgetBuys)`, so more than one term routinely binds at once and
both "add credit" and "shorten your message" could be true simultaneously. The rule: if funding
cannot cover a minimum answer at all, the reason is MONEY; if it can, and the prompt itself is
what makes the turn infeasible, the reason is LENGTH. Test the minimum-answer floor first. One
condition therefore yields one notice, always the same one.**
Citation: BILLING.md §Notices & Refusals (When two constraints bind, precedence is deterministic).
Sharp edges: a scenario engineered so BOTH money and length would independently make the turn
infeasible must resolve to exactly the MONEY reason (money-floor test runs first) — the precedence
order itself is the thing to pin, since a length-first implementation would show the wrong notice
in the ambiguous overlap case.
Visibility: user-visible (which single notice text renders).

**NR-5 — A change of payer requires an affirmative pre-send disclosure: when group headroom
cannot cover the turn and a signed-in member falls through to personal funds, the send SUCCEEDS —
so it never enters the refusal vocabulary and would otherwise be silent. The member is told
BEFORE sending that this message will be charged to them, including when they were never
allocated a budget at all. Switching who pays is not a detail to discover from a balance later.**
Citation: BILLING.md §Notices & Refusals (A change of payer requires an affirmative pre-send disclosure).
Sharp edges: this is a _successful_ send (not a refusal) that nonetheless requires a distinct
pre-send disclosure — easy to miss because it isn't gated by the refusal machinery at all; a test
must confirm the disclosure appears even though the send is not blocked.
Visibility: user-visible.

**NR-6 — Refusals do not name the binding constraint: an action is not a constraint disclosure —
the user is told what they can do, not which internal limit bound. No refusal exposes an amount, a
token count, or a threshold.**
Citation: BILLING.md §Notices & Refusals (Refusals do not name the binding constraint).
Sharp edges: directly testable by asserting no refusal-copy string contains a number/currency
figure/token count.
Visibility: user-visible (absence of a number in the copy).

**NR-7 — Severity is structural: blocking reasons are errors and are not dismissible;
informational funding notices are dismissible. A notice never blocks a send that the verdict
permits, and a send the verdict refuses always carries a notice.**
Citation: BILLING.md §Notices & Refusals (Severity is structural).
Sharp edges: two failure modes to test independently — a dismissible notice that actually blocks
the send (contradiction), and a refused send with NO notice shown (silent refusal).

**NR-8 — Every paid action carries the send verdict: sending, queueing a message while a run
streams, draining that queue, and regenerating are all paid actions reading the same verdict —
with one ruled exception on one axis: a regenerate reads the money half only (affordability gates
it exactly as a send; premium entitlement does not — restates FDM-3). The exception is
entitlement-shaped, so it never widens what a payer can spend. A surface that can spend money and
cannot refuse is a defect.**
Citation: BILLING.md §Notices & Refusals (Every paid action carries the send verdict).
Sharp edges: "a surface that can spend money and cannot refuse is a defect" is a strong general
claim — every paid-action surface (send, queue, drain, regenerate) must have a reachable refusal
path; a surface found to lack one is a defect by the doc's own definition.

**NR-9 — A hold blocks the send; it never greys the options: when the payer's funds are reserved
by a run in flight (not spent), the send button disables with a transient reason whose action is
"wait for the message to finish," and NO payment action (paying would not help — offering it would
be a false path). The notice does not name/link the conversation generating. Model rows, effort
levels, and dimension toggles stay in their normal state (the payer can afford those options; what
they cannot do is start another run this instant). The reason is turn-level, rendering once at the
composer, not once per model. Recovery is immediate: reserved funds return when the run finishes,
so served numbers invalidate on run completion regardless of which conversation raised it, and on
window focus. A blackout that outlives the run it describes is a defect.**
Citation: BILLING.md §Notices & Refusals (A hold blocks the send; it never greys the options).
Sharp edges: (1) the notice must offer NO payment CTA — a "wait" notice with an "Add credit" action
would be the false path the doc explicitly rejects; (2) recovery must be immediate on run
completion — a stale blackout persisting past the run's actual finish is a named defect; (3) the
notice must not identify which conversation is generating.
Visibility: user-visible.

**NR-9b — Accepted trade-off (same section): a payer may select a model and then find the send
blocked by a hold — preferred over repainting the catalog as unaffordable, because the composer
states the block before the picker opens, the send gate still prevents every wrong spend, and the
payer can browse/select/compose usefully while the run completes (exactly as the in-conversation
queue already assumes).**
Citation: BILLING.md §Notices & Refusals (A hold blocks the send; it never greys the options).
Sharp edges: a UI that instead greys the picker during a hold (rather than leaving it normal per
AFF-7/NR-9) would be "fixing" behaviour the doc explicitly says is an accepted, deliberate
trade-off — not a bug.

---

## 22. Where the code lives (architecture boundaries stated as testable rules)

**WCL-1 — The money layer is pure (no database, no cache, no clock, no randomness, no network)
and content-free: no export accepts a prompt, a message, or a history array — only counts, rates,
and identifiers. The rule targets what a _type permits_ (a bare `string`), not what a parameter is
_named_ — branded/refined string types stay legal. The doc explicitly notes this is "today...
intent, not enforcement": no lint rule currently pins it, and the wire parsers/brand constructors
still take a bare `string`.**
Citation: BILLING.md §Where the Code Lives (The money layer is a bounded module inside the shared package).
Sharp edges: this is a self-flagged GAP — the doc states its own purity/content-free claim is not
currently enforced by any rule. A test asserting "no money-layer export accepts a bare string
parameter" would currently have nothing pinning it; this is a real, doc-acknowledged enforcement
hole, not a doc-vs-code disagreement (the doc is honest about the gap).
Visibility: internal-only (source-level), explicitly unenforced.

**WCL-2 — The public surface is exactly eight things:
`getTurnOptions(funding,basis,selection,snapshot)` (the one producer, called once with the
composed basis; substitutes the empty basis for `affordable` itself — no caller-supplied basis
possible, closing off the AFFP-2 hazard structurally), `resolveFunding(inputs)`, `notices(refusal)`
(takes a typed reason or a refused verdict as published, attribution included — copy is a total
function of that input, never of a wording a surface chose), plus
`getMediaTurnOptions`, `minTurnCostNanoUsd`, `textTurnBudget`, `mediaTurnCostNanoUsd`,
`effortSelectionForTurn`.**
Citation: BILLING.md §The public surface (getTurnOptions(funding, basis, selection, snapshot)).
Sharp edges: `getTurnOptions`'s fourth argument, `CatalogSnapshot={models,nowMs}`, is called out as
"necessary, not convenient" — the instant rides in the snapshot rather than as a separate
parameter specifically so premium classification is evaluated "as of one moment" for BOTH the
affordable and admissible passes from one snapshot; a fifth positional time argument would permit
`affordable` and `admissible` to classify the same model differently at slightly different
instants. This is a genuinely subtle API-shape correctness argument, directly testable: confirm
there is no code path that could evaluate the two passes against different `nowMs` values.

**WCL-3 — The fee applications are NOT barrel seams — permitted only at named call sites via a
path allowlist; a barrel export would hand every consumer an allowed-looking route, making the
allowlist decorative. Deliberately not exported: the minimum-answer constant, tier ratios, the
reasoning-budget ladder, rates, manifests, reducers, per-candidate ceiling solvers, clamping.**
Citation: BILLING.md §The public surface (Deliberately not exported).
Sharp edges: this is an architectural/lint-level claim (see also FEE-2 for the "exactly three
seams" enumeration) rather than a runtime-behaviour claim — testable via `arch:check`-style static
analysis, not via E2E.
Visibility: internal-only.

**WCL-4 · `resolveClassifierAnswer` resolves both axes together, each declared fallback applied
here and nowhere else: `modelId` is the named candidate, else the first on the list; `effort` is
the named rung when presented, else the cheapest presented option (RE-9's rule), clamped down to a
rung the bound candidate answers at.**
Citation: BILLING.md §The public surface (`resolveClassifierAnswer` is the module's entry point for model-generated reply text).
Sharp edges: resolving the axes apart lets an answer bind a candidate at a rung it has no cap for.

**WCL-5 — What is enforced (not merely intended), per the doc's own closing list: (1) the module
is reachable only through its barrel plus an enumerated, test-pinned interim subpath list that
"must reach empty." (2) No code under `apps/web` outside one named adapter hook imports a pricing
or affordability symbol — written against code, not components. (3) No branching on a dimension
identifier or option literal outside its modality's registry. (4) Rate arithmetic confined to the
module; fee application confined to the allowlisted seams. (5) The module imports no
database/cache package; imports INTO the module are permitted only from a pinned enumerated
allowlist.**
Citation: BILLING.md §What is enforced, not merely intended (Today an intent, not enforcement).
Sharp edges: item (1)'s "must reach empty" is a decaying-allowlist claim — it implies the interim
subpath list is expected to shrink over time to nothing; a test that merely checks the list hasn't
_grown_ would under-test the doc's actual claim (that it should trend to zero).
Visibility: internal-only (architecture-level, `arch:check` territory, not E2E-observable
directly).

---

## 23. Fee structure

**FEE-1 — A negative balance is a visible state, not a hidden one: the paid cushion permits going
negative by its amount, so a payer can finish a turn owing money. A top-up clears the deficit
BEFORE adding spendable funds — a $5 payment against a $0.50 deficit leaves $4.50 available — and
this is stated at the point of payment, not discovered later from a balance that doesn't match the
amount paid.**
Citation: BILLING.md §Fee Structure (A negative balance is a visible state, not a hidden one).
Sharp edges: the deficit-clears-first arithmetic is directly numerically testable ($5 in, $0.50
deficit ⇒ $4.50 spendable, not $5.00 or $5.50); the "stated at point of payment" clause is a UI
requirement (payment confirmation must show the deficit-adjusted result, not the raw payment
amount).
Visibility: user-visible.

**FEE-2 — Fees are baked at exactly three seams, and nowhere else: (1) catalog ingestion —
`normalize` applies the markup to every provider rate before persisting, so the catalog stores
billable (after-fee) rates only, readers fail fast on unbaked rows; (2) the ModelProvider port —
the provider's inline `usage.cost` converts to billable exactly once, before the cost decision;
(3) the tool fee seam (`packages/shared/src/affordability/estimate/tool-pricing.ts`), which bakes
each tool's per-call price once (ceil), because it is not a catalog rate. No other code applies,
removes, or reasons about fees; a lint rule confines markup imports to these seams.**
Citation: BILLING.md §Fee Structure (Fees are baked once, at the seam).
Sharp edges: "readers fail fast on unbaked rows" implies a runtime assertion exists somewhere that
a catalog row's rate looks fee-baked — testable by attempting to seed an unbaked rate and
confirming a fail-fast error, not a silent acceptance.
Visibility: internal-but-observable (catalog row values, or the fail-fast error if violated).

**FEE-3 — Rate baking rounds CEIL (against the user); the ModelProvider port's charge conversion
rounds HALF-EVEN. Raw provider cost is never retained anywhere.**
Citation: BILLING.md §Fee Structure (Rate baking rounds ceil (against the user)).
Sharp edges: two DIFFERENT rounding modes at two DIFFERENT seams — a test conflating them (using
ceil where half-even is specified, or vice versa) would produce a subtly wrong fee at exactly one
of the two seams; also "raw provider cost never retained" is a negative-existence claim about
what's persisted — testable by confirming no DB column stores an unconverted provider-rate value.

**FEE-4 — Storage fees are separate, never marked up, and already final at their defining
constants — the 15% fee never applies to storage.**
Citation: BILLING.md §Fee Structure (Storage fees are separate).
Sharp edges: a storage-fee charge that somehow picked up the 15% markup (e.g. via a shared
"apply markup" code path reused incorrectly) is the specific defect this line rules out.

---

## 24. Storage fees

**SFEE-1 — `STORAGE_COST_PER_CHARACTER_NANO` = 300n/char (text); `MEDIA_STORAGE_COST_PER_BYTE_NANO`
= 18n/byte (media) — single-sourced as exact integer nano-USD constants.**
Citation: BILLING.md §Storage Fees (Messages are charged a per-character storage fee covering long-term retention).

**SFEE-2 — Storage is pass-through: the estimator folds it as never-fee-bearing line items, and
settlement adds the same nano rate to the charge without markup (restates FEE-4 from the storage
side).**
Citation: BILLING.md §Storage Fees (Messages are charged a per-character storage fee covering long-term retention).

**SFEE-3 — Text and media are priced differently because they are stored differently: text is
Postgres-resident (replicated, backed up, queryable) while media is object storage — the ~16.7×
rate difference comes entirely from the two different underlying monthly-cost-per-GB figures, not
from any other factor. Derivation: text = ($0.50/GB-mo × 12 × 50yr) ÷ 1e9 chars/GB = 300 nano;
media = ($0.03/GB-mo × 12 × 50yr) ÷ 1e9 bytes/GB = 18 nano. Both derivations land exactly on the
shipped constants.**
Citation: BILLING.md §Storage Fees (Text and media are priced differently because they are stored differently).
Sharp edges: this is a numerically pinned derivation — the doc explicitly claims the shipped
constants are exact outputs of this formula ("auditable rather than asserted"); a test could
recompute the formula and assert it equals the shipped constant exactly, catching any future
constant change that isn't matched by a corresponding derivation-comment update (or vice versa —
flags drift between the "why" and the "what").

**SFEE-4 — The retention term is 50 years, which is what makes the absolute figures large enough
that a long answer can carry more storage fee than its own inference cost on a cheap model — a
deliberate consequence of the retention promise, not a mispricing.**
Citation: BILLING.md §Storage Fees (Both derivations land exactly on the shipped nano constants).
Sharp edges: directly testable scenario — construct a long-answer/cheap-model turn and confirm the
storage-fee component of the total charge can legitimately exceed the inference-fee component;
a "storage fee capped below inference cost" implementation would be the wrong-direction fix to a
non-bug.
Visibility: user-visible (final cost breakdown, if ever itemized to the user).

**SFEE-5 — The nano constants are the source; any float is derived from them, never computed
independently — the storage-rate module's own contract forbids the formula shown in the doc from
being a live parallel calculation; it documents _how the rate was chosen_, and display values
convert from the nano constants.**
Citation: BILLING.md §Storage Fees (The nano constants are the source; any float derives from them).
Sharp edges: a display-layer float computed via its own independent formula (rather than
converting the nano constant) would be exactly the second-implementation drift risk this line
warns against (see CODE-RULES.md's "One Implementation, Shared" principle, which this section is
a domain-specific instance of).

**SFEE-6 — Content that never rests is never charged storage: the classifier's prompt and output
are mid-flow values, so no storage is reserved or billed for them.**
Citation: BILLING.md §Storage Fees (Content that never rests is never charged storage).
Sharp edges: restates COST-8's "no storage" clause for the classifier from the storage-fee side;
a test should confirm a turn's storage-fee total accounts for exactly the persisted content
(siblings' answers, the anchored prompt storage) and nothing attributable to the classifier's own
tokens.

**SFEE-7 · Characters HushBox writes into a stored answer (framing and search rows) are billed as
storage and reserved up front; search sources beyond the allowance are dropped and reported under
`search_row_oversize`.**
Citation: BILLING.md §Storage Fees (HushBox-authored characters are billed and reserved as storage).

---

## 25. Trial usage

**TRIAL-1 — Trial (unauthenticated) users: basic models only, `TRIAL_MESSAGE_LIMIT` messages per
day, no persistence.**
Citation: BILLING.md §Trial Usage (Basic models only).

**TRIAL-2 — Per-message cost cap `MAX_TRIAL_MESSAGE_COST_CENTS` (1¢) — a message estimated above
it is denied. Trial supports effort in full: the classifier and an explicit pin alike — the
classifier's ~0.1¢ worst-case reserve fits inside the 1¢ cap, priced by the same math as paid
turns, and a pinned level is enforced against the trial candidate set exactly as against a paid
one.**
Citation: BILLING.md §Trial Usage (Per-message cost cap).
Sharp edges: a trial turn with an explicit high-effort pin that would blow the 1¢ cap must be
denied pre-send exactly as a paid-tier over-cap turn would be — same enforcement mechanism, only
the cap value differs.

**TRIAL-3 — The client sends an `x-trial-token` (a uuid kept in localStorage), resolved to an
ephemeral trial-session principal — never persisted server-side.**
Citation: BILLING.md §Trial Usage (The client sends an `x-trial-token` (uuid kept in localStorage)).
Sharp edges: "never persisted server-side" is a negative-existence claim about the identity token
itself (distinct from the Redis-backed quota counters, which ARE server-side but keyed off derived
hashes, not the raw token) — worth checking there's no DB row keyed directly on the trial token.

**TRIAL-4 — Dual-identity quota: a per-session counter and a per-caller counter (SHA-256 of the
IP, IPv6 collapsed to its /64) both increment in Redis; the HIGHER of the two is compared against
the limit, so clearing localStorage doesn't reset the quota.**
Citation: BILLING.md §Trial Usage (Dual-identity quota).
Sharp edges: directly testable abuse-resistance property — clearing the client-side trial token
and resending must NOT reset the effective daily count, because the IP-keyed counter persists
independently and the max of the two is what's enforced.

**TRIAL-5 — Counters reset at UTC midnight by key rollover — the day is part of the key, so a new
day addresses a fresh counter and the old one expires unread. Redis down fails closed.**
Citation: BILLING.md §Trial Usage (Counters reset at UTC midnight by key rollover).

**TRIAL-6 — A global day-keyed trial spend cap (`TRIAL_DAILY_SPEND_CAP_NANO_USD`, $50/day) bounds
aggregate trial provider spend (the Sybil backstop). It is a read-and-compare admission gate over
one Redis counter fed with actual cost at settlement — there is NO reservation for it (a small
burst can overshoot, bounded by the per-message cap — this overshoot is deliberate, not a bug).
The single increment that crosses the cap fires exactly one Sentry alert. Redis down fails closed.**
Citation: BILLING.md §Trial Usage (A global day-keyed trial spend cap (`TRIAL_DAILY_SPEND_CAP_NANO_USD`, $50/day) bounds aggregate trial provider spend).
Sharp edges: this is explicitly NOT reservation-gated like every other billing amount in the doc —
it's a read-and-compare check fed by actual settled cost, so overshoot past $50/day by up to one
message's worth is an accepted, deliberate design gap, not a bug to "fix" by adding a reservation.

**TRIAL-7 — Trial settlement persists and bills nothing to any user wallet; only the global spend
counter is fed.**
Citation: BILLING.md §Trial Usage (Trial settlement persists and bills nothing).
Sharp edges: distinguishes "trial settlement writes zero user-facing charges" from "trial
settlement writes zero side effects at all" — the global counter IS written; a test that trial
settlement is a complete no-op would be wrong.
Visibility: internal-but-observable (the global Redis counter increments; no `usage_records` row
for the user).

**TRIAL-8 — The remaining message count is presented BEFORE it binds: the composer states it once
the day's allowance is partly spent, in the notice stack and in place of the free-preview notice.
It is display only — the server refusal is what actually stops a send — and it is explicitly NOT
part of the notice vocabulary (whose sentences carry no magnitudes, per NR-6) — a quota invisible
until the send fails is a refusal the user could not have anticipated.**
Citation: BILLING.md §Trial Usage (The remaining message count is presented before it binds).
Sharp edges: this display is a deliberate, named EXCEPTION to NR-6's "no refusal exposes a
number" rule — it's a pre-emptive display, not a refusal's copy, so the two must not be conflated
in a test (NR-6 governs refusal copy specifically; the trial remaining-count display sits outside
that vocabulary by design).
Visibility: user-visible.

---

## 26. New user bonus

**NUB-1 — Account creation provisions both wallets and grants a welcome credit
(`WELCOME_CREDIT_CENTS`) to the purchased wallet as a zero-sum promo ledger pair.**
Citation: BILLING.md §New User Bonus (Account creation provisions both wallets and grants a welcome credit (`WELCOME_CREDIT_CENTS` in `packages/shared/src/affordability/money/tiers.ts`) to the purchased wallet as a zero-sum promo ledger pair).
Visibility: user-visible (starting balance); internal-but-observable via `ledger_entries` (the
promo pair must sum to zero, per INV-3).

**NUB-2 — Idempotency-keyed per user (`provisionWalletsWithinTx`) — a retried/duplicate
registration attempt must not grant the welcome credit twice.**
Citation: BILLING.md §New User Bonus (idempotency-keyed per user (`provisionWalletsWithinTx` in `apps/api/src/slices/billing/domain/wallets/wallets.ts`)).
Sharp edges: classic idempotency test — replaying the provisioning call for the same user must be
a no-op on the second attempt.

**NUB-3 — Hard deletion means a re-registered email receives the welcome credit again — this is
an ACCEPTED, bounded risk (bounded by the global trial/welcome budget), not a bug to fix.**
Citation: BILLING.md §New User Bonus (Hard deletion means a re-registered email receives it again).
Sharp edges: a "fix" that tracked deleted-email welcome-credit history to prevent re-grant would
contradict the doc's explicit acceptance of this behaviour — worth flagging to whoever writes
tests here that this is intentionally NOT prevented.

---

## 27. Payments (Helcim)

**PAY-1 — Card charges use Pattern D (pre-claim then reconcile): a durable `payments` row is
written BEFORE the charge, finalized by webhook, and verified by a delayed `payment.verify.v1`
job that can also recover an orphaned capture by searching Helcim by the payment reference.**
Citation: BILLING.md §Payments (Helcim) (Card charges are Pattern D (pre-claim then reconcile)).

**PAY-2 — Webhook signature verification fails closed.**
Citation: BILLING.md §Payments (Helcim) (Webhook signature verification fails closed).
Sharp edges: an unsigned or badly-signed webhook must be rejected, never processed with a warning.

**PAY-3 — Payment states (`payment_status` enum) move forward only on every automatic path:
`pending → awaiting_webhook → completed | failed`, plus `expired` for pre-claims the verify job
gives up on; a reverse transition exists only as a registered admin operation (PAY-8).**
Citation: BILLING.md §Payments (Helcim) (Payment states (`payment_status` enum)).
Sharp edges: the charge finalize, the webhook, and the verify job must never move a row
backward — an automatic path that re-opened a terminal row would re-run a credit the ledger's
per-payment keys would then have to refuse.
Visibility: internal-but-observable via DB (`payments.status`); a reverse move carries an
`admin_audit` row, an automatic move never does.

**PAY-4 — A chargeback/reversal posts a `byEventId` clawback pair and auto-locks the account with
session revocation (reversible); inquiries/retrievals only notify (no auto-lock, no clawback).**
Citation: BILLING.md §Payments (Helcim) (A chargeback/reversal posts a `byEventId` clawback pair and auto-locks the account with session revocation (reversible)).
Sharp edges: the distinction between chargeback/reversal (auto-lock + clawback) and
inquiry/retrieval (notify only) is the sharp edge — a webhook event type misclassified into the
wrong bucket would either over-react (locking an account on a mere inquiry) or under-react
(failing to lock on an actual chargeback).
Visibility: user-visible (account lock); internal-but-observable via `users.lockedAt` and the
clawback ledger pair.

**PAY-5 — Locally, Helcim is mocked; CI's e2e lane uses the Helcim sandbox.**
Citation: BILLING.md:1671-1672.
Visibility: internal-only (test-infrastructure fact, not a production behaviour — included for
completeness since the doc states it as part of the payments section).

**PAY-6 — A fresh card pre-claim is refused (`409 PAYMENT_IN_FLIGHT`) while the payer holds a
`pending` or `awaiting_webhook` row younger than the verify path's window; the count is taken
under the payer's wallet-row lock, so two concurrent fresh deposits admit exactly one, and a
replay of the same `Idempotency-Key` is never guarded.**
Citation: BILLING.md §Payments (Helcim).
Sharp edges: the release is by terminal status OR by row age. The window is derived from the
verify job's delay and retry budget, never a written-down number, so a test pins the derivation
and the budget's span, not a value. A unique partial index would enforce the status half and
drop the age half, locking a payer out for good behind a row nothing resolves. The `pending`
row a provider server error leaves behind blocks the next deposit until the verify job expires
it.
Visibility: user-visible (the refusal and its copy); internal-but-observable via the payer's
non-terminal `payments` rows.

**PAY-7 — A provider server error on the charge is an unknown outcome, not a decline: the
pre-claim stays `pending` for the verify job and the caller is answered unavailable, never
`failed`.**
Citation: BILLING.md §Payments (Helcim).
Sharp edges: a 5xx can follow a capture, and its decline-shaped body states nothing about the
card; finalizing it as `failed` would invite a re-charge against a card that may already have
paid. A genuine 4xx decline still finalizes as `failed`.
Visibility: user-visible (an unavailable error rather than a decline); internal-but-observable
via `payments.status` staying `pending`.

**PAY-8 — A payment row is moved backward only by a registered admin operation, in two mutual
inverse pairs: `payment.forceExpire` ↔ `payment.restoreAwaitingWebhook` (no money) and
`payment.forceCompleteAndCredit` ↔ `payment.uncompleteAndClawback` (exactly the row's amount);
each is an atomic conditional update on the row's current status and never calls the
provider.**
Citation: BILLING.md §Payments (Helcim).
Sharp edges: an op racing the webhook or the verify job must lose cleanly — a row another writer
moved refuses with a conflict, a missing row with not-found, and neither credits twice. The
money pair posts under keys derived from the adjustment's own identity, never the webhook's
per-payment `deposit:` keys, so a clawed-back row returning to `awaiting_webhook` can still be
completed by a later webhook delivery; an inverse may therefore refuse from a later state,
which the Reversibility Iron Law accepts.
Visibility: internal-but-observable via `payments.status`, the `admin_audit` row, and the
ledger pair the money ops post.

**PAY-9 — A read-only auditor pages once per pass when any payment row remains non-terminal
past the verify path's window; it transitions nothing and redrives nothing.**
Citation: BILLING.md §Payments (Helcim).
Sharp edges: the cutoff is the verify delay plus the whole retry budget at its widest jitter
plus a grace margin — an upper bound, so the auditor never fires on a row the dispatcher may
still retry. One event per pass whatever the count: a provider outage strands rows in bulk, and
a page per row would bury the one repair a human must make.
Visibility: internal-only (one Sentry event per pass under the
`paymentUnresolvedPastVerifyWindow` fingerprint; which rows is a query against `payments`).

---

## What Part 1 deliberately leaves out

- "Mechanisms rejected" prose (the several places in the doc, e.g. around Reasoning Effort, where
  rejected alternative designs are listed with reasons) was deliberately excluded from this
  catalogue: rejected mechanisms describe what the system does NOT do and why a past design was
  turned down — they are not behaviours of the running system and are not pass/fail testable
  against it.
- "Configuration Reference" (BILLING.md §Configuration Reference) was excluded as its own
  area: it is a file-location lookup table, not a behaviour — its content is folded
  into individual entries' citations where relevant (e.g. FEE-2, SFEE-1) instead.
- "Extending the System" (BILLING.md §Extending the System) is process guidance for future changes ("add a dimension,"
  "add a resource," etc.), not a behaviour of the current system, and was excluded as its own set of entries for the
  same reason as rejected mechanisms. One exception worth a reader's attention, not enumerated as a standalone
  testable entry: BILLING.md §Add a modality (Catalog admission's price floor is deliberately not extended) states
  the price floor is deliberately NOT extended to per-unit (media) modalities — this is really a restatement of
  CAT-8 and is covered there.

---

## Part 2 — behaviours only the code states

Billing behaviour that is real in the running system and that reading `docs/BILLING.md` alone would
not reveal, because the specification is silent, thin, or in tension with the code. Entries cite
the code that carries the behaviour. Nothing here re-enumerates Part 1.

## Admission (the balance gate)

### B01 — Admission is a single atomic Redis Lua script; nothing else gates a balance

**Statement:** The only balance/budget check in the whole write path is inside
`ADMISSION_SCRIPT`, run as one atomic EVAL; no other code path (charge, settlement) checks
a balance before writing.
**Citation:** `apps/api/src/slices/billing/domain/admission/scripts.ts` (full file, the
`ADMISSION_SCRIPT` Lua source) + `apps/api/src/slices/billing/domain/admission/admission.ts`
(`admitRun()` dispatches on the script's outcome string) + `apps/api/src/slices/billing/domain/charge.ts:111` (`chargeWithinTx` takes the wallet lock and debits with **no** balance
check — comment: "settlement charges unguarded; negative balances legal").
**Sharp edges:** The script writes to ALL hold hashes (run-count, balance-hold,
each budget-scope hash) only after every prior check passes — a test that stubs a partial
Lua failure (e.g. asserts a hold exists after a budget-scope refusal) would catch a
regression that starts writing before all checks clear. The `applyBalanceCheck` flag exists
(free-tier/trial runs skip the balance leg) — a test must cover both flag states.
**Observability:** Externally observable via the API's admission-refusal response code
(`insufficient-balance` / `run-cap` / `allowance-exceeded` / `member-budget-exceeded` /
`conversation-budget-exceeded`) and via the Redis hold hashes directly (not exposed to the
client). Not observable from a Postgres row — admission never touches Postgres except the
one-time snapshot bootstrap.

### B02 — Redis down fails ALL admission closed, with no degraded mode

**Statement:** Any Redis error during admission (script failure, connection failure) is
mapped to a typed `unavailable` DomainError and the run is refused — never silently admitted.
**Citation:** `apps/api/src/slices/billing/domain/admission/admission.ts` (`redisFailure()` →
`unavailableError('admission refused: Redis unavailable (fail-closed)')`).
**Sharp edges:** This applies to admission only — `incrementTrialSpend`/`admitTrialSpend`
(trial path) and the wallet-snapshot write-through independently fail closed too (see B15),
but each is a separate fail-closed site, not one shared guard; a test suite that only breaks
one Redis call site could pass while a sibling site silently degrades.
**Observability:** A 5xx/typed-error API response; no DB row is ever written on this path
(admission never opens a transaction).

### B03 — The concurrent-run cap is per wallet, not per user or per conversation

**Statement:** The Lua script's run-cap check counts active holds keyed by wallet id (5 per
wallet per BILLING.md, confirmed live in `admission/scripts.ts`), independent of which
conversation or which of the wallet-owner's other conversations is running.
**Citation:** `apps/api/src/slices/billing/domain/admission/scripts.ts` (`ADMISSION_SCRIPT`,
run-cap section) — cross-checked against BILLING.md §Principles (Admission invariants)
("concurrent-run cap (5 per wallet)"), consistent.
**Sharp edges:** "One run per conversation" (ARCHITECTURE.md) is a _separate_, DO-level
invariant (see B21) from this wallet-level cap; a test that only exercises the
one-per-conversation lock could miss a scenario where the SAME wallet funds five
_different_ conversations concurrently and a sixth is refused by this cap, not the
per-conversation lock.
**Observability:** `run-cap` refusal code in the admission response; the active-hold count is
readable via `HOLDS_READ_SCRIPT` but that read path is not itself part of admission.

### B04 — `spendableFor()` treats wallet types asymmetrically

**Statement:** A free wallet's admission never checks balance at all; a purchased wallet is
checked against `spendableFundsNanoUsd` (balance minus a cushion, `PAID_CUSHION_NANO_USD`);
any other wallet state fails closed on the raw balance.
**Citation:** `apps/api/src/slices/billing/domain/admission/admission.ts` (`spendableFor()`) +
`packages/shared/src/affordability/estimate/pre-adapters.ts` (`spendableFundsNanoUsd`,
`getCushionNano`, `PAID_CUSHION_NANO_USD` — re-exported at
`packages/shared/src/affordability/estimate/index.ts:27-32`).
**Sharp edges:** The wallet-type enum is exactly two values, `'purchased'` and `'free'`
(`packages/db/src/schema/enums.ts:65` — `pgEnum('wallet_type', ['purchased', 'free'])`); a
test that assumes a third type (e.g. "other" as loosely stated in ARCHITECTURE.md's House
Accounts list, which is `revenue`/`payments-in`/`promo` — those are **house accounts**, not
wallet types) would be testing a state the schema cannot produce.
**Observability:** Not observable externally beyond the pass/fail of admission; the
distinction lives entirely in `spendableFor`'s branch, invisible to any API response.

### B05 — The cushion on purchased wallets (`PAID_CUSHION_NANO_USD`) is a hidden reserve

**Statement:** A purchased wallet's "spendable" balance used at admission is strictly less
than its ledger balance by a fixed cushion; this cushion is never charged or shown as a
distinct line to the user.
**Citation:** `packages/shared/src/affordability/estimate/pre-adapters.ts`
(`getEffectiveBalanceNano`, `spendableFundsNanoUsd`, `PAID_CUSHION_NANO_USD`).
**Sharp edges:** A test asserting "admission succeeds iff balance ≥ estimate" will be
subtly wrong for purchased wallets — the true gate is `balance − cushion ≥ estimate`. Any
test fixture that funds a wallet to exactly the estimate amount will unexpectedly fail
admission unless it also accounts for the cushion.
**Observability:** Not observable in any API response or DB row; purely an admission-time
computation over the Redis snapshot.

### B06 — The wallet-balance Redis snapshot is CAS'd on `ledgerSeq`, and bootstraps from Postgres on miss

**Statement:** Admission reads a Redis-cached balance snapshot; on cache miss it bootstraps
from the Postgres `wallets.balanceNanoUsd`/`ledgerSeq` row, and every write-through uses a
CAS that only applies if the incoming `ledgerSeq` is newer, so two racing settlements can
never regress the cached balance to a stale value.
**Citation:** `apps/api/src/slices/billing/domain/admission/admission.ts` (`resolveSnapshot`,
`bootstrapSnapshot`, `writeThroughSnapshot`, `refreshWalletSnapshot`) +
`apps/api/src/slices/billing/domain/admission/scripts.ts` (`SNAPSHOT_CAS_SCRIPT`) +
`packages/db/src/schema/wallets.ts:19-25` (`ledgerSeq` column comment: "advanced by every
balance-changing settlement write. The Redis balance-snapshot write-through CASes on it so
two racing commits can never regress the snapshot to an older balance").
**Sharp edges:** This is the exact mechanism that makes the Redis snapshot merely
_advisory_ (per ARCHITECTURE.md: "Money is never Redis-only... the ledger is truth") while
still being read for admission decisions — a test that races two settlements against one
wallet and only checks final Postgres state would miss a bug where the CAS is dropped and
the Redis snapshot (which the NEXT admission reads) regresses even though Postgres is
correct. `SNAPSHOT_TTL_SECONDS = 30` (`apps/api/src/slices/billing/domain/constants.ts`)
bounds how long a stale snapshot can survive if the CAS silently no-ops.
**Observability:** Only observable by reading the Redis key directly, or by inference — a
regressed snapshot would cause a subsequent admission to wrongly refuse (spendable computed
too low) or wrongly admit (too high) versus the true Postgres balance; no API response
surfaces the snapshot value directly.

---

## Settlement (the fenced transaction) & concurrency

### B07 — `runSettlement` is the ONLY place a `SettlementTx` handle is minted

**Statement:** The branded `SettlementTx` type can only be constructed by
`runSettlement(db, body)`, which opens exactly one `db.transaction(...)` and brands the
handle inside it — there is no other code path that can produce a value typeable as
`SettlementTx`.
**Citation:** `apps/api/src/lib/idempotency/settlement.ts` (`runSettlement`, full file).
**Sharp edges:** This is a type-system guarantee, not a runtime check — a test cannot
directly assert "no other code path can mint a SettlementTx" except by grep/lint (there is
reportedly a lint rule banning casts to the brand, per `apps/api/CLAUDE.md`: "casting to the
brand is lint-banned"). An E2E/integration proof of this property would have to be indirect
(e.g., assert every money-mutating function's signature requires `SettlementTx`).
**Observability:** Not observable from outside; purely a compile-time/lint-time property.

### B08 — Settlement concurrency model: READ COMMITTED, `FOR UPDATE` wallet lock, deliberately NO serialization retry

**Statement:** `chargeWithinTx` takes a `SELECT ... FOR UPDATE` lock on the wallet row
before reading/writing its balance (`lockWalletWithinTx`); the transaction runs at
Postgres's default READ COMMITTED isolation with no 40001 retry loop anywhere in the
settlement path; correctness under two concurrent same-wallet settlements rests entirely on
this row lock plus the deferred zero-sum trigger (B09).
**Citation:** `apps/api/src/slices/billing/adapters/stores.ts:199-211`
(`lockWalletWithinTx`, `.for('update')`) + `apps/api/src/slices/billing/domain/charge.ts:111`
(calls it inside `chargeWithinTx`).
**Sharp edges:** This is the single highest-value behavior in this file for a test suite,
because it is (a) load-bearing for money correctness under concurrency, (b) already proven
correct by an existing integration test with a genuinely rigorous method (blocking-wait
confirmation via `pg_stat_activity`, not a timing assumption), and (c) completely invisible
in the doc a naive test-writer would consult. A test suite that "improves" this by adding a
generic retry-on-conflict wrapper around settlement would silently defeat the row lock's
serialization guarantee and this existing test would need to be re-examined (not extended)
to keep proving the no-retry claim.
**Observability:** Not observable from an API response (an ordinary caller sees only two
successful charges, in whichever order the lock admitted them); observable only via
`pg_stat_activity` (test-only tooling) or via final ledger/wallet state consistency (no lost
update).

### B09 — The double-entry zero-sum constraint is a hand-written DEFERRABLE trigger, not a CHECK

**Statement:** Ledger balance is enforced per `transactionId` at COMMIT time by a
`DEFERRABLE INITIALLY DEFERRED` constraint trigger (`assert_ledger_transaction_balanced`),
not by an ordinary `CHECK` (which cannot span rows). It fires on INSERT, DELETE, and UPDATE
of the sum-bearing columns (`transaction_id`, `amount_nano_usd`, `wallet_id`,
`house_account`) — explicitly NOT on updates that only touch other columns, because
hard-deletion pseudonymization does `ON DELETE SET NULL` on `ledger_entries.payment_id` /
`usage_record_id` and must not re-trigger the balance check.
**Citation:** `packages/db/drizzle/0039_ledger-zero-sum-trigger.sql` (full file, esp. lines
1-16 comment and lines 47-52 the `CREATE CONSTRAINT TRIGGER`).
**Sharp edges:** Because the trigger is DEFERRED to COMMIT, an intermediate unbalanced state
WITHIN a still-open transaction is completely legal and unenforced — a test that tries to
assert "the ledger is always balanced" by querying `ledger_entries` from a _concurrent_
transaction mid-settlement would see a real, if `READ COMMITTED`-invisible until commit,
window. A test that inserts unbalanced legs and expects an immediate error (rather than an
error at `COMMIT`/`tx.commit()`) would get the wrong failure point. The column-scoped
`UPDATE OF` list is a second sharp edge: a future migration that starts writing to a
different sum-bearing column without adding it to the trigger's `UPDATE OF` list would
silently stop being checked.
**Observability:** Directly observable — an unbalanced transaction throws a Postgres
exception (`RAISE EXCEPTION 'ledger transaction % legs sum to %...'`) surfaced as a commit
failure; from the API, this would present as a settlement failure (500-class), never a
partial/successful money state.

### B10 — `usage_records.contentItemId` is nullable in the schema but the insert-time invariant demands non-null

**Statement:** The `content_item_id` FK column is nullable at the schema level (it goes
NULL later via `SET NULL` when the content is retention-pruned or the user is deleted), but
the _insert-time_ invariant enforced only by code discipline — not a DB constraint — is that
a `usage_records` row is never inserted without a live content item: "billed ⟹ the run
persisted content."
**Citation:** `packages/db/src/schema/usage-records.ts` (column definition + comment) cross-
referenced with `apps/api/src/slices/chat/domain/settlement/settlement.ts`
(`collectPersistableCharges()` reads the all-failed signal off _content_, not charge count, and a charge with no anchored
content item is described in BILLING.md §How the decision reaches the answer (The classifier's charge has no content of its own)
as "silently absorbed by the platform" — i.e., dropped before insert, never inserted with a null FK).
**Sharp edges:** This is exactly the kind of invariant a schema/DB-level test cannot catch
and only a behavioral integration test can: assert that every row freshly inserted into
`usage_records` during a settlement has a non-null `content_item_id` AT THE MOMENT OF
INSERT (querying after a later `SET NULL` retention pass would no longer show this). A
regression here would not throw — it would silently produce a billed-but-unpersisted usage
record, which is a silent money/privacy bug, not a crash.
**Observability:** Only observable via a direct DB query joining `usage_records` to
`content_items` at settlement time, or transitively if a user later requests their content
and it does not exist despite a charge existing — no API response codifies this invariant.

### B11 — `chargeWithinTx` is idempotent per usage-record insert and skips dimension writes on replay

**Statement:** `insertUsageRecordIfAbsentWithinTx` early-returns `{ alreadyCharged: true }`
without writing a fresh `llm_completions`/`media_generations` dimension row when the insert
conflicts (i.e., a retried settlement for the same idempotency key does not double-write the
per-generation detail row, only the parent `usage_records` row is deduped).
**Citation:** `apps/api/src/slices/billing/domain/charge.ts`
(`chargeWithinTx`/`insertUsageRecordIfAbsentWithinTx`/`writeGenerationDimension`, described
in the earlier-session read as "early-return with `alreadyCharged:true` if not created,
skipping dimension write").
**Sharp edges:** A test asserting idempotent replay must check BOTH tables — a bug that
regressed only the dimension-write skip (e.g., always writing `llm_completions` regardless
of `alreadyCharged`) would leave `usage_records` correctly deduped (unique constraint would
catch a true duplicate insert attempt) but silently create duplicate/extra
`llm_completions` rows on every retried settlement, which a `usage_records`-only test would
never see.
**Observability:** Observable only by directly querying `llm_completions`/`media_generations`
row counts against a known idempotency-key replay; no API response distinguishes a fresh
charge from a replayed one at this granularity (the caller-visible behavior — a 200 either
way — is identical).

### B12 — `writeGenerationDimension` writes exactly one of two tables, never both, keyed on modality

**Statement:** Every charge writes either an `llm_completions` row (text) or a
`media_generations` row (image/video/audio, matched against a `MEDIA_MODALITIES` set) — the
two are mutually exclusive by construction, not by convention.
**Citation:** `apps/api/src/slices/billing/domain/charge.ts` (`writeGenerationDimension`,
`MEDIA_MODALITIES` set dispatch, from the earlier-session full read).
**Sharp edges:** A future modality addition (per ARCHITECTURE.md: "a genuinely new modality
is one enum migration + one dispatch adapter") that is neither purely text nor added to
`MEDIA_MODALITIES` would silently write to neither table, or throw — a test suite should
pin the exhaustiveness of this dispatch (e.g., via the same `ts-pattern` exhaustive-match
discipline used elsewhere) rather than assume new modalities are automatically routed.
**Observability:** Directly observable by row presence/absence in the two dimension tables
per `usageRecordId`.

---

## The cost circuit and deadline stop

### B13 — Cost-circuit trip and deadline/user-stop are structurally different exit paths in the interpreter, not a shared "kill" function

**Statement:** `finalizeStopped()` (used for both the deadline alarm and explicit user
stop, `stopReason` distinguishing them) calls `this.settle(this.sinkOutputs())` when outputs
are non-empty — i.e., it bills the billable partial. `finalizeFailed()`, on the
`'cost-circuit-tripped'` outcome specifically, calls `captureCostCircuitTrip()` (the single
Sentry event) and does **not** call `settle()` at all — confirmed by direct code read, not
merely by the doc's assertion of the asymmetry.
**Citation:** `apps/api/src/slices/workflows/domain/engine/interpreter.ts` (`finalizeStopped`,
`finalizeFailed`, `captureCostCircuitTrip`, `boundary()`;
`boundary()`'s precedence is stop > deadline > circuit, and the file comment states the
exposure bound explicitly: `hold × K + (concurrent width) × max step cost`).
**Sharp edges:** `boundary()`'s precedence — stop beats deadline beats circuit — means a
circuit trip is only reachable if neither an explicit stop nor a deadline fired first at the
same boundary check; a test needs to construct a scenario where the circuit is the _first_
detected condition, not just where accrual exceeds `hold × 5` (a run that's also past its
deadline at the same boundary check would settle as a deadline stop, not a circuit trip,
because deadline is checked first). `runFanOut()`'s comment further states a THIRD
precedence ordering for the fan-out-specific coincident-boundary case (stop > circuit >
branch-failure) — different from the top-level `boundary()` ordering — so a fan-out
scenario and a non-fan-out scenario are not interchangeable test fixtures for this
precedence.
**Observability:** A cost-circuit trip is observable to a human ONLY via the single Sentry
event (fingerprint `workflow_cost_circuit_tripped`, carrying `runId` and
`absorbedNanoUsd` as allowlisted tags — never message content) — there is deliberately no
user-facing distinction between "circuit tripped" and any other failed-run outcome; the
client sees a generic failure with no charge. This makes the behavior essentially
unobservable from outside the system except via Sentry, which a test suite cannot assert
against directly without a Sentry-capture test double.

### B14 — `COST_CIRCUIT_MULTIPLIER` is a named constant with a stated safety margin, not a magic 5

**Statement:** `K = 5n`, with an explicit rationale in the source: "gives headroom above
the documented 4.4× estimate-undershoot worst case."
**Citation:** `apps/api/src/slices/billing/domain/constants.ts`
(`COST_CIRCUIT_MULTIPLIER = 5n`).
**Sharp edges:** None beyond B13's precedence sharp edges — this entry exists mainly to
pin the exact constant name/value/location for a test that wants to construct a
just-under/just-over-the-circuit-threshold fixture without hardcoding `5n` redundantly.
**Observability:** Same as B13 — Sentry-only.

---

## Trial quota and free daily allowance

### B15 — Trial admission is dual-gated on TWO independent identities (session token AND IP hash), both must admit

**Statement:** `consumeTrialQuota` spends an attempt against a per-session-id counter and a
per-IP-hash counter in the same call and admits only if BOTH counters allow it — a rotated
`x-trial-token` starts a fresh session count but the IP counter still catches the evasion.
**Citation:** `apps/api/src/slices/chat/domain/trial/quota.ts` (full file: module doc-comment + `TRIAL_QUOTA_SESSION_RATE_LIMIT`/`TRIAL_QUOTA_IP_RATE_LIMIT`, `consumeTrialQuota`,
`readTrialQuotaRemaining`).
**Sharp edges:** The reported `count` after a consume is `Math.max(session.count,
ip.count)` — i.e., what the client sees as "how many you've used" is the STRICTER of the two
identities, which can jump non-monotonically from the client's own perspective if its IP
changes mid-session (a NAT/VPN switch could make the displayed count jump upward even though
the client's own token has sent fewer messages). A test should cover session-rotated +
IP-unchanged (still blocked) and session-unchanged + IP-rotated (still blocked) as two
distinct scenarios, not just "quota exhausted."
**Observability:** `readTrialQuotaRemaining` is a separate read path from `consumeTrialQuota`
used for display — BOTH read the SAME two counters via the SAME stricter-of-two rule (module
comment: "the same verdict `consumeTrialQuota` enforces... so what the user sees and what
the send gate applies can never be two different rules") — this is a One-Implementation-
Shared pattern worth a direct equivalence test (display remaining count vs. actual send
admission never disagree). Externally observable via the `/trial/remaining`-style endpoint
(`c.json({ remaining: count })`, `apps/api/src/slices/chat/routes.ts:2012-2013`).

### B16 — Trial quota counters are abuse throttles: never cleared on success, refused attempts reserve nothing refundable

**Statement:** Unlike a secret-guessing rate limit (login, TOTP), the trial quota counters
never clear on a successful send — every attempt (allowed or refused) consumes toward the
same window, and a refusal has no compensating "give back" logic.
**Citation:** `apps/api/src/slices/chat/domain/trial/quota.ts` (module comment
explicitly states this classification, cross-referencing the two-class rate-limit doctrine
from `docs/CODE-RULES.md` §Security).
**Sharp edges:** A test that sends 5 trial messages, has one client-side-refused (e.g. a
concurrent second request that the server also refuses) might expect the refusal to not
count against the 5 — the code's design explicitly rejects that expectation. A test must
distinguish "attempts consumed" from "successful sends" when asserting remaining count.
**Observability:** Fully observable via `readTrialQuotaRemaining`'s returned count.

### B17 — The global trial daily spend cap ($50/day) is a read-and-compare gate, not a reservation — it can overshoot

**Statement:** `admitTrialSpend` reads the current day's cumulative counter and compares to
`TRIAL_DAILY_SPEND_CAP_NANO_USD` (50_000_000_000n nano-USD = $50) with NO admission-time
reservation; the module doc-comment explicitly states this is a deliberate choice ("a small
burst can overshoot; that is bounded by the per-message cost, and adding a reservation is
deliberately avoided").
**Citation:** `apps/api/src/slices/billing/domain/trial-spend.ts` (full file, esp.
lines 13-28 module comment, `admitTrialSpend`, `incrementTrialSpend`) +
`apps/api/src/slices/billing/domain/constants.ts`
(`TRIAL_DAILY_SPEND_CAP_NANO_USD = 50_000_000_000n`, comment: "a tunable abuse-mitigation
figure, not a correctness constant").
**Sharp edges:** Because this is read-and-compare (not reserve-and-settle like the per-user
Redis hold), a burst of concurrent trial runs that each read the counter BEFORE any of their
increments land could all be individually admitted even though their combined settled cost
pushes the day's total well past $50 — the overshoot is bounded only by "the per-message
cost" times the burst width, not by any hard ceiling. A concurrency test deliberately racing
several trial runs near the cap boundary is the only way to observe this; a serial test
would never trigger it.
**Observability:** The `crossed` flag from `incrementTrialSpend` fires exactly once — for
"the single increment whose atomic post-value first reaches the cap" (doc-comment,
`trial-spend.ts:49`) — this is the only signal a caller gets that the cap was just crossed;
subsequent increments past the cap report `crossed: false` (already over, not newly
crossing). A test must distinguish first-crossing from subsequently-still-over.
**Observability of the amount itself:** `incrementTrialSpend` folds in the run's ACTUAL
provider cost (not the admission estimate) — this is the same accrual value the interpreter
tracks — passed as a decimal string across the Redis boundary specifically so money is never
Number-coerced (comment, `trial-spend.ts:73-75`).

---

## Member budgets and conversation spending

### B18 — Group-owner-funded attribution is resolved server-side inside settlement, not client-declared

**Statement:** `resolveMemberBudgetAttribution()` accrues group spend ONLY for
owner-funded group turns (never solo turns, never "personal fallthrough" turns), and this
determination is made from `deps.ownerFunded` resolved server-side inside the settlement
transaction — the client cannot declare or influence which funding mode a turn used.
**Citation:** `apps/api/src/slices/chat/domain/settlement/settlement.ts`
(`resolveMemberBudgetAttribution`).
**Sharp edges:** A test that only asserts "member budget increments on a group turn" without
distinguishing owner-funded vs. solo-in-a-group-conversation vs. personal-fallthrough would
miss a regression where any of the three non-owner-funded cases wrongly accrue group spend
(over-attribution) or the owner-funded case wrongly skips it (under-attribution, which
would let a group member exceed their real budget without the ledger ever showing it against
the member-budget scope — though the wallet-level charge would still be correct, since
member budgets are an ADMISSION-scope construct, not a separate money pool; see B19).
**Observability:** Directly observable via `member_budgets`/`conversation_spending` row
deltas after a settled turn, correlated against the turn's funding mode.

### B19 — Absent member/conversation budget caps DENY (0 remaining), not "unlimited"

**Statement:** `resolveBudgetScopes()` treats a missing budget-cap row as a hard deny: for
member scope, `row === null ? 0n : ...` (zero remaining, not "no cap"); for conversation
scope, an absent configured budget yields `capNanoUsd = 0n` (also a hard deny, "no configured
budget" is stated in the code comment to mean zero remaining, i.e., refused, not unbounded).
**Citation:** `apps/api/src/slices/billing/domain/budgets/budget-resolution.ts`
(`resolveBudgetScopes`, `clampNonNegative`).
**Sharp edges:** This is exactly the kind of default a naive test-writer gets backwards. A
budget-scope test suite MUST include: (a) a member/conversation with literally no budget row
at all → turn refused, not admitted; (b) a member/conversation with an explicit zero-cap row
(if that's even a distinct state from "no row") to check whether the two are actually
distinguishable or collapse to the same refusal.
**Observability:** `member-budget-exceeded` / `conversation-budget-exceeded` admission
refusal codes; the underlying "why" (no row vs. exhausted row) is NOT distinguished by the
wire code the two cases collapse to (`BUDGET_REFUSAL_BY_KIND` mapping, `admission.ts`).

### B20 — `memberBudgetScopeId`/`conversationBudgetScopeId` derivations are shared between the admission gate and the display-side scope-holds reader

**Statement:** The exact scope-id derivation used to check a budget at admission time is
the SAME function used by whatever surface displays "holds against this scope" to a caller
(module comment on `budget-resolution.ts`: "the ONE derivation... shared by the gate... and
the display-side scope-holds reader").
**Citation:** `apps/api/src/slices/billing/domain/budgets/budget-resolution.ts`.
**Sharp edges:** A One-Implementation-Shared pattern (per `docs/CODE-RULES.md`) — if this
sharing is ever broken (a display path re-derives its own scope id), gate and display could
silently diverge on which budget row they're keyed against. A regression test would need to
assert display-shown remaining budget and admission-checked remaining budget agree for the
same member/conversation, not merely that each independently "looks right."
**Observability:** Both paths' output is externally visible (admission refusal vs. displayed
remaining budget); a divergence would show up as "the UI said I had budget left but the send
was refused" or vice versa — a genuinely user-facing symptom, making this a good E2E
candidate even though it was found via code reading.

---

## Payments — pre-claim, webhook, verify job, disputes

### B21 — Payment pre-claim uses `byExternalPreClaim`; webhook and delayed verify job both independently reconcile the SAME row

**Statement:** `payments` rows are pre-claimed (status `pending`) before the card charge is
attempted; `applyCompleted()` (webhook path) and `verifyPayment()`/`payment.verify.v1` (the
delayed job path) both call into the SAME atomic claim+credit primitive
(`completeAndCreditPayment`), so whichever of the two arrives first wins and the second is a
no-op — there is exactly one exactly-once reconciler, reached from two different triggers.
**Citation:** `apps/api/src/slices/billing/domain/payments/payment-webhook.ts` (`applyCompleted`) + `apps/api/src/slices/billing/domain/payments/payment-verify.ts`
(`completeAndCreditPayment`, `resolveChargedPayment`, `reconcileOrExpirePending`,
`reconcileFoundCapture`, `verifyPayment`) +
`packages/db/src/schema/payments.ts` (`status` enum, `idempotencyKey` unique,
`helcimTransactionId` unique).
**Sharp edges:** `reconcileOrExpirePending`/`reconcileFoundCapture` explicitly handle the
"process died between capture and record" case via merchant-reference lookup — this is a
genuine crash-recovery path, not a happy-path reconcile, and needs its own test: kill the
process (or simulate it) between Helcim capture and the `payments` row transition, then let
the delayed `payment.verify.v1` job run and confirm it finds the orphaned capture via
merchant reference rather than either double-charging or leaving the payment stuck pending
forever.
**Observability:** `payments.status`, `payments.webhookReceivedAt`, and `payments.errorCode`
(codes only, never content per CODE-RULES telemetry doctrine) are all directly queryable;
the wallet credit is observable via the `ledger_entries`/`wallets.balanceNanoUsd` delta.

### B22 — Chargeback auto-defense is one atomic settlement: clawback legs + account lock + session revocation + job enqueue, all-or-nothing

**Statement:** `applyDisputeToPayment` fires the account-lock, session-revocation enqueue,
and both clawback ledger legs (`postClawbackWithinTx`) inside the SAME settlement
transaction; per the code comment, "a lock (or enqueue) failure throws and rolls the
clawback back... the provider redelivers and re-drives all three together" — i.e., partial
defense (e.g., money clawed back but account not locked) is structurally impossible, not
merely unlikely.
**Citation:** `apps/api/src/slices/billing/domain/payments/payment-webhook.ts`
(`applyDisputeToPayment`, `postClawbackWithinTx`, `enqueueChargebackRevokeWithinTx`) + `packages/db/src/schema/enums.ts` (`userLockReasonEnum`,
"Chargeback auto-defense vs explicit admin lock").
**Sharp edges:** Auto-defense fires ONLY for chargeback/reversal on `completed` payments;
a dispute event on a non-`completed` payment (e.g., still `pending`/`awaiting_webhook`) is
notify-only in `applyDisputeToPayment` — a test suite must cover
BOTH the completed-payment-disputed (full defense fires) and non-completed-payment-disputed
(notify only, no lock, no clawback) cases as genuinely different code paths, not variations
of the same one. The dedup keys (`clawback:{paymentId}:user` / `:house`) mean a REPLAYED
dispute webhook for the same payment must be a true no-op (idempotent), which is a distinct
assertion from "the defense fired correctly the first time."
**Observability:** `users.lockedAt` + `userLockReasonEnum` directly queryable; session
revocation observable via subsequent authenticated requests failing; clawback legs
observable in `ledger_entries` with the deterministic dedup idempotency keys.

---

## Fee-baking seams and the shared estimator

### B23 · The fee-baking seams round differently, and the asymmetry is deliberate

**Statement:** Catalog-ingestion rate baking uses `applyMarkupCeil` (rounds up, against the
user, so a stored billable rate is never below the true 1.15× provider rate); the
ModelProvider port's per-call cost conversion uses `applyMarkup`/`providerUsdToBillableNanoUsd`
(half-even/banker's rounding). Both apply the SAME `MARKUP_BASIS_POINTS = 1500n` (15%) rate;
only the rounding function differs, by design, per seam.
**Citation:** `packages/shared/src/affordability/money/money.ts` (`applyMarkup`, `applyMarkupCeil`,
`MARKUP_BASIS_POINTS = 1500n`, `roundHalfEvenDiv` — comment on
`applyMarkupCeil`: "rounds AGAINST the user... a stored billable rate is never below the
exact 1.15× provider rate — estimates built on it can only over-reserve. Half-even stays
reserved for the port's charge conversion.") + call sites: catalog ingestion at
`apps/api/src/slices/models/domain/catalog/normalize.ts`
(`applyMarkupCeil(BigInt(providerRate)).toString(10)`), port conversion at
`apps/api/src/slices/billing/domain/money.ts`
(`providerUsdToBillableNanoUsd(usd) = applyMarkup(usdToNanoUsd(usd))`, with
`assertMarkupMatchesSharedRate()` as a module-init fail-fast guard at line 40 asserting
`MARKUP_BASIS_POINTS` matches the compile-time constant).
**Sharp edges:** This is a "one implementation, shared" edge case worth calling out
precisely because it is a DELIBERATE exception to sharing the same rounding function — a
future refactor that "simplifies" by unifying both seams onto one rounding mode (most likely
half-even, since it's "more correct" in isolation) would silently make catalog rates
occasionally round DOWN below the true markup, which is the exact bug the ceil choice exists
to prevent. A test must assert BOTH functions independently at boundary values (exact
half-cent nano-USD amounts) rather than treating them as interchangeable "the markup
function."
**Observability:** Directly observable — catalog rates are visible via the models slice's
public catalog endpoint; per-call converted costs are visible in `usage_records.costNanoUsd`
and `llm_completions`/`media_generations` rows.

### B24 — The estimator is genuinely ONE shared implementation across admission, settlement, and (inferred) client display

**Statement:** `apps/api/src/slices/models/domain/pricing/estimate.ts` — the server module used for
BOTH admission-ceiling pricing and settlement's `isEstimated` fallback pricing — is a thin
adapter that imports its actual pricing logic (`callManifest`, `estimateRunCeilingNanoUsd`,
`evaluateManifest`, `declaredCeilingError`) directly from
`@hushbox/shared/affordability/estimate/run-ceiling`, explicitly stating in its module
comment: "Every cost formula (per-token sums, media rate × units, the ceiling multiplier)
lives ONCE in the shared estimator core inside the money layer; this module is the thin
server adapter."
**Citation:** `apps/api/src/slices/models/domain/pricing/estimate.ts` (full file, esp. lines 1-32
module comment and imports) + `packages/shared/src/affordability/estimate/index.ts` (the
published surface, confirming `textTurnBudget`, `mediaTurnCostNanoUsd`,
`effortSelectionForTurn` are the three producers a caller — client or server — asks its
question through).
**Sharp edges:** `apps/web/src/hooks/billing/use-budget-calculation.ts` and
`use-media-cost-estimate.ts` and `use-reasoning-effort.ts` (grep-confirmed importers of
`textTurnBudget`/`mediaTurnCostNanoUsd`/`effortSelectionForTurn`) are the CLIENT side of
this sharing — this is genuinely cross-package (apps/web ↔ apps/api both importing
`packages/shared/src/affordability/estimate/`), the exact pattern CODE-RULES' "One
Implementation, Shared" section calls out as strongest at that boundary. A test suite
proving this property would want a single fixture (a `WorkflowDefinition` + pricing input)
priced through BOTH the client hook and the server's `createEstimateRun`/`estimate.ts` path
and assert byte-for-byte nano-USD equality — this is the strongest possible test for the
shared-estimator claim.
**Observability:** The client-displayed estimate and the server admission hold are both
externally visible (composer UI cost display; admission refusal amount in error responses);
a divergence between them would be directly user-visible as "the app said this would cost X
but I got refused/charged Y."

### B25 — Image pricing is deterministic-exact by construction; text/video ride authoritative inline provider cost with a fallback

**Statement:** Image generation is charged at the deterministic catalog rate
(`priceMediaBillableNanoUsd` via `imageCallUsage`, always `n=1` — multi-artifact requests are
REFUSED, not partially priced) because OpenRouter's images API returns no inline cost at all;
text and video instead carry OpenRouter's authoritative inline `usage.cost`, converted via
the half-even port seam (B23), falling back to the catalog estimate over observed usage
(flagged `isEstimated` + a Sentry alert) whenever the inline figure cannot stand as the
whole run's cost (RESV-5) for those two modalities.
**Citation:** `apps/api/src/slices/models/domain/pricing/estimate.ts:106-166`
(`requireSingleArtifact`, `imageCallUsage`, `videoCallUsage`) — grep-confirmed against
`apps/api/src/slices/models/adapters/image-adapter.ts` (lines ~22-121, no inline cost from
the dedicated images API) — cross-checked against BILLING.md §Billing Flow (usage.cost)
("OpenRouter returns the charged `usage.cost` inline for text and video") and
BILLING.md §Principles (Reservation mechanics) ("estimated, `isEstimated`, no reconcile);
video per-second × resolution; storage via fixed... implausible (sanity-multiple) inline cost
falls back to the billable catalog estimate, flagged `isEstimated` plus one Sentry alert").
**Sharp edges:** `requireSingleArtifact`'s hard refusal on `n > 1` (`"Media call parameter
'n' must be 1: one generation call, one artifact"`) is a founder ruling stated directly in
the code comment ("A multi-artifact request (`n > 1`) is refused fail-closed: admission
would under-reserve by n× and the node accumulator persists a single artifact, so pricing n
would bill artifacts the run never keeps") — a test must confirm this is a hard VALIDATION
refusal at build/admission time, not a runtime truncation to one artifact. The "implausible
(sanity-multiple) inline cost falls back" behavior for text/video
(BILLING.md §Principles (Reservation mechanics)) is a genuinely interesting edge: it
means an OpenRouter-reported cost that is absurdly high (beyond some sanity multiple)
is treated as if it were MISSING and replaced with the deterministic estimate — a
test constructing a mock provider response with a wildly inflated `usage.cost` should
trigger the fallback path, not a pass-through charge of the inflated amount.
**Observability:** `usage_records.isEstimated` is a direct, queryable signal distinguishing
which pricing path was used for any given charged row.

---

## Multi-model turns

### B26 — `anchorChargeKey` is the SAME three-rule resolution shared by the wallet-debit path and the display-aggregation path

**Statement:** `anchorChargeKey()` — own key → base node with `#index` suffix stripped →
run's first-persisted-content charge in `runChargeKeys` order — is invoked identically by
`createChargingCommit` (actual debit) and `aggregateDisplayCostByKey` (what the client sees
as "cost of this message"), guaranteeing debit and display can never structurally diverge
for the same run.
**Citation:** `apps/api/src/slices/workflows/domain/engine/settlement.ts` (`anchorChargeKey`,
`createChargingCommit`, explicit doc comment: "a charge
cannot be debited against one content item and displayed on another") +
`apps/api/src/slices/chat/domain/settlement/settlement.ts` (`aggregateDisplayCostByKey`, from
doc comment: "display total = Σ every charge anchored to a content item via the
SAME `anchorChargeKey` rule the debit path uses").
**Sharp edges:** This is another One-Implementation-Shared pattern (like B20) — the sharp
edge is identical in kind: a future change to either `createChargingCommit` or
`aggregateDisplayCostByKey` that stops calling the shared `anchorChargeKey` (e.g., inlines a
"simpler" resolution for display-only purposes) would silently break the guarantee. A test
suite should assert debit-total and display-total equality directly on a multi-model-turn
fixture, not merely that each individually "looks reasonable."
**Observability:** Both sides fully observable — display cost is API-response-visible (the
chat message payload), debit is `usage_records`/`ledger_entries`-visible; a divergence would
be a directly user-visible "the cost shown doesn't match what I was charged" bug, an
excellent E2E candidate.

### B27 — A multi-model turn where ALL siblings fail persists and bills NOTHING; where SOME fail, it bills the successful subset

**Statement:** `collectPersistableCharges()` throws `AllBranchesFailedError` when every
sibling fails (nothing persisted, nothing billed); when a subset fails, only the successful
subset is persisted and billed. This exact behavior is already covered by existing unit
tests in the interpreter test file, named explicitly for it.
**Citation:** `apps/api/src/slices/chat/domain/settlement/settlement.ts` (`collectPersistableCharges`,
`AllBranchesFailedError` import).
**Sharp edges:** Since this is ALREADY unit-tested at the interpreter level, the sharp edge
for an E2E/integration proof suite is different from most entries here: the risk is not "this
behavior is unverified" but "this behavior is verified ONLY at the interpreter-unit level,
never through a real multi-provider HTTP round trip with genuine partial-failure timing" —
i.e., whether the E2E layer has an equivalent proof that a REAL run against real (or
cassette-replayed) providers, with one provider genuinely erroring mid-stream, produces the
same successful-subset billing outcome end-to-end, including the correct wire-visible
message set and cost display.
**Observability:** Fully observable — persisted message count, per-message model/cost
fields, and `usage_records` row count are all API/DB visible.

---

## The stop path and the deadline mechanism

### B28 — User-cancel and deadline-stop are THE SAME code path (`finalizeStopped`), distinguished only by `stopReason`

**Statement:** The `/stop` HTTP route resolves the caller through the in-handler credential
gate and passes it to the room: `RoomCore.stopRun(caller)` refuses unless the caller is the
run's sender or its payer (`stopAuthorized` — a member with no money at stake must not be
able to trigger a settlement that bills the payer), then calls
`this.runControl.stop('user-stop')` — the identical `runControl.stop(...)` entry point the
deadline alarm uses (with a different reason string), both terminating in the interpreter's
`finalizeStopped()`, which settles the billable partial if any outputs exist. There is no
separate "cancel" code path distinct from "deadline stop" at the settlement layer — only
the `stopReason` tag differs.
**Citation:** `apps/api/src/slices/chat/routes.ts:1627-1641` (`/stop` handler,
`routeClass('public')`, in-handler credential gate via `resolveGuestSenderOrRefusal`) +
`packages/realtime/src/room-core.ts:311-316` (`stopAuthorized`: the run's sender or its
payer, nobody else) + `packages/realtime/src/room-core.ts:770-775`
(`stopRun(caller: SenderPrincipal): RunStopOutcome` — `'stopped' | 'no-run' | 'refused'`) +
`apps/api/src/slices/workflows/domain/engine/interpreter.ts` (`finalizeStopped`:
"A stopped run settles its billable partial — exactly like an explicit stop").
**Sharp edges:** `/stop` is deliberately `routeClass('public')` (not `session`) — the
in-code comment explains this is because the HTTP route-class matrix admits no link-guest
principal at all, so a guest reaches its own run only through the SAME in-handler credential
gate (`resolveGuestSenderOrRefusal`) that `/send` uses — "no revocation predicate exists
twice." A test suite must verify a guest CAN stop its own run (not just an authenticated
member) and CANNOT stop a different conversation's run despite the route being `public`-
classed. Authorization is the room's, not the route's: membership admits the caller to the
handler, but `stopRun` refuses a caller who is neither the run's sender nor its payer — on
a self-funded run even the conversation's owner is refused, because owning the conversation
confers no authority to bill another member's wallet. The comparison runs inside the
Durable Object against principals retained at run claim: only the room holds the run live
at the instant of the stop, so a comparison anywhere else would race run turnover. Also:
`heartbeatTick`'s zombie-stop path (`packages/realtime/src/room-core.ts:735-748`) calls the
exact same `this.runControl.stop('user-stop')` for an entirely different reason (a
heartbeat lease loss, "a retry superseded this run's claim... stopping only saves provider
spend") — meaning `stopReason: 'user-stop'` is used for BOTH a genuine human-initiated stop
AND a system-detected zombie-run stop; if any downstream code (billing notices, analytics)
branches on `stopReason === 'user-stop'` to mean "a human clicked stop," it would be wrong
for the zombie case. This is a real terminology collision worth a dedicated test asserting
both trigger paths settle identically (which they should, by construction) while any
user-facing copy that says "you stopped this run" is NOT shown for the zombie case.
**Observability:** Fully observable — the `/stop` response (`{ stopped: boolean }`, with a
refused stop surfacing as a forbidden error response, never `stopped: false`), the partial
content that gets persisted and billed, and (if it exists) any UI copy distinguishing "you
stopped this" from a silent zombie-recovery stop.

### B29 — A repeated `/stop` call is a benign no-op (`stopped: false`), not an error

**Statement:** `RoomCore.stopRun()` answers `'no-run'` once the run is already gone
(completed, already-stopped, or never started) — one of its three outcomes,
`'stopped' | 'no-run' | 'refused'`. The room's stop endpoint folds `'no-run'` into
`{ stopped: false }`, so the route always responds `200` with `{ stopped: didStop }` for a
stale/duplicate stop request, never an error; only `'refused'` — B28's authorization
answer — surfaces as an error (403).
**Citation:** `apps/api/src/slices/chat/routes.ts:1619-1620` (comment: "a repeat is a no-op
(`stopped:false` once the run is gone)") + `packages/realtime/src/room-core.ts:763-775`
(`stopRun` doc comment: "`no-run` and `refused` stay distinct answers — a repeat stop on a
finished run is a benign no-op, an unauthorized one is a refusal") +
`packages/realtime/src/conversation-room.ts:334-340` (`'refused'` → 403, everything else →
`{ stopped: outcome === 'stopped' }`).
**Sharp edges:** A test asserting "stop bills the partial" must also assert that a SECOND
stop call against the same (already-settled) run does NOT attempt to bill again — this is
implicitly guaranteed by the run being gone from `runControl` by the time the second call
arrives, but a race (two near-simultaneous stop calls) is worth a dedicated concurrency test
given how much money-correctness in this codebase rests on "only one settlement per run."
And the no-op must stay distinguishable from the refusal: a `403` (B28) is never
`{ stopped: false }`, so a test that accepts an error response where it expected the benign
repeat would let an authorization break pass as a stale stop.
**Observability:** The HTTP response distinguishes all three outcomes — `200` with
`stopped: true`, `200` with `stopped: false`, and a `403` refusal (B28's error surface).

---
