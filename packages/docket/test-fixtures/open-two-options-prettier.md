---
id: "AI-1"
title: "The database connection is torn down while post-response work is still using it"
severity: "critical"
kind: "defect"
status: "live"
status_note: null
area: "apps/api"
needs_ruling: true
needs_options: false
warning: true
related:
  - "AI-5"
  - "AI-9"
group: "connection-lifecycle"
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

**What this is.** The pipeline closes the connection before deferred work runs, so any
post-response query sees a dead handle.

**Current behavior.** The teardown is unconditional at
`apps/api/src/middleware/pipeline-bindings.ts:68`.

## Options

### A — Pipeline owns post-response scheduling

**Recommended** · effort: medium · risk: architectural seam

Move scheduling into the pipeline so the connection outlives the deferred work.

### B — Copy the connection into the deferred closure

effort: low · risk: leaves the ownership question open

Cheaper, but the lifetime question returns the next time something defers.
