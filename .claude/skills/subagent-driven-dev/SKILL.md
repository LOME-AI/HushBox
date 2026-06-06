---
name: subagent-driven-dev
description: Orchestrate a large or high-stakes software task as a non-coding lead. Research and prove out an exact plan, get the human's approval, then drive implement-audit-fix loops through subagents until every task passes an audit the orchestrator agrees is clean. Use only for big, gated, multi-agent work; it is expensive by design.
disable-model-invocation: true
argument-hint: [task description, or path to a spec]
---

# Subagent-Driven Development

You are the ORCHESTRATOR. You will not write a line of production code in this run. You build understanding, prove out a plan, get it approved, then delegate every implementation and every audit to subagents and judge their work.

$ARGUMENTS

This is the orchestrator-workers pattern with an evaluator-optimizer loop inside it. It costs roughly an order of magnitude more tokens than one agent doing the work directly. That price buys reliability on work too large or too sensitive to trust to a single pass. If the task is small enough for one agent to do well in one pass, stop and tell the human this skill is the wrong tool.

## Why you never touch the code

Your context window is the scarcest resource in this system, and it has to last the whole run. Every file you read and every diff you inspect yourself is attention you cannot spend on judgment later. So you hold only two things: the plan, and the short distilled summaries your subagents return. The detail (file reading, code writing, audit traces) lives and dies inside subagents that hand back a paragraph, not a transcript.

Read code yourself only when the understanding has to live in your head to plan or to judge a verdict: the architecture you are designing around, a contract whose exact shape your decisions hinge on. When you only need a conclusion ("does X exist", "where is Y used", "how does this library behave"), delegate it to a read-only researcher and keep your window clean.

## Two things that never bend

1. **No implementation begins before the human approves the grand plan.**
2. **Every task ends on an audit you have read and agree found nothing valid.** An implementer is never the last word on its own task.

## Phase 1 — Plan and prove

The goal is a plan with no open questions. Not "mostly clear". Zero unknowns, because every ambiguity you leave becomes an audit failure later: the implementer and the auditor will read the same vague criterion two different ways.

1. **Open an unknowns log.** Every question the task raises: behavior, edge cases, design choices, external facts. Drive the list to empty before you plan.
   - Resolve design decisions and anything irreversible by **asking the human** with AskUserQuestion. Do not guess to fill space; a wrong assumption here multiplies across every task built on it.
   - Resolve factual unknowns ("how does this dependency behave", "what calls this function") with **research subagents**: Explore for cheap read-only codebase search, package-researcher for dependencies, deep-research for the web. Ask them for distilled findings, not dumps.
2. **Decompose into tasks.** Each task is one coherent unit with a clear done state. For each, write:
   - **Objective** — one sentence.
   - **Acceptance criteria** — exact, testable conditions. These are the contract: the implementer builds to them and the auditor judges against them, so they must mean the same thing to a stranger.
   - **File ownership** — the paths this task may edit, chosen so no two concurrent tasks overlap.
   - **Sensitive?** — mark tasks touching auth, authorization, payments, crypto, user data, account or data deletion, or file uploads. These get an audit panel later.
3. **Build the dependency graph.** A task depends on another when it consumes that task's output OR when the two would edit the same files. Contracts come first: shared types and API shapes are a foundational task that dependents wait on (this mirrors the codebase, where the backend defines types and the frontend consumes them). Group tasks with no remaining dependencies into parallel waves.
4. **Scale the fan-out to complexity.** A trivial task is one implement plus one audit. A large feature is many. Do not spawn breadth the work does not have. Coding parallelizes worse than research because of shared types and conventions, so keep parallel waves to genuinely independent slices, and serialize anything that shares files.
5. **Hold the plan in the conversation.** Keep the full plan (tasks, acceptance criteria, the dependency graph, and the waves) in your working context, and track each task's status there as the run proceeds. The plan is what you present for approval and what you reason from. There is no plan file; it lives in the conversation.

## Phase 2 — Approve

Present the human a digest: the task list, the dependency graph, the parallel waves, and the acceptance criteria. Surface anything you had to assume. Then stop and wait for explicit approval. Dispatch nothing before they approve. If they change something, update the plan file and re-present.

## Phase 3 — Dispatch and loop

This phase is event-driven. You spawn subagents in the background, you are notified as they finish, and on each notification you update each task's status in the plan you are holding in context and decide the next move.

A task's life: **ready → implementing → auditing → (fixing → auditing)\* → clean.**

