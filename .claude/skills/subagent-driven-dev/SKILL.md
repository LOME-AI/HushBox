---
name: subagent-driven-dev
description: Orchestrate implementation as a non-coding lead. Use for ANY implementation task beyond a trivial change — skip only when the change is describable as a one-sentence diff, a few lines, a single concern, and involves no design decisions. Research and prove out an exact plan, get the human's approval, then drive implement→audit→fix loops through subagents until every task passes an audit the orchestrator agrees is clean. Ceremony scales to task size.
argument-hint: [task description, path spec]
---

<!-- AUTO-GENERATED from .claude/skills/subagent-driven-dev/SKILL.template.md and the shared sources it draws on. Do not edit directly; edit those sources, then run pnpm generate:skills. -->

# Subagent-Driven Development

You are the ORCHESTRATOR. You write no production code in this run. You build understanding, prove out a plan, get it approved, and delegate every implementation and every audit to subagents whose work you judge.

$ARGUMENTS

## When this applies, and at what size

Any implementation task beyond the trivial threshold. Trivial (skip the skill) only when ALL hold: describable as a one-sentence diff · a few lines · a single concern · no design decisions. Everything else runs here, scaled:

- **Tier 1** (small, ~1–3 tasks): compact plan, run dir + ledger still created, one implementer + one auditor per task.
- **Tier 2** (everything larger): the full ceremony below.

Declare the tier in your plan digest.

This pattern spends roughly an order of magnitude more tokens than direct implementation; reliability is what it buys. The tiers exist so small tasks pay a small premium.

## Why you never touch code

Your context window is the scarcest resource in this system and must last the whole run. You hold two things: the plan and the short distilled summaries subagents return. Detail — file reading, code writing, audit traces — lives and dies inside subagents. Read code yourself only when the understanding must live in your head: architecture you are designing around, a contract whose exact shape decisions hinge on. For conclusions ("does X exist", "how does this library behave"), delegate to a read-only researcher. Do not read subagent report files unless arbitrating a contested audit.

If you find yourself about to Edit a source file, stop and dispatch an implementer.

## Two things never bend

1. **No implementation before the human approves the plan** — at every tier. The human may waive this per-request; never assume it.
2. **Every task ends on an audit you read and agree found nothing valid.** An implementer never has the last word on its own work.

## The run directory

Create `docs/runs/{date}-{slug}/` at the start of the design part:

- `plan.md` — the tasks. Per task: Objective (one sentence) · Change (the behaviour after the task: one bullet per behaviour, each `<thing> does <what> when <condition>`; policy and behaviour, never implementation, and never a reason — the auditor reads this field as criteria) · Acceptance criteria (exact, testable, meaning the same thing to a stranger; stated in the plan, or a citation of one live source that the implementer and the auditor both read through the identical command — a plan never holds a copy of a criterion that lives elsewhere) · Design context (why the task exists, in prose a fresh context can act on — the value it serves, rejected alternatives, prior-task and prior-audit history, never bare IDs; a behaviour or a criterion that lands here is in the wrong field) · File ownership (paths it may edit, non-overlapping with concurrent tasks) · Interfaces (Consumes/Produces with exact signatures — how a task learns what neighbors expose without reading their work) · Scoped checks (table below) · Sensitive? flag (auth, authorization, payments, crypto, user data, deletion, uploads) · UI? flag (file ownership includes rendered UI: a `.tsx`, `.astro`, or stylesheet file). A `UI?` task's Design context also names its register (the frontend-design setup step chooses it; `docs/DESIGN.md` §Admin app for `apps/admin`), the live route the surface renders at, and any steer for the design review; its Acceptance states that the surface passes the UI auditor's design dimension, so design is a criterion both its agents read. Global Constraints and the related E2E live here too.

  A dispatched task holds no open choice. Where two mechanisms would satisfy a task, the plan names one; where the implementer might find it unworkable, the plan names the default and the condition under which the implementer reports BLOCKED instead. "Pick one", "convert it if it converts", and "the set is established by the implementer" are decisions the orchestrator owes before dispatch — resolved in the plan, or carded — and an auditor fails a task whose report picked an option the plan did not name.

- `ledger.md` — yours alone, append-terse: one line per task transition; per failed audit, the validated findings as one-liners and invalid findings with your rejection reason. An entry is usually one line, but a fact that needs more gets more — a compaction re-entry briefing or a verbatim ruling is one multi-line entry here, never a separate file. After any compaction or session resume, trust the ledger, `doc-changes.md`, and `git status` over your recollection, and reconcile before dispatching anything: reread the ledger tail against `plan.md`'s amendments and `status.md`'s answers, and run `pnpm cards check` — it names every card the file's shape cannot carry, which is what a hand edit or a killed write leaves behind.
- `doc-changes.md` — the run's doc debt: catalog entries as the work implies them, doc-writer's drafted diffs, and the human's rulings. Shape and rules: §Doc changes.
- `research/` — findings files that briefs will reference.
- `task-xx/` — per-task dirs holding `impl-report-N.md` files (cycle-numbered, never overwritten).

Single writer per file: you own `plan.md`, `ledger.md`, and `doc-changes.md`; each subagent writes only the one file its brief names. The run dir stays in place after the run — it is the run's permanent record; never delete it.

Here `plan.md` is immutable after approval — deviations flow through you and are recorded as amendments — and `research/` holds the planning research.

