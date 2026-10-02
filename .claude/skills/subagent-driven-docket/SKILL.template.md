---
name: subagent-driven-docket
description: Drive ruled audit findings to implemented — orchestrated as a non-coding lead who groups the findings into tasks, checks each group's premises against the current tree before writing it, and runs implement→audit→fix loops through subagents until every finding is done or blocked with a reason. Groups move independently and new rulings join the run as they arrive. Use when an audit directory under docs/audits/ carries rulings waiting to be carried out.
disable-model-invocation: true
argument-hint: [additional instructions or focus area]
---

# Subagent-Driven Docket

You are the ORCHESTRATOR. You write no production code in this run. You take the rulings out of the docket, group the findings into tasks, establish that each group's premises still hold before writing it, delegate every implementation and every audit to subagents, and record each finding's outcome back into the docket.

$ARGUMENTS

## What this drives, and what it never touches

The input is the newest audit directory under `docs/audits/`: findings a human has already ruled on. The human keeps ruling while you work, so the input grows during the run.

- **Ruled findings only.** A finding that is `open` — nobody has decided — or `denied` — decided against — is not work. No agent in this run decides `state`, `ruling`, `severity`, or `denial`: those are the human's, and the docket refuses an agent writing them on its own account. The one way `state`, `ruling` or `denial` moves in this run is a mandated relay of a decision the human already took — the orchestrator's act alone — and `severity` moves by no path at all.
- **`progress.verified` is never an agent's judgement.** `progress.status=done` is the agent's claim that it did the work; `verified` is the human's separate statement that the behavior is right — a different question, answered by a different reader. It moves only as a mandated relay of the human's explicit verdict, and the docket refuses every other attempt.
- **A ruling is not self-evidently actionable.** The audit was written against a tree that has moved: some findings are already satisfied, some cite code that no longer exists. Establishing which is the premise check that opens every group's flow, and it is not optional.
- **The chosen option's prose is usually the whole instruction.** Almost no ruling carries `ruling.text` or `ruling.note`, so the acceptance criteria live in the finding's body. Build every task by reading findings, not by reading rulings.

## Why you never touch code

{{SDD_WHY_NO_CODE}}

### Do not invoke subagent-driven-dev

{{SDD_NO_NESTED_INVOKE}}

The adaptation for the docket: the tasks come from findings a human already ruled on rather than from a plan you propose, so the approval gate is replaced by the premise check each group runs before its task is written, and disagreement lands in the docket rather than in chat.

## The format contract

`docs/audits/CLAUDE.md` defines the finding format: every field, who owns it, the YAML subset, the structural invariants, the state machine, and how an implementation agent works a finding. It is a nested `CLAUDE.md`, so it loads only for an agent working under `docs/audits/` — and your implementers work in `apps/api/` or `packages/ui/`, where it never loads by itself. **Put `docs/audits/CLAUDE.md` in the READ list of every brief you send**, implementer, auditor, explorer and analyst alike.

Cite it; never summarize it. A paraphrase of the contract sitting in a brief is a second copy that drifts from the one the docket actually enforces.

## The docket is the only interface

`pnpm docket` reads and writes the finding files. **No agent — you, an implementer, an auditor, an explorer, an analyst — reads or edits a finding file directly, ever.** Hand-editing writes fields the writer does not own and can break the format silently; the CLI cannot produce a file the console will not read, and it writes as the implementation agent everywhere but under a mandate, where it writes the human's decision as the human's.

**`pnpm docket --help` is the statement of the CLI** — every action, the flags each one takes, the values those flags accept, and what separates a queue from the state it is named after. Run it, and require it of every agent you brief. Never restate it: not here, not in a brief. The run acts on the newest audit directory under `docs/audits/` — that is what the CLI reads.

Work comes from the ruled queue, stock from the progress queue, and what is stuck from the blocked queue.

**A mandated action is a relay, and relaying is yours alone.** Every action that carries a human decision requires a mandate — `--help` marks each — and writes as the human, because the human is who decided; the mandate is the human's own words and where they were given, never a paraphrase. No implementer, auditor, explorer or analyst is ever briefed to run one: a subagent handed a mandate is a subagent that can forge a decision. And an unblock is only ever the human's answer to a block — a block that dissolves without a human word is cleared by setting the finding's progress status back yourself, the agent's own write, never through `unblock`, whose note would record an answer nobody gave.

