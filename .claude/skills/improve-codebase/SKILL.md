---
name: improve-codebase
description: Deep quality audit of the codebase (or a scope of it). Fans out research subagents to find defects, security flaws, weak spots, and improvement opportunities; adversarially verifies every finding in batches; emits one audit directory with a file per finding, which the human rules on in the console. The directory is the handoff artifact another actor executes from. Strictly audit, never fixes. Optional scope argument; no argument means the whole repo.
argument-hint: [scope]
---

# Improve Codebase

A full-depth audit run. The goal is the truth about the codebase's quality, held to the highest standard you can defend with evidence. You find problems and specify improvements; you never implement them. The human rules on every finding that needs a ruling before anything becomes a task.

The run produces exactly one deliverable: **an audit directory** at `docs/audits/<YYYY-MM-DD>/` — a run header and one file per finding. You write it once verification is done, and from then on other hands write it: the human rules through the console, implementation agents report progress through the CLI. `docs/audits/CLAUDE.md` is the normative contract for that format, and it loads automatically whenever you work under that directory. Read it before you write your first file. The division of labour is that this skill tells you what to **decide** and the contract owns the **shape** the decision takes: field names, types, defaults, which writer owns which field, the state transitions and the YAML subset live there, and are never restated here or in the audit you emit. Where a rule governs a judgement you have to make — how many options a finding carries, which state it ships in — you will find it stated in both, and **the contract governs**. If the two ever disagree, the contract is right and this skill needs fixing.

The directory is a **handoff artifact**: some other actor, in some later session, executes from it. Write every finding for that reader, who was not here and cannot ask you anything.

The skill is process. Facts about the codebase come from the loaded project docs and from reading code this run, never from this file. If something here contradicts what the repo actually contains, follow the repo and say the skill needs updating.

## Hard constraints

- **Audit only.** No fixes, no git writes, no edits to existing files. The only files you create are the audit directory and its contents.
- **One definition per finding.** Each finding is described in exactly one place — its own file. Severity, evidence, options and state all live there and nowhere else. No summary board, no finding index, no duplicate mention. The console does the navigating, and it reads the files. Two copies of a finding drift, and the reader cannot tell which is current.
- **Do not run repo checks.** No tests, typecheck, lint, build, or coverage. Assume all gates are green. Evidence comes from reading code, not executing it. The format validator is the one exception: it reads what you wrote rather than the codebase, and you run it before handing over.
- **Runnable in any codebase state.** Make no assumptions about prior audits, migrations, or in-progress work. If the working tree is mid-change, audit what is there.
- Every claim that survives to the human is **Verified**: you (or a subagent) read the code this run and cite `file:line`. Inferred and Assumed claims either get verified or get cut.

## Ambition

Findings are not capped at bug reports. The scale runs from a one-line fix to a redesign of an entire subsystem, and everything between: a missing index, a confusing module boundary, a build step that wastes a minute per run, a hand-rolled mechanism a better-maintained library already solves, an architecture that fights the problem it serves. Any problem is fair game. Maintainability friction, developer-experience drag, operational risk, cost, a capability the current design forecloses. If an improvement exists, propose it at whatever size it actually is; don't shrink a structural problem into a cosmetic patch to make the ruling easier. Big proposals carry the same evidence standard as small ones, plus an honest account of migration cost and risk.

## Scope argument

The argument is interpreted loosely: a path (`apps/web`), a slice or domain ("billing", "the admin plane"), or a concern ("security", "error handling") are all valid. Resolve it into a concrete file-set and concern-set, and state that resolution in one or two sentences before fanning out, so a wrong reading dies early. No argument means global: derive the partition yourself from the repo's actual structure (packages, slices, apps) at run time. Never carry a hardcoded list of what the repo contains.

## Phase 1: Orient

One pass in your own context before any fan-out.

1. Read the loaded project docs and follow the on-demand doc index for anything the scope touches.
2. Search `docs/audits/`, `docs/runs/`, and memory for prior rulings. Inside a dated audit directory, a prior ruling is the finding's own `ruling` or `denial`. Build a suppression list: findings the human already rejected or explicitly accepted as-is. These do not get re-raised. A ruling the human approved that was then never implemented, or implemented wrong, is a live finding.
3. Produce a short run manifest: the partition, the review lenses you plan to apply, and a rough subagent count. Show it, then proceed.

## Phase 2: Fan out

Spawn research subagents across the partition. Brief each one with territory and a quality bar, not a checklist. A brief contains:

- The files or domain it owns, plus pointers to the project doctrine it should read first.
- The evidence standard: every claim cited with `file:line`, tagged Verified only.
- The bar: would a top-tier engineer, reading this cold, sign their name to it? Anything they wouldn't sign is reportable: correctness bugs, security holes, invariants the docs declare but nothing enforces, dishonest or missing tests, dead weight, confusing design, silent failure paths.
- An explicit charge to hunt **unknown unknowns**: the most valuable findings are the ones nobody thought to ask about. If something smells wrong and fits no named category, report it anyway.
- A requirement to also report what was inspected and found clean, so "no findings" is distinguishable from "didn't look".

