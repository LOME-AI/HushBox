---
name: subagent-driven-dev
description: Orchestrate implementation as a non-coding lead. Use for ANY implementation task beyond a trivial change — skip only when the change is describable as a one-sentence diff, a few lines, a single concern, and involves no design decisions. Research and prove out an exact plan, get the human's approval, then drive implement→audit→fix loops through subagents until every task passes an audit the orchestrator agrees is clean. Ceremony scales to task size.
argument-hint: [task description, path spec]
---

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

{{SDD_WHY_NO_CODE}}

## Two things never bend

1. **No implementation before the human approves the plan** — at every tier. The human may waive this per-request; never assume it.
2. **Every task ends on an audit you read and agree found nothing valid.** An implementer never has the last word on its own work.

## The run directory

Create `docs/runs/{date}-{slug}/` at the start of the design part:

{{SDD_RUN_DIRECTORY}}

Here `plan.md` is immutable after approval — deviations flow through you and are recorded as amendments — and `research/` holds the planning research.

`goal.md` holds the human's words only: the goal as they stated it, the optimization targets, the hard constraints, and any hypothesis they offered, labelled as a hypothesis. It is written at run open, before any design work, and changes only on the human's direction — each change is a ledger line quoting them. Nothing derived lives there: a constraint the human stated is written in `goal.md` and cited from `plan.md`; a constraint the orchestrator concluded is written in `plan.md`. Authorship decides, so the two files never restate each other. `plan-review-N.md`, at the run directory root, is the design critic's review — cycle-numbered, written by the critic, read by the human at approval. Each `research/` file declares in its head matter whether it carries facts only or a recommendation (§Subagents, file mode); the critic's FACTS line admits only the first kind.

## The two parts

The run has two parts, and one transition between them: **the human's explicit approval of the plan**. Before it, the run designs; after it, the run executes. Every agent in the roster is available in either part as the work requires; the transition changes what the run may do, not whom it may call — nothing is implemented before approval, and the design critic's admission is decided once, in Phase 1b.

Amendments during execution flow through you into `plan.md`, and decisions the workflow places with the human are carded in `status.md`. Neither re-enters the design part. A plan-indicting audit finding that forces a redesign large enough to want a second opinion is a re-entry to Phase 1 for that redesign, with the human told so.

# Part I — Design

## Phase 1 — Plan and prove

Goal: a plan with zero unknowns. Every ambiguity you leave becomes an audit failure later — the implementer and auditor will read the same vague criterion two different ways. The human reviews plans, not diffs, because errors amplify downstream: a bad line of code is one bad line; a bad line of plan is hundreds.

{{SDD_EVIDENCE_DISCIPLINE}}

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

{{SDD_DISPATCH_LOOP}}

## Progress reporting

{{SDD_PROGRESS_REPORT}}

## Open questions — implementation phase

{{SDD_OPEN_QUESTIONS}}

{{SDD_CARD}}

The admission bar here is the standing rule: load-bearing ambiguity, anything that changes what "done" means, a design decision, an irreversible call. Decisions this workflow places with you — naming, implementation details within established patterns, test structure — are never cards. Phase 1's batched AskUserQuestion round is unchanged; `status.md` takes over at first dispatch.

## Phase 4 — Close

1. **Full unscoped pass:** {{SDD_UNSCOPED_PASS}}
2. {{SDD_BATCHED_CLOSE_FIXER}}
3. {{SDD_RUN_DECLARED_E2E}}
4. **Completeness critic:** one auditor-type agent with a close-out brief asks what is missing — criterion unverified, integration untested, doc not updated. Valid gaps become tasks (implement → audit).
5. **Doc proposals:** {{SDD_DOC_PROPOSALS}}
6. Summarize: what shipped, what you escalated, what you judged out of scope. Do not commit; the tree is the human's.

# Reference

## Doc changes

The catalog opens in whichever part first implies a doc change, and the proposals are ruled at close.

{{SDD_DOC_CHANGES_FILE}}

## Scoped checks (compute per task, record in `plan.md`)

{{SDD_SCOPED_CHECKS}}

## Standing rules

{{SDD_STANDING_RULES}}

## Subagents

{{SDD_SUBAGENTS}}

- **sdd-design-critic** (background, read-only against the repo, web-enabled, cannot spawn subagents; the design part only) — judges one plan before the human approves it. Briefed with `goal.md` and none of the plan, it derives its own design blind, then reads the run directory and reconciles the two: divergences resolved as plan-better, plan-worse, or an open choice for the human, plus the precision, completeness, decomposition and doctrine checks. Writes `plan-review-N.md`; its message carries the verdict.