**Two briefs, two readers, and handing over the wrong one blinds the agent.** The CLI prints a finding two ways: one showing only the option that was ruled, and one showing every option the finding offered with the ruled one marked. Which one an agent receives is a correctness matter, not a convenience.

- **An implementer and its auditor judge against the ruling.** Both get the ruled-option brief, and both get the identical command — that is how their criteria stay identical when the criteria live in the docket rather than in `plan.md`. The options nobody chose are noise to them, and inviting them to weigh alternatives is inviting them to reopen a decision that is not theirs.
- **Any agent that may return a contest judges the ruling itself.** A premise-checker's verdicts include _ruling contested_, and its classes include "the chosen option works and a materially better one exists". That verdict is unreachable from a brief that hides the options that were not chosen — the agent would be grading a decision against evidence it was never shown. So every premise-checking explorer, and every analyst escalated off one, gets the all-options brief.

`--help` says which command is which. Brief each agent with the one that matches what you are asking it to judge.

On its own account a run writes three things: a finding's progress status, a progress note recording what happened, and an answer to a question the human asked — the contract's ownership table decides which fields an agent may write at all, and the store refuses the rest. Everything else a run writes is a mandated relay. `progress.updated` is stamped for you whenever you report progress — a status or a note, never an answer or a relay, because it is the agent's own last-reported marker and a human's decision must not move it.

`pnpm docket` with no action starts the console, which the human uses to rule.

## The run directory

Create `docs/runs/{date}-docket-{audit}/` when the run begins:

{{SDD_RUN_DIRECTORY}}

Here a task's Acceptance criteria are the finding's own — the chosen option's prose, `ruling.text` where one exists, and the explainer's criteria — and `plan.md` **cites** them: the field holds the ruled-option brief command that prints them, never their text. Copy them in and you have written down a decision the human can re-rule while the task runs, and the copy is the half that goes stale. The Change field is the ruled option's own behaviour for the same reason, so the field carries only what the plan adds beyond it — a behaviour the grouping forces, or one the premise check established — and is absent when the plan adds none.

`plan.md` still carries everything the docket does not hold: the finding ids the task groups, each one's premise verdict, file ownership, the scoped checks, and the design context a fresh agent cannot reconstruct from a finding — why these findings are one task, and what the run has already learned that changes how this one is carried out. `research/` holds the premise-check verdicts. The docket, not `plan.md`, is where each finding's outcome is recorded.

## Intake — mechanical, and it never stops

Intake is how work enters the run, and it is the only way. It reads findings and runs the CLI; it dispatches no agents, forms no verdicts, and makes no design calls. It repeats for as long as the human keeps ruling.

Read the audit's `audit.md` before your first pass. It carries the must-rule-together table and the warnings about fixes that look obviously correct and are wrong; a group built without reading it can be built against a trap the audit already named.

**The grouping procedure, cheapest step first.** Run the steps in order; each one only refines what the step before it produced.

1. **Resolve every ruled finding to a file set.** The finding bodies carry the paths, and the CLI's census names every citation that no longer resolves. No subagent is dispatched to do it. That file set is what the next step groups on, and a dead citation becomes a flag the premise check inherits rather than a reason to stop grouping.
2. **Take connected components over shared files.** Two findings whose fixes touch one file land in one group. This is not a preference: the dispatch loop requires non-overlapping file ownership between concurrent tasks, so two findings on one file either share a group or serialize, and sharing is cheaper and produces one coherent diff instead of two that fight.
3. **Merge by declared authority**, in descending precedence: a finding's own `group` field, then its `related` list, then the must-rule-together table in the audit's `audit.md`. The first two ride the finding's brief, under the title — a finding that declares neither prints neither line, so a silent brief means the finding declared nothing, not that the surface dropped it. The third is in the `audit.md` you read before this pass. What these three record is conceptual overlap — same root cause, one fix subsuming another, or a pair that would produce contradictory work if carried out independently. The `audit.md` table outranks your own reading, and its stated grounds are that ruling those apart produces contradictory or duplicated work: wanting to split a pair it names is a contest, not a decision.
4. **Split for reviewability.** A group is too large when its auditor could no longer reject one finding while approving its neighbour. That is the ordinary split test — an auditor's gate is only worth what it can reject in isolation — read through findings instead of files.
5. **Split for complexity homogeneity.** A subsystem redesign does not belong in a group with three one-line fixes: its fix cycles would hold the one-liners hostage for no reason, and its audit would be judging two kinds of work against one gate. Split them even when every finding in the group is ready today.

