---
name: debug-e2e
description: Investigate E2E test failures end-to-end. Reads the latest report, examines all failing tests, traces through API calls, domain code, and test code to diagnose root causes. Use when E2E tests fail and you need to understand why.
argument-hint: [additional instructions or focus area]
---

# E2E Failure Investigation

Fully investigate all E2E test failures. No shortcuts, no "needs further investigation", no TBDs.

<!-- If any file or directory referenced in this skill does not exist where expected,
     stop and tell the user this skill is stale and needs updating. -->

## Additional Instructions

$ARGUMENTS

## Step 1 — Find the Latest Report

1. List directories in `e2e/report/` and pick the most recent timestamp
2. Read `e2e/report/<latest>/REPORT.md` for the high-level summary
3. Read `e2e/report/<latest>/report.json` for structured data

If no report exists, tell the user to run `pnpm e2e` first and stop.

## Step 2 — Catalog All Failures

For every failed and flaky test in the report:

1. Note the test name, file, project, and error message
2. Group failures that share the same root error or same file
3. Investigate every failure with equal depth — infrastructure failures (timeouts, server startup, WebSocket drops) are just as important as assertion failures. They indicate real problems in the test infrastructure or application startup that need fixing.

## Step 3 — Deep Investigation Per Failure

For EACH failed test, do ALL of the following:

### 3a. Read the full error
- Read `e2e/report/<latest>/failed/<test-slug>/error.txt`
- Identify the assertion or timeout that failed
- Note the exact expected vs actual values

### 3b. Read the test code
- Open the test file at the line indicated in the report
- Understand what the test is trying to verify
- Read the full `test()` or `it()` block, including setup and teardown
- Identify which page objects, fixtures, or helpers the test uses

### 3c. Trace the execution steps
- Read `e2e/report/<latest>/failed/<test-slug>/steps.json`
- Identify the last successful step before the failure
- Note any steps with unusually long durations (potential flakiness)

### 3d. Examine API calls
- Read `e2e/report/<latest>/failed/<test-slug>/network.har`
- Look for: failed API responses (4xx/5xx), slow responses, missing responses
- For each relevant API endpoint, trace it to the backend route handler

### 3e. Examine console errors
- Read `e2e/report/<latest>/failed/<test-slug>/console-errors.txt`
- Correlate console errors with the test failure — are they the cause or a symptom?

### 3f. Examine the page state
- Read `e2e/report/<latest>/failed/<test-slug>/page-snapshot.txt`
- Check: was the expected element present? Was the page in the right state?
- Look for unexpected modals, loading spinners, or error banners

### 3g. Read the domain code
- For each API endpoint involved, read the route handler in `apps/api/`
- For each UI component involved, read the component in `apps/web/`
- For shared logic, read the relevant package in `packages/`
- Understand the full data flow: frontend action → API call → database → response → UI update

### 3h. Check for recent changes
- Run `git log --oneline -20 -- <relevant-files>` for files involved in the failure
- If a file was recently changed, read the diff to see if the change could have caused the failure

## Step 4 — Diagnose Root Causes

For each failure, determine ONE of:

1. **Bug in application code** — the code is wrong, explain exactly what and where
2. **Bug in test code** — the test has incorrect assertions or setup, explain what's wrong
3. **Test infrastructure issue** — timing, race condition, server startup, or environment issue — explain the exact mechanism and what needs to change to fix it
4. **Stale test** — test doesn't match current behavior after a legitimate change

**When tests and application behavior disagree, do NOT assume either is correct.** Ask the user which represents the intended behavior. Present both sides:
- "The test expects X because [reason from test code]"
- "The application does Y because [reason from domain code]"
- "Which is the intended behavior?"

## Step 5 — Present Findings

For each failure, present:

### [Test Name] ([project])

**File:** `test-file:line`
**Error:** [one-line summary]

**Root Cause:** [Bug in app | Bug in test | Infrastructure | Stale test]

**What happened:**
[2-3 sentence narrative of the failure, tracing from user action to error]

**Evidence:**
- [Step X] succeeded at [time] → [Step Y] failed because [specific reason]
- API call to `POST /api/...` returned [status] with [relevant detail]
- Console error: [relevant error]
- Page state: [what was/wasn't visible]

**Code involved:**
- `apps/api/src/routes/chat.ts:42` — [what this code does relevant to the failure]
- `apps/web/src/hooks/use-chat-stream.ts:87` — [what this code does]

**Fix:** [Concrete fix with file paths and what to change, OR question to user if ambiguous]

## Rules

- **No TBDs.** Every failure gets a diagnosis. If you cannot determine the cause from the report alone, read more code until you can.
- **No "needs further investigation."** Investigate it now. You have all the tools.
- **All failures matter equally.** Timeouts, infrastructure errors, and flaky tests get the same depth of investigation as assertion failures. They all indicate something that needs fixing.
- **No assumptions about intent.** When test expectations conflict with app behavior, ask the user.
- **Read the actual code.** Do not guess what a function does from its name. Open the file.
- **Trace end-to-end.** Follow the data from the UI action through the API to the database and back.
- **Be specific.** File paths, line numbers, variable names, exact values.
- **Group related failures.** If 5 tests fail because of the same API bug, say so once, not 5 times.
- **Check for cascading failures.** One root cause can produce multiple test failures. Identify the root.
- **Report staleness.** If any file referenced in this skill does not exist at the expected path, stop and tell the user the skill needs updating.