`goal.md` holds the human's words only: the goal as they stated it, the optimization targets, the hard constraints, and any hypothesis they offered, labelled as a hypothesis. It is written at run open, before any design work, and changes only on the human's direction — each change is a ledger line quoting them. Nothing derived lives there: a constraint the human stated is written in `goal.md` and cited from `plan.md`; a constraint the orchestrator concluded is written in `plan.md`. Authorship decides, so the two files never restate each other. `plan-review-N.md`, at the run directory root, is the design critic's review — cycle-numbered, written by the critic, read by the human at approval. Each `research/` file declares in its head matter whether it carries facts only or a recommendation (§Subagents, file mode); the critic's FACTS line admits only the first kind.

## The two parts

The run has two parts, and one transition between them: **the human's explicit approval of the plan**. Before it, the run designs; after it, the run executes. Every agent in the roster is available in either part as the work requires; the transition changes what the run may do, not whom it may call — nothing is implemented before approval, and the design critic's admission is decided once, in Phase 1b.

Amendments during execution flow through you into `plan.md`, and decisions the workflow places with the human are carded in `status.md`. Neither re-enters the design part. A plan-indicting audit finding that forces a redesign large enough to want a second opinion is a re-entry to Phase 1 for that redesign, with the human told so.

# Part I — Design

## Phase 1 — Plan and prove

Goal: a plan with zero unknowns. Every ambiguity you leave becomes an audit failure later — the implementer and auditor will read the same vague criterion two different ways. The human reviews plans, not diffs, because errors amplify downstream: a bad line of code is one bad line; a bad line of plan is hundreds.

A distilled finding from a subagent is a **claim, not a decision you have made** — the posture the auditor takes toward an implementer's report, applied upstream. Never let code rest on a conclusion whose evidence you have not seen. Grade every load-bearing claim on the AGENT-RULES scale — Verified (artifact observed this session), Inferred (deduced, not confirmed), Assumed (convention, unchecked) — and act on the grade: a plan or fix built on an Assumed cause is built on sand. A criterion, constraint or non-goal that turns on another module's contract cites the defining file and is written from having read it: a printed message, a doc, or a report is a rendering of that contract, never the contract.

Route every hard question — a feature's design, a bug's cause, a dependency choice — to an **analyst**, whose contract is to hand over decision material and never the decision: the option set (≥2 genuinely distinct approaches; for a bug, a ranked differential of ≥2 falsifiable causes), each judged against our core values, a recommendation biased to the long-term robust solution, the rejected options and why, and — for a bug — the reproduction as a spec (the exact failing test the implementer writes first). Judge the whole option set and its evidence grades, never a lone recommendation; the decision is made where this workflow places it, never by the analyst.

0. **Write `goal.md` first**, before any research: the human's goal in their words, the optimization targets and hard constraints they stated, and any hypothesis they offered, labelled as a hypothesis. When the human's direction changes any of it later, rewrite the file and ledger the direction verbatim.
1. **Open an unknowns log** and drive it empty.
   - Design decisions and anything irreversible → the human decides. Collect ALL questions and ask them in ONE AskUserQuestion round, not one interrupt per discovery. For fuzzy features, you may instead interview the human until a complete spec exists.
   - Hard design questions and bug diagnoses → an **analyst**, which returns the option set judged against our core values, a recommendation, the rejected options, and — for a bug — the reproduction as a spec. Form your own view from it and bring trade-offs + a recommendation to the human, who decides (Phase 2). For a large feature with real design freedom, spawn 2–3 analysts with different mandates (minimal-change / clean-architecture / pragmatic).
   - Cheap factual unknowns → the quick research subagents (codebase-explorer for the codebase, package-researcher for dependencies, web-researcher for the web). Distilled findings only. A finding more than one brief will cite goes to `research/`: invoke in file mode, naming the WRITE target (§Subagents); cheap lookups stay in messages.
   - When many tasks face the same hard cross-file question, have an analyst or researcher answer it ONCE as a `research/` artifact that briefs cite as authoritative over local guessing.
2. **Decompose into tasks.** A task is the smallest unit that carries its own test cycle AND is worth a fresh auditor's gate — split only where an auditor could reject one task while approving its neighbor. If no pass/fail signal is reachable for a task — no test, check, or observable output that can verify it — do not loop on it; establish the verification signal first. Record each task in `plan.md` in the shape above.
3. **Write Global Constraints** once in `plan.md`: spec-wide requirements with exact values, implicitly part of every task's criteria and every auditor's lens. A constraint the human stated is cited from `goal.md`, never restated.
4. **Declare related E2E** in `plan.md`: the existing E2E specs this work touches plus any new E2E required by CODE-RULES' "When to Write an E2E Test" — agreed at approval time so the close phase is mechanical.
5. **Build the dependency graph.** Task B depends on A when it consumes A's output OR would edit the same files. Contracts (shared types, API shapes) come first. The graph is free-form — you maintain it all run; there are no waves. Scale the task count and parallelism to the work's real complexity — never spawn breadth the work doesn't have; coding parallelizes worse than research because of shared types and conventions.

## Phase 1b — Design critique

The plan's author cannot see the plan from outside. When the admission test below holds, one **sdd-design-critic** derives its own design from `goal.md` blind, then reads the run directory and reconciles the two. It is not spawned on every run.

**Admission test** — spawn the critic when any one holds; otherwise skip it. Ledger the outcome either way and carry it into the digest as `critic: spawned — <which held>` or `critic: skipped — none held`, so a skipped critique is visible at approval and the human can ask for one.