A split at step 4 or 5 that separates two findings sharing a file makes those two groups sequential instead of concurrent. That is the price, and it is worth paying when the alternative is a group nobody can audit or a one-line fix stuck behind a redesign. Never undo step 2's merge silently: record the split in `plan.md` and order the two groups in the graph.

**A finding is never split across two groups.** One finding, one group, one auditor gate. A finding whose fix genuinely spans two disjoint areas is a signal the ruling is under-determined — that is a contest, not a split.

**Each group becomes exactly one task**, and each one runs the flow below on its own clock. Build the dependency graph the usual way: shared contracts first, groups touching the same files serialize.

**Where a late ruling lands.** Newly ruled findings appear continuously, so re-run intake each dispatch cycle over what is new since the last one. Never wait for the human to finish ruling before starting; never assume the set you planned against is still the whole set. A new finding lands by what it overlaps:

- **Overlaps nothing in flight** → it groups normally and enters the flow like any other.
- **Overlaps a group that has finished** → it starts a group of its own. Those files are free again.
- **Overlaps a group still in flight** → it joins that group if the group has not been dispatched yet; otherwise it waits for that group to finish, then starts a new group.
- **Never hot-patch a running task's scope.** A dispatched task's findings and file ownership are fixed the moment its brief is sent. Adding a finding to work already in an implementer's hands invalidates the audit that was going to judge it, and the auditor has no way to know.

**An unanswered question is intake work, not commentary.** The human asks questions on findings while the run moves, and the CLI's questions sweep prints every finding holding one, each with the command that answers it — run it on the same cycle. A question on a finding already dispatched goes to that finding's implementer, which answers it out of the work it just did; a question on a finding not yet dispatched is answered before its task is written, because the answer can change what the task is.

## Contesting a ruling

Rulings are the human's decisions, and they are also written from a snapshot. An agent must not blindly carry one out — and must not relitigate every one it would have written differently. Both failures are expensive; the taxonomy below is what separates them.

**The five contest classes.** A contest names exactly one:

- **Stale premise** — the finding's evidence pointed at something real that has since moved or changed. The fix may still be right; the citation is not.
- **False premise** — the described behavior was never true. The finding is wrong, not out of date.
- **Unsound ruled option** — the problem is real and the chosen option does not fix it, or breaks something else doing so.
- **Better solution available** — the chosen option works and a materially better one exists. The bar here is highest: "I would have written it differently" is not this class.
- **Cross-finding conflict** — carrying out this ruling contradicts or duplicates another ruled finding's.

**The contest bar.** A contest carries Verified-grade evidence with `file:line` citations against the current tree, and names its class. Inference and convention do not clear it. Contests are raised at plan time and batched — never mid-implementation, where they cost an implementer's whole context to raise.

**And the counter-discipline, stated as bluntly:** a run that contests a third of its rulings is broken, and so is a run that contests none. The first means the premise-checkers are grading the human's judgement instead of checking premises; the second means nobody looked. If your contest rate is drifting toward either end, the problem is your briefs, not the findings.

**Pushback lands in the docket, not in chat.** Set each contested finding `blocked`, and leave it a note carrying the class, the evidence with its `file:line` citations, and what would unblock it. That surfaces it in the console's Blocked queue, where the human answers or re-rules with the reason in front of them: an answer appends a human note and returns the finding to `not-started` with the ruling standing, a re-ruling replaces the ruling and resets the status the same way, and either route puts the finding back in the ruled queue. That is the point, and is why the reason belongs in the note rather than in a message that scrolls away. Chat gets one batched summary per group, pointing at the queue.

## The group flow

Every group runs the same steps on its own clock: **premise → task → implement → audit → record.** Groups never synchronize with each other. A group waiting on a premise check does not hold up a group already implementing, and a group in its second fix cycle holds up nothing but itself. The only ordering between groups is file overlap, which the graph already carries. A group is `recorded` — its terminal state, and what the landing rules above mean by finished — when every finding it holds has a terminal `progress.status` in the docket, and not before.

### Premise check

{{SDD_EVIDENCE_DISCIPLINE}}

The check runs before the group's task is written. Its purpose is sequencing, not politeness: an implementer that discovers mid-task that its ruling rests on a dead citation has already burned the work, and it interrupts the human one finding at a time. Doing it before the task exists makes disagreement batched and cheap.

**Tier the check by cost. Never one analyst per finding** — at the volume a ruled audit carries, that is a run that never finishes, and the depth is wasted on findings whose premise a file listing settles.

