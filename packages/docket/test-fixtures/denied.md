---
id: "SEC-LOCK"
title: "Account lock on chargeback is not reversible without a database write"
severity: "low"
kind: "decision"
status: "live"
status_note: null
area: "apps/api"
needs_ruling: true
needs_options: false
warning: false
related:
  - "BILL-12"
group: "disputes"
dedicated: false
state: "denied"
ruling: null
denial:
  by: "human"
  reason: "`user.unlock` is already registered with a registered inverse, so neither option is worth building."
  at: "2026-07-30"
history: []
questions: []
progress:
  status: "not-started"
  updated: null
  verified: false
  notes: []
---

**What this is.** The lock looked one-way at first reading, so the finding shipped open
with two options to choose between. The human declined both rather than choosing, so it was
denied outright and superseded nothing.

## Options

### A — Add a registered unlock operation
effort: low · risk: none

Clear the lock through the admin plane, so reversing it needs no database write.

### B — Leave the lock manual and document the runbook step
effort: low · risk: an operator has to be reachable

Cheaper, but it puts a human in the path of every reversal.