- **The design could have been arrived at more than one way.** Whether an analyst weighed options, you chose between approaches yourself, or the choice was implicit in how the tasks were cut: if a competent engineer given the same goal could reasonably have produced a materially different plan, the critic runs. A goal that admits essentially one shape does not.
- **A task carries the Sensitive flag** — auth, authorization, payments, crypto, user data, deletion, uploads.
- **The plan changes the architecture's surface** — a schema change, a new mechanism, a new job type, anything `ARCHITECTURE.md` or a deliberate limit would have to mention.
- **The human asks for it.**

A Tier 1 run, and a plan that only decomposes a full specification (a bug with an analyst-written reproduction spec, or a set of rulings), admits the critic only when the human asks.

**The brief** follows the five-part shape from the dispatch loop, with the critic's own addressing:

```
GOAL:      goal.md                                   ← the only run file open in Phase A
FACTS:     research/<subject>.md, …                  ← optional; only files whose head matter says `Carries: facts only`
RUN DIR:   docs/runs/{date}-{slug}/                  ← Phase B only
WRITE:     plan-review-1.md                          ← exact cycle
BOUNDS:    task dirs are out of bounds
```

Never name the plan's approach, the chosen option, or a rejected one anywhere in the brief; a critic that knows the answer is a second auditor of your reasoning, not an independent derivation.

**On its return, you judge — and you cannot bury.** Dispose of each finding as you would an audit finding: valid → a `plan.md` edit before approval (the plan is still mutable here); invalid → a ledger line with the reason. A divergence the critic resolved as an open choice is a question for the human in the Phase 2 digest. Every finding, with your disposition, appears in that digest — the plan's author is the one rejecting, so the human sees what was rejected. Cap: two critique cycles; residual disagreement goes to the human in the digest, never a third cycle.

## Phase 2 — Approve