Do not tell agents what specific problems to expect. Steering them toward predicted findings biases them away from real ones.

Derive the lenses per partition rather than fixing them globally. Three durable sources: the invariants the repo declares about itself (each one is a question: is this enforced, or just held by discipline?), the universal lenses any strong reviewer applies (correctness, security, data integrity, failure behavior, test honesty, readability), and whatever the territory itself suggests (a crypto package invites different scrutiny than a marketing page).

Online research agents are allowed and encouraged where the outside world holds the answer: what the current best practice is, whether a dependency is deprecated or has known CVEs, how other systems solve a problem the codebase solves awkwardly, what a library's newer versions offer. Web claims meet the same standard as code claims: cite the source, and mark anything you couldn't confirm.

Run each partition until dry: when a round of differently-angled agents on a territory surfaces nothing new twice in a row, it is done. A fixed agent count is a coverage claim you can't back.

## Phase 3: Adversarial verification

Nothing reaches the human unverified. Verification is done by subagents, not in your own context — you dispatch, read verdicts, and reconcile.

**Batch by territory, not by finding.** One verifier owns one territory and adjudicates every finding in it. A verifier's cost is dominated by loading context, not by reasoning, so a whole territory costs barely more than a single claim — and a verifier holding the whole territory catches scope and severity errors that a single-claim refuter structurally cannot see. Address each batch by explicit finding-ID list, never by line range: line numbers drift, and an edit mid-flight invalidates them.

Brief every verifier to **refute**. Give it the claim and its citations but not the finder's reasoning, and give it the specific project doctrine that could refute its territory's claims — documented intended behavior is the most common refutation there is. Require it to re-locate every citation in the working tree, because line numbers drift. Require it to check the already-adjudicated set first and mark duplicates rather than re-deciding them.

Verdicts:

- **Confirmed**: stands as written.
- **Overstated**: kernel is real, framing or severity is wrong. Rewrite to what the evidence supports.
- **Refuted**: it does not stand. It still ships, as a finding the audit denies with the refutation as its reason, so the next run suppresses it rather than rediscovering it. A plausible-but-wrong finding is itself information.
- **Unfalsifiable**: cannot be settled by reading code — a taste judgement, a prediction, or something that depends on runtime or production data. It ships `open`, with its body saying plainly that verification could not settle it and naming the evidence that would. This is a distinct outcome, not a soft confirm; without it, taste launders itself into verified fact.

Three standing rules, each of which exists because it was learned the expensive way:

- **A proposed fix is a claim and needs its own evidence.** A correct diagnosis does not make its remedy correct. Fixes that would break production, or that re-propose something already rejected, arrive attached to genuinely real findings. Verify the remedy separately, and when it fails, say so louder than the finding itself.
- **A negative claim about coverage must show the search.** "No test would catch this" is unverified until the verifier has looked for the test and quoted what it does or does not assert. This is the single most common way a finding is wrong.
- **Mechanically true is not the same as live.** When a finding says a rule fails to catch something, ask both halves: does the mechanism really fail, _and_ is anything actually exercising the gap today? Sweep for live violations. Latent risk and live breakage are different severities and the human rules on them differently.

Assign severity after verification, never before. Finders inflate. Then merge findings that share a root cause even when the symptoms were reported from different files — the one-definition rule makes this mandatory, not optional. A finding that survives only as a duplicate of another, or that the scope does not cover, ships denied exactly the way a refuted one does.

Separate each surviving finding into one of two kinds, which is the `kind` field. **Defects** have one correct resolution; propose it. **Decisions** have real tradeoffs; present multiple options and recommend one. Getting this split right matters, because the human rules on everything that needs a ruling, and mislabeled defects waste their time while mislabeled decisions hide choices from them. `kind` is not the same axis as whether a finding needs a ruling: a defect whose only fix is expensive or invasive still needs one.

## Phase 4: Emit the audit directory

