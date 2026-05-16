---
name: fix-duplication
description: Investigate the worst jscpd duplication findings, classify each as true or false positive, and produce a per-item refactor plan or ignore justification. Plan only — execution requires explicit approval per item.
disable-model-invocation: true
argument-hint: [additional instructions]
---

# Fix Duplication

Investigate the top jscpd findings, classify each, and produce per-item refactor plans or false-positive justifications. **Plan only** — never execute refactors without explicit per-item approval.

<!-- If any file or directory referenced in this skill does not exist where expected,
     stop and tell the user this skill is stale and needs updating. -->

## Additional Instructions

$ARGUMENTS

The above may overrule defaults in this skill (priority, depth, output shape, count cap, package destinations). It may **not** overrule the hard constraints in the next section — if an instruction conflicts with one of those, follow the constraint and surface the conflict.

## Hard Constraints

- **Behavior preservation** — refactors produce identical observable behavior. Same inputs → same outputs, same side effects, same error paths. Any logic change is a separate task. If you spot a bug in the duplicated code, flag it; do not silently fix it during extraction.
- **95% coverage maintained** — no refactor may reduce line / branch / function coverage. Extracted abstractions need new tests; reused tests must still exercise the new seam.
- **Strict TDD for new abstractions** — failing test first, watch it fail for the expected reason, minimal implementation, watch it pass. No tests-after.
- **Avoid eslint-disable** — if the only way to extract is via a disable comment, reconsider the classification (it's likely a false positive).
- **No execution without per-item approval** — the skill ends at a menu. Wait for explicit "do #N" before touching code.

## Step 1 — Run the Linter

1. Run `pnpm lint:duplication` (executes `jscpd --threshold 2 --silent .`).
2. Read the JSON report at `reports/jscpd/jscpd-report.json` (path is defined in `.jscpd.json`).
3. If the report file is missing, re-run without `--silent` to surface the failure, then stop.

Config lives at `.jscpd.json`. Note `minLines: 5`, `minTokens: 50`, and the existing `ignore` list — `*.test.ts` / `*.test.tsx` are already excluded, so production code and test *support* (factories, fixtures, helpers under `e2e/`, etc.) are what will appear.

## Step 2 — Group & Rank

jscpd reports duplications pairwise. Before deep analysis:

1. **Group transitive duplications** — if A↔B and B↔C cover overlapping fragments, treat them as one group `{A, B, C}`.
2. **Rank by severity** — primary key `tokens` per group; tiebreaker is file count (more files = more drift risk). Take the **top 10**. If fewer than 10 groups exist, investigate all of them.
3. Print the ranked list as a one-line-per-finding preview before deep analysis, so the user can interrupt if priorities look wrong.

## Step 3 — Deep Investigation per Finding

For EACH ranked finding, do ALL of the following before classifying:

### 3a. Read every copy in full
Open each `file:startLine-endLine` and read the full surrounding function / component / module — not just the flagged span. The same 12 lines mean different things inside a 15-line function vs a 200-line function.

### 3b. Trace callers and contracts
Grep for callers of each function or component containing the duplication. Understand what each call site relies on. Subtle contract differences (return shape, throwing vs returning, side-effect ordering) are the most common reason "obvious" extractions break behavior.

### 3c. Search for existing helpers first
Before proposing a new abstraction, grep `packages/shared`, `packages/ui`, `packages/crypto`, and the local package for utilities already doing similar work. **Reuse beats extract.** If a helper exists and devs duplicated because they missed it, the plan is "replace with existing helper", not "extract new one".

### 3d. Map test coverage
For each duplicate region, identify the tests that exercise it today (grep test files, check colocated `*.test.*` neighbors). Record: which tests cover each side, whether they will still exercise the abstraction transitively through the new seam, and what new tests the extracted code will need.

### 3e. Check for existing lint suppressions
Note any `eslint-disable`, `// @ts-`, or jscpd ignore markers inside or adjacent to the duplicated region. They may need to migrate to the extracted code — or signal a deeper smell that argues against extraction.

### 3f. Detect cross-finding conflicts
Track which files each finding touches. If two findings touch the same file, flag them as a **conflict group** — they must be planned (and executed) together because refactoring one may dissolve, reshape, or collide with the other.

## Step 4 — Classify

Mark each finding as **TRUE POSITIVE**, **FALSE POSITIVE**, or **BORDERLINE**.

### True positive
Real duplication, removable without harming clarity, yields a sound (non-leaky) abstraction.

### False positive
One of:
- **Coincidental similarity** — same syntactic shape, different domain meaning (e.g., two unrelated reducers with the same `switch` skeleton). Extracting would force a leaky abstraction.
- **Required by framework / external schema** — boilerplate the framework or external API contract demands; varying it would break the contract.
- **Generated or vendored code** — belongs in `.jscpd.json` `ignore` if not already.
- **Clarity-over-DRY in test support** — applies to fixtures / factories / helpers (in-file tests are already ignored by config). **Use precisely with strong justification** — the default is that test support code dedupes the same as production. Acceptable rationale: extracting would make a fixture less readable as a literal example of the shape under test, or would couple two unrelated test scenarios.

For each false positive, recommend either:
- **Ignore (no config change)** — accept the finding; one-off, not worth code churn or a config rule. State why so reviewers don't re-raise it.
- **Add to `.jscpd.json` ignore list** — the pattern is generated / vendored / structurally boilerplate forever. Give the exact glob to add to the existing `ignore` array in `.jscpd.json`.

### Borderline
If a finding is genuinely ambiguous (you can argue both ways with comparable strength), **do not auto-decide**. Surface it as a question in the output and let the user choose.

## Step 5 — Plan Refactors (True Positives Only)

For each true positive, design a refactor that:

1. **Preserves behavior exactly.** Identical observable outputs and side effects.
2. **Reuses existing helpers** when Step 3c found one. Otherwise extract a new function / component / hook.
3. **Places extracted code in the right home**:
   - Cross-package duplication → the package that owns the domain (`packages/shared`, `packages/ui`, `packages/crypto`, `packages/db`, etc.).
   - Same-package duplication → a local `lib/`, `utils/`, or sibling module.
   - UI primitives → `packages/ui`.
   - Test support → the nearest shared `factories/` or `fixtures/` dir.
4. **Specifies test impact**:
   - Whether existing tests still cover the original call sites transitively through the new seam (usually yes).
   - New unit tests required for the extracted abstraction, listed by behavior.
   - Coverage delta target: ≥ current.
5. **Does not introduce `eslint-disable`.** If extraction requires one, reclassify as false positive.
6. **Tags complexity**:
   - **Simple** — pure extract-function, no shared state, drop-in replacement.
   - **Medium** — cross-package move with import updates; minor interface design.
   - **Complex** — new interface needed, subtle contract differences across call sites, or part of a conflict group.

## Step 6 — Present Findings

Print the **Ranked Preview** table first, then a per-item block in rank order.

### Ranked Preview

```
#   Tokens  Lines  Files  Verdict        Complexity   Conflict
1   180     22     3      True positive  Medium       —
2   140     14     2      False positive —            —
3   120     12     2      Borderline     —            with #5
...
```

### Per Item

#### Finding #N — `<short label>`

**Locations**
- `path/a.ts:42-63`
- `path/b.ts:11-32`
- `path/c.ts:88-109` (if grouped)

**Duplicated:** 22 lines / 180 tokens
**Expected reduction:** ~44 lines removed, 22 lines added (net −22) + 1 new test file
**Test coverage today:** `a.test.ts`, `b.test.ts` cover both sides; `c.ts` site uncovered
**Existing helper search:** none found / `packages/shared/src/x.ts` exists — reuse instead
**Conflict group:** none / shares files with Finding #M

---

**Verdict:** True positive (Simple | Medium | Complex)

**Design** — 2–5 sentences. What gets extracted, where it lives, how callers change. If reusing an existing helper, name it.

**Tests** — behaviors the new abstraction needs covered (TDD). Note explicitly whether existing tests transitively cover it.

**Risk** — anything subtle: same-name-different-meaning, exception ordering, side-effect timing, generic type erosion.

---

OR

**Verdict:** False positive — Ignore | Add to `.jscpd.json`

**Reasoning** — 2–3 sentences. Why these look alike but aren't the same thing, or why extraction would harm clarity.

If adding to `.jscpd.json`, give the exact glob to append to the existing `ignore` array:
```json
"**/path-or-pattern/**"
```

---

OR

**Verdict:** Borderline — needs your call

Argument for true positive: …
Argument for false positive: …
**Which way?**

## Step 7 — Action Menu and Approval

End with a numbered menu. **Wait for explicit approval** before executing any item.

```
Approve which items to execute? Reply e.g. "do #1, #3, #7", "all true positives", "skip all".

#1 — Extract <thing> to packages/shared (Simple, 3 files)
#3 — Replace duplicated <thing> with existing helper packages/shared/src/x.ts (Simple, 2 files)
#7 — Move <thing> to packages/ui/composites (Medium, 4 files; conflicts with #9)
...
```

On approval, for each approved item:

1. Write the failing test for the new abstraction first.
2. Watch it fail. Confirm the failure mode is the missing implementation (not a typo).
3. Implement the minimal extraction.
4. Watch it pass.
5. Update all call sites; run typecheck on affected packages.
6. Re-run `pnpm lint:duplication` and the relevant `pnpm test:<package>` (with coverage if needed). Verify: duplication count down by the expected amount, all tests green, coverage ≥ before.
7. Move to the next approved item.

If multiple approved items share files (conflict group), execute them as a single coherent pass rather than sequentially.

## Rules

- **No execution without explicit per-item approval.** Plan first, menu second, approval third, code fourth.
- **No silent classification on borderline cases.** Surface and ask.
- **No `eslint-disable` as a shortcut.** If extraction needs one, reconsider the verdict.
- **Behavior-preserving only.** This skill refactors; it does not change logic. Flag bugs found in the duplicated code, do not fix them inside this workflow.
- **Coverage never drops.** New abstractions get new tests, TDD-first.
- **Read full surrounding context** — never classify from the jscpd fragment alone.
- **Reuse before extract** — always check for an existing helper first.
- **Report staleness** — if `.jscpd.json`, the `pnpm lint:duplication` script, or `reports/jscpd/jscpd-report.json` doesn't exist where expected, stop and tell the user this skill is stale.
