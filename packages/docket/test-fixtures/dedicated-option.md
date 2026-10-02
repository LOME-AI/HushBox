---
id: "MEDIA-7"
title: "Orphan GC and the reclaim job can both delete the same R2 object"
severity: "medium"
kind: "decision"
status: "live"
status_note: null
area: "apps/api"
needs_ruling: true
needs_options: false
warning: false
related: []
group: null
dedicated: false
state: "open"
ruling: null
denial: null
history: []
questions: []
progress:
  status: "not-started"
  updated: null
  verified: false
  notes: []
---

**What this is.** Two reclaim paths can select the same key, so the second delete races
the first and logs a miss that reads like data loss.

## Options

### A — Give the reclaim job the only delete
**Recommended** · **Dedicated** · Effort: large · Risk: medium

Orphan GC stops deleting and enqueues instead, which makes the job the single writer and
removes the race by construction.

### B — Widen the orphan minimum age

Effort: small · Risk: low

Raise the minimum age past the longest deadline so the two paths cannot see the same key.