Write `docs/audits/<YYYY-MM-DD>/` (today's date; suffix `-2` if the name is taken). Always a fresh directory, never a continuation of a prior one. `audit.md` is the run header and every finding is `findings/<ID>.md`. Start from the skeletons in this skill's `template/` directory, and take every field from `docs/audits/CLAUDE.md`.

**This is the run's only deliverable.** Verification detail lives in subagent scratch files that will not survive the session, so absorb everything worth keeping into the findings now — their reader will never see those files.

**The needs-ruling split is the `needs_ruling` field, and its bar is asymmetric.** `needs_ruling: false` is only for the extremely obvious: a wrong comment, a dead export, a missing index, an unbounded input, a stale doc reference. The bar is that **no design choice exists**. Anything with a design decision, a tradeoff, a cost, or a judgement call in it needs a ruling — even a small judgement, even when the fix looks trivial. When in doubt it needs ruling; the cost of asking is far below the cost of a silent decision.

Every finding you emit is one of three shapes. Take them in this order and the first that fits is the one that applies:

- **Refuted, duplicated, or out of scope.** The audit denies it, and the refutation or the reason is the denial's reason. It carries no options and ships `needs_options: true`, because it was never analysed for one; minting an option to fill a slot would fake analysis that did not happen. If the human resurrects it later, that flag routes it to option minting.
- **Obvious**, so `needs_ruling: false`. It ships already ruled, carrying the single correct resolution as its one option. You are asserting there is nothing to choose.
- **Everything else** ships `open`, awaiting the human's ruling, with at least one genuine option and at most one marked `**Recommended**`. Where you cannot responsibly propose a resolution — the problem is large or open-ended — it carries no options at all and ships `needs_options: true`, and says so plainly rather than inventing a fix to fill the slot. Two weak options manufactured to satisfy a count are worse than an honest none.
  An option whose being chosen makes the fix a session's work of its own — a redesign, or a
  blast radius no single reviewable diff absorbs — also carries `**Dedicated**`, on the same
  meta line as `**Recommended**` and independently of it. Where the finding is that size
  whichever option is chosen, set the `dedicated` field instead and mark no option. Emission
  is the only moment either can be written: no agent edits a body afterwards, so a marker
  omitted here is a marker no one can add.

An unfalsifiable finding is not a fourth shape. It ships `open` under that last bullet like any other, and what marks it is its body: say that verification could not settle it by reading code, and name the evidence that would. You ship no questions — questions run one way, from the human to the implementation agent that later works the finding, and the audit writer cannot write them.

The frontmatter each shape carries is specified in `docs/audits/CLAUDE.md`; take it from there rather than deriving it. Those are **emission rules**: they bind you, at creation, and nothing rechecks them afterwards. The human can reopen a finding and leave it in a shape the rules never admitted, and that is legal rather than a defect for anyone to repair. The structural invariants are the separate set that holds for every file forever, and `pnpm docket --validate` is what checks those.

Each finding's body carries what this is about in plain terms, the current behavior with `file:line` evidence, why it needs a ruling, and then its options. The proposal is an option, never a body paragraph: what to do instead belongs in an option rather than the explainer. Acceptance criteria go in the explainer when they hold whichever option is chosen, and in an option's own prose when they differ between options, never both. Write it for someone with zero context who cannot ask you a question. Name the concrete consequence, not the abstraction: who is affected, what they observe, whether it is live today or latent.

Three fields take judgement rather than transcription:

- `title` — one sentence naming the concrete problem. Nothing in the format constrains its length, so never truncate to fit; a title that reads as a paragraph usually means the finding was never sharpened.
- `area` — where the finding lives. When the evidence genuinely does not place it, `unknown` is the correct value. A plausible-looking path you inferred is worse than an honest unknown, because everything downstream filters on this field.
- `severity` — assigned after verification, and it is what carries priority. Ordering and sectioning belong to the console; do not build an index, a severity table, or a table of contents.

Findings that have to be resolved together cite each other through `related`, not through prose no tool can follow.

Use a diagram wherever it carries understanding better than prose: a sequence or state diagram for a race or a lifecycle bug in the finding, severity and area distributions in the run header. A diagram that shows how four steps chain into data loss is worth more than the paragraph describing it.

`audit.md` records what the run covered and what it deliberately did not, how findings were verified, the shape of the result, and the checked-and-clean record: territory inspected and found sound, plus prior rulings suppressed at triage. A finding that was raised and did not survive is a denied finding file, not a line in the header — that is the one-definition rule applied to the ones that failed.

Run `pnpm docket --validate` and clear every violation before Phase 5. A directory the console cannot read is not a deliverable.

## Phase 5: Human rulings

The human rules on **every** finding that needs one, and they do it in the console rather than in chat: tell them to run `pnpm docket`. The console records each ruling, denial and question straight into the finding file. After emission you write no ruling and edit no finding — the body is what the human is ruling on.

Expect to be asked about findings while they work. Batch related items when you are asked about a class of them, answer with evidence, push back when you disagree, and don't fold without new information. If an exchange shows a finding is wrong rather than merely unclear, say so plainly and let the human deny it; rewriting a body underneath a ruling in flight is how the record stops matching what was agreed.

Questions in the console are not yours. They run one way — the human asks, and the implementation agent that later works the finding answers through the CLI. What the human wants from _you_ they ask in chat, here.

## Phase 6: Close out the docket

There is no execution phase. The directory is the handoff artifact; a different actor, in a different session, does the work. Making it usable by that reader means all of this is true when you hand it over:

- Every finding that carries options carries ones concrete enough that choosing one **is** the acceptance criterion. The criterion is the behavior being right, not a fix having been merged; a criterion that tracks merges instead of outcomes drifts from reality.
- Denied findings stay in place with their reason, so a future run suppresses rather than rediscovers them.
- Progress belongs to the implementation agent, recorded in each finding's `progress` through the CLI. You do not seed it and you do not track it.
- `audit.md` states plainly what the run was and that it is the single source of truth for the work it describes. Its frontmatter is exactly the keys `docs/audits/CLAUDE.md` defines and no others: a key the format does not define is a dead field the parser ignores.

What happens to the directory after that — how long it stays live, and what it becomes when it is not — is stated in `docs/audits/CLAUDE.md`, and it is not yours to maintain.