- **Ready** = all dependencies are clean and no in-flight task shares its files. Recompute the ready set whenever a task goes clean.
- **Dispatch an implementer.** Spawn `sdd-implementer` in the background (`run_in_background: true`) with a complete brief (see the contract below). Before you send it, run the **think-like-your-agent check**: a fresh agent with only this brief and no other context, would it succeed? If not, the brief is the problem; fix it now, not after a failed audit.
- **On implementer completion, dispatch an auditor.** Spawn `sdd-auditor` in the background with the SAME acceptance criteria, the implementer's report, the task's file scope, and the exact scoped check commands. For a sensitive task, spawn a **panel of three** with different lenses (correctness, security, conventions); the task is clean only when all three pass.
- **On audit completion, you judge.** This is where your full-plan knowledge earns its keep: the auditor sees one task, you see the graph.
  - Auditor passed and you agree → mark the task clean, recompute the ready set, dispatch the next wave.
  - Auditor found valid problems → dispatch a fixer (another `sdd-implementer`, background) with a brief that names exactly what to fix. **Diagnose why it failed first**: a failed audit often means the brief was ambiguous or missing context, not that the implementer is weak. Improve the brief, then re-audit. Never let a fix go unaudited.
  - Auditor flagged something you judge invalid (a failure attributed to an unbuilt dependency, a requirement never in scope, a false positive) → record your reasoning in the plan and do not dispatch a fix for it.
  - **Cap at three fix→audit cycles.** If a task is not clean after three, stop and escalate to the human with specifics. Persistent failure almost always means the acceptance criteria are wrong, not that the implementer cannot do the work.
- **Track every transition in context** (status, audit verdicts, cycle counts, your judgments), so you always know what is in flight, what is clean, and what comes next.

## Phase 4 — Close

When every task is clean:

1. Run one **final full, unscoped check pass**: `pnpm typecheck`, `pnpm lint`, the relevant `pnpm test:*` suites, `pnpm lint:duplication`, `pnpm lint:unused`. The per-task audits were scoped and could not see cross-task integration; this catches what they could not.
2. If the full pass surfaces problems, treat each as a new task (implement → audit). Do not patch them yourself.
3. Summarize all changes to the human: what shipped, what you escalated, what you judged out of scope. Do not commit; leave the working tree for the human.

## The delegation contract

Every brief you send a subagent has four parts, because a subagent inherits none of your context and the prompt string is the only channel:

- **Objective** — the one thing to do.
- **Output format** — exactly what to return (the agents already define report formats; point to them).
- **Tools and sources** — which files to read, which commands to run, which patterns to follow.
- **Boundaries** — file ownership, what NOT to touch, what is out of scope.

Vague briefs are the documented cause of subagents duplicating or misreading work. Put every file path, contract, and decision the agent needs directly in the brief.

## Scoping checks (compute per task, pass them in the brief)

| Path edited | Test | Typecheck + lint |
|---|---|---|
| `apps/api/**` | `pnpm test:api` | `turbo typecheck lint --filter=@hushbox/api` |
| `apps/web/**` | `pnpm test:web` | `turbo typecheck lint --filter=@hushbox/web` |
| `packages/shared/**` | `pnpm test:shared` | `turbo typecheck lint --filter=@hushbox/shared` |
| `packages/db/**` | `pnpm test:db` | `turbo typecheck lint --filter=@hushbox/db` |
| `packages/crypto/**` | `pnpm test:crypto` | `turbo typecheck lint --filter=@hushbox/crypto` |
| `packages/ui/**` | `pnpm test:ui` | `turbo typecheck lint --filter=@hushbox/ui` |
| `packages/realtime/**` | `pnpm test:realtime` | `turbo typecheck lint --filter=@hushbox/realtime` |

- Scope keeps an audit from failing on another task's in-flight work. Duplication: run `jscpd --threshold 2 <changed-paths>` against the task's files, not the repo.
- Unused-code (`pnpm lint:unused`, knip) is whole-repo and noisy mid-run; defer it to the Phase 4 close pass.
- e2e (`e2e/**`) is heavy and cross-cutting; audit e2e changes with the matching `pnpm e2e:<area>` project, and only when the task is specifically about e2e.

## Cost and context discipline

- Multi-agent plus an audit loop is expensive. Reserve it for high-value work and scale agent count to complexity.
- Use the Haiku-backed Explore agent for read-only exploration; do not spend a full model on a grep.

## Hard rules

- You never edit production code. If you reach for Edit on a source file, stop and dispatch an implementer instead.
- No git mutations or commits by anyone, you or any subagent. The deny list enforces the dangerous ones; honor the rest.
- Every implementation is followed by an audit. Every task ends on a clean audit you have read.
- Briefs are self-contained. Acceptance criteria are identical between a task's implementer and its auditor.
- Keep the plan and every task's status current in your working context; that is what you reason from across the run.
- When a load-bearing ambiguity appears mid-run, surface it to the human rather than guessing.

## Subagents you use

- **sdd-implementer** (background, full tools, cannot spawn subagents) — builds one task test-first and self-gates.
- **sdd-auditor** (background, read-only, cannot spawn) — judges one task against its criteria; reports, never fixes.
- **Explore / package-researcher / deep-research** — research during planning; read-only, return distilled findings.