- **Tier 0 — the census. No agent.** Intake already ran it, and it answers the mechanical half — which citations no longer resolve — for the whole set at once.
- **Tier 1 — one `codebase-explorer` for the group.** The default, and where most verdicts come from. Brief it with `docs/audits/CLAUDE.md`, the census output for its findings, and the all-options brief for the ids it covers. It returns one verdict per finding, with the evidence behind each.
- **Tier 2 — an `analyst`, for contest candidates and design-bearing rulings only.** Escalate when tier 1 returns something that reads like a contest, or when the ruled option is a design choice rather than a repair. An analyst produces decision material; spending one to confirm that a file still exists is the cost that made the tiering necessary.
- **The escape, and its trigger.** A single finding may take an explorer or an analyst of its own when its ruled option is itself a design decision, or when its blast radius spans subsystems. The trigger is the whole guard: without it, "exceedingly complex" becomes every finding by the third day and the tiering is gone.

Each premise-checker returns, **per finding**, exactly one verdict:

| Verdict               | Meaning                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| **premise holds**     | the problem is still there, the citations resolve, the ruled option still applies                      |
| **stale**             | the coordinates moved — file renamed, lines shifted — but the fix is still real. Re-locate and proceed |
| **already satisfied** | the tree already does what the ruling asks                                                             |
| **false**             | the premise was never true; the finding describes something the code does not do                       |
| **ruling contested**  | the premise holds but the ruled option is wrong — see the contest classes above                        |

**Already satisfied is a first-class outcome, not a gap.** Record it: set the finding `done` through the CLI, with a note saying what already satisfies it and the evidence behind that. Never fabricate an edit so a finding has a diff to show.

**False and contested findings block**, in the docket, with the class and evidence in the note. Everything else becomes the group's task material. A group whose findings all block is `recorded` without ever being dispatched.

### Write the task

Write the group's task into `plan.md`: the finding ids, each one's premise verdict, file ownership, the scoped checks, and the design context — why these findings are one task, and what the run has already learned that changes how this one is carried out. Acceptance criteria are cited, never copied, and the Change field carries only behaviour the ruled option does not already state.

**Declare the related E2E as you write the task.** Not once for the run, and not at an approval gate — this workflow has none, and the E2E surface only becomes knowable when a group's findings have named the code they touch. Record the existing E2E specs its findings' citations fall under, plus any new E2E that CODE-RULES' "When to Write an E2E Test" requires of the fix. Ruled findings land in chat, messaging, sharing and billing code, so a group touching any critical-path flow declares E2E until you have established that it does not.

### Implement and audit

{{SDD_DISPATCH_LOOP}}

Two docket-specific obligations ride on top of the loop:

- **Every brief's READ list names `docs/audits/CLAUDE.md`** and the ruled-option brief command for the task's findings. **The implementer's brief and its auditor's carry the identical brief command** — that is how the standing rule that both judge against the same criteria is met when the criteria live in the docket rather than in `plan.md`. Never paste a finding's text into a brief: the docket is the source, and a pasted copy goes stale the moment the human re-rules.
- **The ruling can move under a running task.** The human keeps ruling while you work, and a finding can be re-ruled or reopened mid-task. Because both agents read the live finding, a re-ruling reaches the auditor as changed criteria instead of quietly diverging from a copy — so `ruling.at` confirms the move rather than being the only thing that reveals it. The implementer records each finding's `ruling.at` — the brief already prints it — in its report, and the auditor confirms against its own read that it has not moved. A moved ruling invalidates the work against it: return the finding to the premise check, do not patch over it.

### Record

**Progress is tracked per finding, never per task.** `plan.md` tracks tasks; the docket tracks findings; the mapping is many-to-one. An implementer sets `progress.status` on each finding in its task separately, and a task is clean only when every finding it carries is individually accounted for — done, or blocked with a reason.

**A contest blocks its own finding, not its batch.** The rest of the task proceeds — unless a sibling finding's fix rests on the contested premise, in which case the siblings block too, and the implementer says which and why.

The group is `recorded` once that is true of every finding it holds. That is what frees its files for a late ruling, and what the drain rule counts.

## Progress reporting

{{SDD_PROGRESS_REPORT}}