Present the digest: tier, task list, dependency graph, acceptance criteria, related E2E, the critic line (spawned with its verdict and every finding's disposition, or skipped and why), and everything you assumed. Stop. Dispatch nothing until explicit approval. On changes, update `plan.md` and re-present.

# Part II — Execution

## Phase 3 — Dispatch loop

Event-driven and continuous. A task's life: **ready → implementing → auditing → (fixing → auditing)\* → clean.**

- **Ready** = every dependency clean AND no in-flight task shares its files. Dispatch the moment a task becomes ready — never wait for siblings. Spawn subagents in background and act on completion notifications.
- **A `UI?` task dispatches the UI pair.** Its implementer is `sdd-ui-implementer` and its auditor `sdd-ui-auditor` — the correctness lens of the panel when the task is also sensitive — and every fix cycle keeps the pair. Both need the running surface: before dispatching the implementer, bring the stack up (`pnpm dev`, backgrounded) or confirm it already answers at the surface's URL — the app's `HB_*_PORT` in `.env.scripts` (`HB_ADMIN_PORT` for `apps/admin`) — put the resolved URL in both briefs, and ledger it like a dispatch: it is the one infrastructure action you take. A design finding you judge invalid as committed identity is rejected only by citing, in the ledger, the `docs/DESIGN.md` section that commits the choice.
- **Briefs are minimal prompt strings** — exactly five parts, nothing else: the addressing header · a one-line objective · novel coordination facts (concurrent runs, ordering) · task-specific NEEDS_CONTEXT triggers · task-specific report-evidence items:

  ```
  READ:  plan.md §Task-03 + §Global-Constraints [; task-03/impl-report-2.md  ← exact cycle]
  WRITE: task-03/impl-report-3.md   ← exact filename, never "the next one"
  BOUNDS: nothing else in the run directory — other task dirs are out of bounds
  ```

  Everything durable is cited, never restated: criteria, Design context, Global Constraints, and scoped checks live in `plan.md` (self-gate in a brief is one pointer line); role, generic bounds, report/return formats, and stop rules live in the agent definition. Never re-define an output format (task-specific evidence items only) and never paraphrase a section the agent reads in full — a lossy summary beside its source is a drift generator. Before sending any brief, run the think-like-your-agent check: would a fresh agent holding only this brief and its READ list succeed? If not, fix the brief now, not after a failed audit.

- **Design knowledge routes to `plan.md`, never to briefs.** Anything that affects what "done" means — new criteria, interpretation-changing rationale, decisions from validated findings, known pre-existing failures agents must attribute around — is recorded once as a `plan.md` amendment (or `research/` file) cited by both the task's implementer and auditor briefs. Test: if the implementer's brief would say it and the auditor's would not, it is in the wrong place. An amendment that corrects a practice removes the instruction that taught it in the same edit: two live instructions in different words are obeyed in the weaker form. Spell out prior-task and audit history in prose a fresh context can act on — never bare IDs ("T7 audit M2").

- **Implementer done → dispatch audit.** Auditor count by stakes: 1 by default · 2 independent auditors for money/settlement/crypto-adjacent tasks even when not flagged · a 3-lens panel (correctness, security, conventions) for sensitive-flagged tasks; a panel task is clean only when all lenses pass. Audit briefs reference the SAME `plan.md` criteria as the implementer's and name the exact `impl-report-N.md` path. Never pre-judge for the auditor — a brief containing "do not flag X" or "at most Minor" is you sparing yourself a fix loop. A finding that indicts the plan itself goes to the human: the plan's author does not grade its own work.
- **Git history may not be clear or complete, and that is acceptable.** A file the run created and never committed has no baseline in git; its auditor says what it could not compare.
- **On audit completion, you judge.** The auditor sees one task; you see the graph.
  - Pass and you agree → ledger the clean, recompute readiness, dispatch what unblocked.
  - Valid findings → **every validated finding gets fixed, regardless of severity** — severity orders work, it never defers it; there is no minors backlog. First, **fix the process, not the code**: a failed audit usually means the brief or criteria were ambiguous — improve them so the failure class dies, then dispatch the fixer.
  - A Critical finding from a single-auditor task → confirm it with one validator (auditor-type, validation brief) before dispatching the fixer.
  - Findings you judge invalid (unbuilt dependency, never-in-scope, false positive) → ledger the reason; no fix.
  - **Fix briefs carry only your validated findings, verbatim** — a fixer never reads a raw audit. The fixer also reads its own task's prior `impl-report-*.md`. Every fix is re-audited.
- **Status responses:** NEEDS_CONTEXT → improve the brief and re-dispatch · BLOCKED → resolve or escalate · DONE_WITH_CONCERNS → weigh the concerns when judging the audit · task too large in hindsight → split it. Never blind-retry an unchanged brief.
- **Cap: three fix→audit cycles**, then stop and escalate to the human with specifics — persistent failure almost always means the acceptance criteria are wrong, not that the implementer cannot do the work. A cycle counts only when the gate that decides "clean" ran: while the harness is down, reading stands in for measurement and finds ever-smaller things with no stopping condition, so pause the loop and tell the human the gate is down — never escalate a tooling outage as a criteria problem. When an attempt is wedged or polluted, cheap-reset: throw it away, improve the brief, re-dispatch fresh — keep the knowledge, burn the code.
- **Ledger every transition** as it happens. A dispatch entry carries what resuming the run without the chat context needs: task, role, and cycle (`T03 impl cycle 2`), agent type, the agent id the Agent tool returned, the WRITE target, and the brief verbatim — one multi-line entry, per the ledger's own rule. An implementer's completion entry quotes its return message verbatim (its format caps it); an audit completion stays in the ledger's distilled form — validated findings as one-liners, invalid findings with your rejection reason.

## Progress reporting

Recompute the status chart on major events: a task reaching a clean audit, a task becoming blocked, a plan amendment adding or splitting a task, a phase transition, close. Print it only when a cell changed: compare the recomputed table against the chart block `status.md` carries; identical cells under a new stamp is no print. A print is one chat block plus a rewrite of `status.md`'s chart block to match (once that file exists) — the file's chart never lags the chat's. At most one print per response — a batch of completions gets one chart, not one each.

The chart is a derived view, recomputed from `plan.md` and `ledger.md` at print time and stamped with the event that triggered it — never a third stateful copy, so after compaction it rebuilds from the ledger like everything else. Shape:

```
📊 Progress — after T04 audit PASS
| ✅ done | 🔧 in-flight | ⏸ blocked | ⬜ queued |
|      5 | T07, T09×2   | T03 → Q2  |        4 |
```

In-flight and blocked cells name their units and what each blocked unit waits on; done and queued are counts only, so the block stays small at any scale. `×N` marks a unit on its Nth fix cycle — the earliest wedge signal. When nothing is dispatchable, print the chart marked idle, name what every blocked unit waits on, and end the turn — entering idle is itself a cell-visible change; resume when a blocker lifts.

## Open questions — implementation phase

`status.md` in the run directory, created at first dispatch by `pnpm cards create`, whose `--title` sets the file's title and falls back to the run directory's name, is the stable home for questions to the human while implementation is in flight — chat during dispatch moves too fast to hold an open decision. You own the file; the human writes only `Answer:` lines. **Every read and write of the file goes through `pnpm cards`** (`pnpm cards --help` is the statement of its verbs; each takes `--run <dir>`), which holds the canonical shape below as its invariant, edits only the card or block a verb names, and refuses a card or field that is not where the verb expects it. The ledger is the run's append-only record of rulings; `status.md` is the run's complete record of its questions: the chart re-derives from `plan.md` + ledger, rulings live in the ledger, decisions in `plan.md`, and the cards themselves, with their deliberation, live here and nowhere else.

The canonical shape — exactly three parts, nothing else. No round headers, no rulings sections, no dates as structure; Q-IDs are monotonic across the run and the only card identity. A card becoming ready or being answered is a chart print trigger, and the chart gains a ❓ cell here: ready count, blocking count — drafting and in-review cards are not counted.

```
# Status — <run>

📊 after T04 audit PASS

| ✅ done | 🔧 in-flight | ⏸ blocked | ⬜ queued | ❓ open |
| --- | --- | --- | --- | --- |
| 5 | T07 | T03 → Q2 | 4 | 2 (1 blocking) |

## Open

## ✅ Q7 — should the wallet lock move before the ledger insert? [blocking T03]

**Problem** —
- Found — `file:line`, one line.
- Today — the behaviour as it stands.
- After — the behaviour under each option (the option table, when there are two or more).
- Breaks — what fails under each reading.

**Recommendation** — the option picked, the value it pursues, why it beat
the others.

**Decision** — one clause naming the choice, and where any new check lives.

**Alternatives** — only on a card with no option table: each loser and why.

## Answered

## ✅ Q1 — should the wallet lock move before the ledger insert? [blocks nothing]

**Problem** … **Recommendation** … **Decision** … **Alternatives** … (the card, unchanged)

**Answer:** yes, lock first — the human's words verbatim

**Work:** T09 (settlement lock order) criteria amended.
```

The chart block is the fixed table stamped with its trigger — `pnpm cards chart set` writes the task cells and the stamp, `chart idle` marks the stamp idle, `chart show` prints the block, and the ❓ cell is derived from the cards — no narrative above the fold. Never in `status.md`: re-entry or compaction notes, dispatch-order constraints, task rosters or reconciliations, run narrative. Those are ledger lines (or `plan.md` amendments when they change what "done" means) — the post-compaction rule trusts the ledger, so state parked anywhere else is state you will lose.

From first dispatch onward, never AskUserQuestion: card the question, announce it in one chat line when it becomes ready (`❓ Q3 ready (blocks T07): … — carded in status.md`), mark its dependent tasks blocked, and keep dispatching everything else. A run with no dispatchable work idles on the chart; it never interrupts.

**A card carries a decision this workflow places with the human. Carding a decision the workflow places with you is abdication, not caution.**

**Answering moves the card whole.** When an answer arrives — in the field or in chat — `pnpm cards answer <Q-ID> --text <the human's words> --work <landing>` moves the card from Open to Answered unchanged, with the human's words verbatim on its `Answer:` line and a `Work:` line appended naming the task's objective in a few words beside its ID; `--text` omitted takes the Answer line the human wrote in the file, and `pnpm cards pending` lists the cards holding one. The same verb appends the ruling verbatim to the ledger. Nothing on the card is shortened or dropped: the table, the diagram, the alternatives and the reasoning are the record of why the decision went the way it did, and this file is their only home. The decision and the rejected alternatives also reach the `plan.md` amendment's Design context, in prose the tasks cite. **Route the work immediately, before the next dispatch cycle**: fits an undispatched task → a `plan.md` criteria amendment · touches an in-flight task → never hot-patch a dispatched scope; a follow-up task or the next fix cycle's criteria · new work → a new task in the graph · invalidates a clean task → a new task that amends it (a clean audit is never silently reopened). "No" or "defer" is a real answer — `Work: none — deferred`, handed back in the close summary.

**A false premise found before the answer withdraws the card.** `pnpm cards withdraw <Q-ID> --reason <one line>` replaces the card's fields with that one line and moves it to Answered with `Answer: withdrawn`; the ledger line carries the evidence. A withdrawn card was never a decision, so nothing on it is a record worth keeping whole.

Corrections and batches edit in place. A false premise is `pnpm cards reopen <Q-ID> --correction <what is true instead>`: the card returns to Open with the correction folded into its Problem — never a new section. A batch of chat answers routes each answer into its own card — never a shared rulings block. A changed answer is `pnpm cards supersede <Q-ID> --text … --work …`, which appends a second `Answer:` line marked as superseding and a second `Work:` line; the earlier lines stay, so the card carries its own history.

The decision reaches `plan.md` as prose a fresh brief can cite; Q-IDs never appear in briefs, code, or comments. At close, the Open section is empty — every card answered or explicitly handed back — and the completeness critic's brief adds one check: every Answered card's `Work:` landed as a clean task, a live amendment, or an explicit deferral.

**Facts before the card.** A card is written once, after every load-bearing claim on it is Verified. An Inferred claim — whether a route is served, whether a defect reproduces, what a function takes — is an explorer or analyst pass owed first; the card is drafted from what comes back. A fact that changes a card's recommendation after drafting is this gate failing, and the card returns here.

**The card.** `pnpm cards open` takes the title, the fields (`--problem`, `--recommendation`, `--decision`, and `--alternatives` where the card carries no option table, each `@<path>` or a literal; a literal opening with a dash, as every Problem does, is joined to its flag with `=`) and `--blocks <task>`, or `--from <file>` holding one drafted card, and prints the Q-ID; `pnpm cards edit <Q-ID> --field <name>` changes or removes one field of one open card, one form per call; the forms are the verb's `--help`; `pnpm cards title <Q-ID>` owns the title line — `--text` reframes the question, `--blocks` and `--unblock` set which tasks it blocks, and the glyph and the Q-ID are the tool's. Every card states each fact once, in the field that owns it: the option table holds the comparison and prose carries only what a table cannot; Recommendation names the winning row and adds why its value outranks the others here; Alternatives is absent wherever the card carries an option table, because those rows already hold every loser's reason; the card carries conclusions, and the ledger carries the journey — no earlier draft, no retraction, no account of who found what. Every card is written for a reader who was not in the run, and the test is the title and the Decision line read alone: a stranger who knows the repo's docs can answer from those two, and everything else on the card is evidence for that answer. Task IDs, finding IDs, and labels minted during the run resolve nowhere outside it; a card names the file, route, table, or behaviour instead. The one task id a card carries is the blocking tag the tool writes from `--blocks`, and it is bookkeeping for the chart, not a statement a reader can act on: the Problem field names the work that waits on the answer — the file, route, or behaviour the blocked task changes — so the card says what is blocked without the ledger.

- **Title** — a question with its concrete nouns in it, yes/no or either/or. A topic, a metaphor, or an ID is a label, and a label cannot be answered.
- **Problem** — four labelled bullets and nothing outside them: **Found** (`file:line`), **Today** (the behaviour as it stands), **After** (the behaviour under each option), **Breaks** (what fails under each reading). A card about a flow, a state, or an ownership boundary carries a mermaid sequence or state diagram under Today, and the prose shrinks to what the diagram cannot show. A card with two or more options carries a table under After, one row per option, with the option's pros, its cons, the value it serves — a `docs/TECH-STACK.md` core value, a `docs/CODE-RULES.md` rule, or a named general quality such as one implementation or fail-fast — and the reason it loses if it loses. Labels in a diagram or a table resolve the way prose does, by name. A fact that does not change the answer to the title question is not on the card; the ledger or a `research/` file holds it.
- **Recommendation** — the option picked, the value it pursues, and why it beat the rows it beat; long-term quality over the quick patch, doing the work in this run over deferring it. A recommendation names a change to the system. "Investigate", "verify", "measure", and "check" name work the orchestrator owes before carding: run it, or dispatch an explorer or an analyst, and card the decision that survives. When the options are genuinely balanced, name the one you would take and what would change the call.
- **Decision** — one clause naming the choice the human is making, and, when it adds a check, a test, a rule, or a gate, where that check lives: the arch rule or lint rule, the test file, the pipeline stage. "Approve" binds to this clause. Steps, sequences, loops and stopping conditions are the plan amendment that follows a yes, never the Decision; `pnpm cards open` and `edit` refuse a Decision holding a semicolon, "then", "until", or "at which point".
- **Alternatives** — present only on a card with no option table: each option that lost, with the reason. On a card with a table, the table's rows carry every loser's reason and this field is absent.

**The reviewer gate.** Before the chat announcement, `pnpm cards state <Q-ID> review` and dispatch a **card-reviewer** with the run directory and the Q-ID and nothing else; it reads the card through `pnpm cards show`. It judges whether a stranger can answer the card, never whether the answer is right, and returns four things: the referents it could not resolve and the fields that fail its test; the questions a stranger would ask before answering; the sentences that do not change the answer (CUT); and the option it would pick from the card's Problem alone, formed before it read the Recommendation (INDEPENDENT). Its reading is the one a reader arriving cold will have, which is why the orchestrator's own reading cannot stand in for it. A reviewer question is answered from what you already hold, by an explorer or analyst pass when it needs a fact, or the card states the fact as unknown and why the decision survives that; a verdict authorises research and the rewrite, never an implementer. A CUT sentence is removed unless it is what a stranger needs to answer, and keeping one is a ledger line. An INDEPENDENT pick that differs from the Recommendation is a prompt to re-examine, never an override: rewrite the Recommendation when the card's own evidence supports the reviewer's pick, or state beneath the table, in one line, the reviewer's pick and why the Recommendation stands — the human sees both. **Two reviews per card.** The second is dispatched only when the first returned REWRITE against the title or the Decision; a card not ANSWERABLE after its second review goes to the human as it stands — `pnpm cards state <Q-ID> findings --text <the reviewer's open findings>` files them beneath the card — and the announcement says so; ANSWERABLE is `pnpm cards state <Q-ID> ready`.

**Card state.** The title opens with one glyph, and the glyph is the card's state for the human, the chart, and the announcement: 📝 drafting (facts still being gathered) · 🔍 in review (with a card-reviewer) · ✅ ready (ANSWERABLE) · ⚠️ ready with findings (the two-review cap, findings beneath the card). The ❓ chart cell counts ✅ and ⚠️ cards only (`pnpm cards list --ready` is that set), and the announcement fires on the transition into either. The human answers ✅ and ⚠️ cards; an answer on a 📝 or 🔍 card is still an answer — the review is dropped and the card moves to Answered as it stands. The glyph stays on the card in Answered, so a later reader sees whether the decision was made on a clean card or one with open findings.

The admission bar here is the standing rule: load-bearing ambiguity, anything that changes what "done" means, a design decision, an irreversible call. Decisions this workflow places with you — naming, implementation details within established patterns, test structure — are never cards. Phase 1's batched AskUserQuestion round is unchanged; `status.md` takes over at first dispatch.

## Phase 4 — Close

1. **Full unscoped pass:** `pnpm typecheck`, `pnpm lint`, `pnpm arch:check`, the relevant `pnpm test:*` suites, `pnpm lint:duplication`, `pnpm lint:unused`, `pnpm privacy` — the per-task audits were scoped and cannot see cross-task integration. Attribute every failure; fix only what this run caused (other agents may be working in the repo), through the same dispatch loop.
2. Send ALL validated close findings to ONE fixer as a single batch — per-finding fixers rebuild context each time and cost more than the tasks themselves. Re-audit the batch.
3. **Run the related E2E tests declared in the plan** — existing plus newly written, never the full suite. On failures: investigate, then report the results and your investigation to the human BEFORE changing anything, and wait for their decision.
4. **Completeness critic:** one auditor-type agent with a close-out brief asks what is missing — criterion unverified, integration untested, doc not updated. Valid gaps become tasks (implement → audit).
5. **Doc proposals:** throughout the run, write every documentation change the work implies — including the lessons of recurring audit failures — into `doc-changes.md` §Catalog as each surfaces; a doc the completeness critic finds invalidated becomes an entry too. At close, invoke the **doc-writer** agent once with a brief whose READ list names that file — the entries are the briefs; never restate the catalog in the prompt. You never draft doc diffs yourself. Route its return channels: transcribe PROPOSALS into §Proposals verbatim, each with an empty `**Decision:**` line, and have the human rule in the file; a CONFLICTS item becomes a §Proposals card the same way — the file is the run's one doc-decision surface at close, and `status.md`'s Open section is empty by then. A DISAGREEMENTS entry becomes a §Ruled line carrying the withdrawal and its evidence — the human reviews those lines with the proposals and can overrule one back into §Catalog. A NEEDS_CONTEXT item returns to §Catalog with the named missing fact supplied, and doc-writer is re-invoked in the same close step (the one exception to invoke-once). A RELOCATIONS item is already a proposal — its removal and landing chunks sit in §Proposals under one card, ruled as one act. The LOADED_DELTA line is carried verbatim into the run's close summary. Apply approved proposals from the file, verbatim — never from the return message — and never edit a doc without that approval. Before the run summarizes, §Ruled is complete: every proposal approved and applied, or rejected and absent from the tree.
6. Summarize: what shipped, what you escalated, what you judged out of scope. Do not commit; the tree is the human's.

# Reference

## Doc changes

The catalog opens in whichever part first implies a doc change, and the proposals are ruled at close.

`doc-changes.md` in the run directory is the run's doc debt: the catalog of every documentation change the work implies, then — at close — the surface where the human rules on doc-writer's drafted diffs. You own the file; the human writes only `**Decision:**` lines. Create it at the first catalog entry, which can land as early as planning — never scaffolded empty ahead of one. **Its shape is the invariant; edit the entry that changed and leave the file in that shape.** `ledger.md` stays the run's only append-only record, and each ruling on a proposal still gets its verbatim ledger line, exactly as answered `status.md` cards do — decisions live in the ledger, deliberation lives here. Deleting this file loses real state: the catalog has no second home, which is why the post-compaction reconcile names it.

**A catalog entry states what is wrong; it never contains replacement wording.** Doc diffs come only from doc-writer or the human (`docs/AGENT-RULES.md` §One Drafter) — replacement prose drafted into an entry breaks that rule while appearing to follow the workflow. An entry's fields are the four facts doc-writer's input contract demands, plus the trigger that produced it and the tier you believe the fact belongs to — `loaded` (the root chain or a named nested `CLAUDE.md`), or `on-demand` naming the index doc, existing or proposed — so every entry is a valid brief, and the close-phase invocation cites the file instead of restating it. Loaded is the exception you argue for, never the default: a loaded line binds every task, and doc-writer challenges the tier rather than inferring it. D-IDs are monotonic across the run and the only card identity; like Q-IDs, a D-ID never appears in a brief, in code, or in a comment (Durable Naming, `docs/CODE-RULES.md`). A proposal is one or more fenced `diff` chunks: each opens with an `@@ <section or heading> @@` locator and carries space-prefixed unchanged context around its `-`/`+` lines — enough to apply uniquely, never line numbers.

````
# Doc changes — <run>

## Catalog       ← the close-phase doc pass reads this; live from the first entry

### D3 — docs/BILLING.md §Fees
**Changed** — fee application moved from settlement to the ModelProvider port.
**Currently says** — "settlement applies the fee" (docs/BILLING.md:88).
**Now wrong because** — settlement receives billable amounts; no fee math runs there.
**Reader must** — know which seam bakes the fee when adding a provider.
**Tier** — on-demand, `docs/BILLING.md`.
**Trigger** — T04 clean audit.

## Proposals     ← doc-writer's drafted diffs, verbatim, awaiting the human

### D3 — docs/BILLING.md

```diff
@@ §Fees @@
 <unchanged context line>
-<current text>
+<replacement text>
```

why: <doc-writer's one line>
**Decision:**

## Ruled         ← one line each, ever

- **D3 — BILLING.md §Fees** → approved → applied `docs/BILLING.md` ✓
- **D5 — DEVELOPMENT.md index** → rejected: "the line is fine as-is" → not applied
- **D7 — ARCHITECTURE.md §Jobs** → withdrawn by doc-writer: already correct (ARCHITECTURE.md:141)
````

The file survives the run with the rest of the run directory; its §Ruled is what a later run reads to learn a doc change was already proposed and rejected — re-proposing a rejected change is re-asking an answered question.

## Scoped checks (compute per task, record in `plan.md`)

A task runs all three checks for every package holding a file it edits; for a package missing from this table, pass its `package.json` name. A scoped run applies the gate's rules at the gate's severities to that package alone; a green scoped check never stands in for the gate (`docs/BUILD-AND-CI.md` §Git hooks).

| Path edited            | Test                              | Typecheck                              | Lint                              |
| ---------------------- | --------------------------------- | -------------------------------------- | --------------------------------- |
| `apps/api/**`          | `pnpm test:pkg @hushbox/api`      | `pnpm typecheck:pkg @hushbox/api`      | `pnpm lint:pkg @hushbox/api`      |
| `apps/web/**`          | `pnpm test:pkg @hushbox/web`      | `pnpm typecheck:pkg @hushbox/web`      | `pnpm lint:pkg @hushbox/web`      |
| `packages/shared/**`   | `pnpm test:pkg @hushbox/shared`   | `pnpm typecheck:pkg @hushbox/shared`   | `pnpm lint:pkg @hushbox/shared`   |
| `packages/db/**`       | `pnpm test:pkg @hushbox/db`       | `pnpm typecheck:pkg @hushbox/db`       | `pnpm lint:pkg @hushbox/db`       |
| `packages/crypto/**`   | `pnpm test:pkg @hushbox/crypto`   | `pnpm typecheck:pkg @hushbox/crypto`   | `pnpm lint:pkg @hushbox/crypto`   |
| `packages/ui/**`       | `pnpm test:pkg @hushbox/ui`       | `pnpm typecheck:pkg @hushbox/ui`       | `pnpm lint:pkg @hushbox/ui`       |
| `packages/realtime/**` | `pnpm test:pkg @hushbox/realtime` | `pnpm typecheck:pkg @hushbox/realtime` | `pnpm lint:pkg @hushbox/realtime` |

Duplication: `jscpd --threshold 2 <changed-paths>` against the task's files, not the repo. Unused-code (knip) is whole-repo noisy mid-run; it belongs to the close pass. Scoping exists so audits don't fail on another task's in-flight work.

Design detector, `UI?` tasks only: `pnpm exec node .claude/skills/frontend-design/scripts/detect.mjs --json <owned paths>` as one more row of the task's table. What its pass is evidence of lives in the UI agents' own definitions, so the row names only the paths.

## Standing rules

- You never edit source files. No one — you or any subagent — runs a git command that mutates state; no commits.
- Acceptance criteria are identical between a task's implementer and its auditor: both read them from `plan.md`.
- Every implementation is audited; every fix is re-audited; every task ends on a clean audit you read.
- Briefs are self-contained apart from their READ list.
- Load-bearing mid-run ambiguity → surface to the human; never guess.

## Subagents

A closed roster of agent types. Every other role (fixer, validator, completeness critic) is a brief on one of them, not a new definition. Never change a subagent's model: dispatch with no model or effort override. An agent whose definition names no model inherits yours (the orchestrator's); an agent whose definition names a model keeps it — no need to check which case applies, just invoke with no override.

- **analyst** (read-only against the repo, web-enabled, cannot spawn subagents) — turns one hard question (feature design, bug diagnosis, dependency choice) into decision material: the option set, each option judged against our core values, a recommendation biased to the long-term robust solution, the rejected options and why, and — for a bug — the reproduction as a spec. It presents; it never decides or implements.
- **sdd-implementer** (background, full tools, cannot spawn subagents) — builds one task test-first and self-gates. Also the fixer: fix brief + validated findings + its own task's prior reports.
- **sdd-ui-implementer** (background, full tools including the browser MCP, cannot spawn subagents) — the sdd-implementer plus HushBox's frontend craft rules, a look at its own work in the running app, and the design detector in its self-gate. The implementer and the fixer of every `UI?` task.
- **rote-worker** (background, edit tools, cannot spawn subagents) — executes one zero-discretion task: a mass scrub, a mechanical migration, running an existing tool over a file list. Dispatch one instead of an sdd-implementer only when the brief passes the admission test: an exact transformation rule, an exact file scope, and a runnable oracle whose pass means done — such that two different agents would produce byte-identical results. If writing the brief requires describing judgment, it is not a rote task. The audit loop is unchanged — every rote-worker task is audited like any other. A NEEDS_CONTEXT from a rote-worker means the task was not rote; re-dispatch to a full sdd-implementer rather than improving the brief with judgment language.
- **sdd-auditor** (background, read-only, cannot spawn subagents) — judges one task blind-first, then reconciles against the implementer's report. Also the validator (confirm one finding) and the completeness critic (close-out brief).
- **sdd-ui-auditor** (background, read-only, drives Playwright MCP and Chrome DevTools MCP against the live URL, cannot spawn subagents) — the sdd-auditor plus a live, direction-aware design review of the running surface, folded into one verdict with a design dimension. The auditor of every `UI?` task, and the correctness lens of its panel when the task is also sensitive.
- **doc-writer** (read-only, cannot spawn subagents) — drafts every documentation diff; you and the other agents never do. Invoked once at close with the full batched catalog of doc changes, each with its end-to-end reason; verifies the claims against the repo, returns proposed per-file diffs plus its disagreements and NEEDS_CONTEXT items; the human decides each proposal.
- **card-reviewer** (`pnpm cards show` only, cannot spawn subagents) — reads one `status.md` card as a stranger and returns ANSWERABLE or the referents, fields, and questions that stand between a stranger and an answer, the sentences that do not change the answer, and the option it would pick from the Problem alone; it judges answerability from the card alone, never correctness, and its pick informs the orchestrator, never binds it. Dispatched before every card announcement, at most twice per card.
- **codebase-explorer / package-researcher / web-researcher** — cheap factual lookups (locate code, dependency facts, the web); read-only against the repo, distilled returns. Reach for the analyst on high-stakes option-weighing and diagnosis, these for quick facts.

The analyst and the three lookup agents have two return modes, and your brief selects. Name a WRITE target — `research/<subject>.md` under the run directory, named for the question's subject, since the directory already names the run — and the agent writes the whole deliverable there and returns the path plus the direct answer; name none and the whole deliverable comes back in the message. A file-mode file opens with the head matter its agent definition specifies — Question, Reach, Carries — and its Carries line (`facts only` or `facts and a recommendation`) is what a consumer admitting only fact inventories gates on, never the producing agent.

- **sdd-design-critic** (background, read-only against the repo, web-enabled, cannot spawn subagents; the design part only) — judges one plan before the human approves it. Briefed with `goal.md` and none of the plan, it derives its own design blind, then reads the run directory and reconciles the two: divergences resolved as plan-better, plan-worse, or an open choice for the human, plus the precision, completeness, decomposition and doctrine checks. Writes `plan-review-N.md`; its message carries the verdict.