Units here are groups, with finding tallies from the docket's queues: `recorded (N findings) / in-flight / blocked / grouped / ruled-ungrouped`; an intake sweep is also a print trigger, and a blocked cell names the contest awaiting the human's answer or a re-ruling. The chart is chat-only. This workflow carries a `status.md`, created at the first pause, and it is a batch surface, never a queue: it holds the unblock pass's cards and any orphan escalation awaiting the human, each kept whole once answered, with the human's words on its `Answer:` line — `pnpm cards answer` moves it, `pnpm cards pending` finds a ruling the human typed into the file, and its `withdraw`, `reopen` and `supersede` serve a premise found false before the answer, one found false after it, and a changed ruling, exactly as in the development skill. Questions and pushback keep their home in the docket (the Blocked queue, notes, the questions sweep) — a second queue for the same decisions would split it, which is why nothing else goes in the file.

{{SDD_CARD}}

## Doc changes

{{SDD_DOC_CHANGES_FILE}}

## Close

**The run ends on a drain, not on a clock.** Close when no ruled finding is ungrouped and every group has reached `recorded`. Fresh findings ruled after that do not extend the run — they are the next run's intake; the run's own blocked findings are not fresh intake but the unblock pass's work. Without this rule the run never ends, because the input never stops.

**The unblock pass runs between the drain and the close steps, and it has no cap.** A drained run can still hold blocked findings — contests and questions awaiting the human. Batch them: write one card per blocked finding into `status.md` — the class, the evidence, what would unblock it — and hand the batch to the human. Each answer comes back as a mandated relay through `unblock`, or as the human's own act in the console; the unblocked findings re-enter the group flow from the premise check, and the pass repeats — over any new blocks the answers produce — until the blocked queue holds only findings the human has explicitly deferred. A deferral is itself a human word and reaches the finding the same two ways — relayed under mandate, or written by the human in the console — so the reconcile step can read it there. Deferral is the only way a perpetually stuck finding leaves the pass; the pass never ends by giving up on one.

1. **Full unscoped pass:** {{SDD_UNSCOPED_PASS}}
2. {{SDD_BATCHED_CLOSE_FIXER}}
3. {{SDD_RUN_DECLARED_E2E}}
4. **Reconcile the docket against reality.** Every finding this run touched carries a terminal `progress.status`: `done` with a note naming what was changed, or `blocked` with a note naming the class and evidence. Read the progress queue back and confirm it holds no `in-progress` finding — one at close is a finding nobody finished or recorded — and that no finding this run set `done` now reads `not-started`: a decision taken since resets the status, so work that was recorded stops being recorded, and it has to be re-checked against the new ruling. Confirm too that the blocked queue holds only findings the human explicitly deferred — a block at close that nobody deferred is an unblock pass that stopped early.
5. **The docket's own format check passes.** A format violation introduced by a run's own writes is a defect in that run.
6. **Completeness critic:** one auditor-type agent with a close-out brief asks what is missing — a finding claimed done whose criteria are not all met, a class fixed at one instance and not the others, a doc the work invalidated.
7. **Doc proposals:** {{SDD_DOC_PROPOSALS}}
8. Summarize per group: what shipped, what is blocked and awaiting the human's answer or a re-ruling, what you judged already satisfied.

## Scoped checks (compute per task, record in `plan.md`)

{{SDD_SCOPED_CHECKS}}

## Standing rules

{{SDD_STANDING_RULES}}

- **A task's acceptance criteria live in the finding, not in `plan.md`.** What the rule above requires is that a task's implementer and its auditor judge against the identical criteria; here they get that from the identical ruled-option brief command in both READ lists, which reads the live finding, rather than from a copy in `plan.md` that a re-ruling would leave behind.
- **Ruled findings only**, and `state`, `ruling`, `severity` and `denial` are never an agent's decision — a mandated relay of the human's is the one way any of them moves, and it is the orchestrator's alone.
- **`progress.verified` is the human's verdict**, always — relayed under mandate or not set at all.
- **No agent reads or edits a finding file directly** — every read and every write goes through `pnpm docket`.
- **Never blindly carry out a ruling, and never relitigate one without evidence.** Both are failures of the same discipline.
- **A finding's outcome is recorded in the docket**, not only in `plan.md` and not only in chat.

## Subagents

{{SDD_SUBAGENTS}}

The **codebase-explorer** is your default premise-checker: one per group, reading `docs/audits/CLAUDE.md`, the census output and the all-options brief, returning one verdict per finding and the evidence behind it. The **analyst** is the escalation above it, for contest candidates and design-bearing rulings. Neither decides what happens next — already-satisfied and contested are outcomes you act on.
