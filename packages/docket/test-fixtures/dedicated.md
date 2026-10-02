---
id: "WF-4"
title: "The workflow engine has no story for a node whose reducer changes arity between versions"
severity: "high"
kind: "decision"
status: "latent"
status_note: null
area: "apps/api"
needs_ruling: true
needs_options: false
warning: false
related: []
group: null
dedicated: true
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

**What this is.** A reducer's tuple type is part of the edge algebra, so widening one
changes every definition that already saved a fan-in against it.

**Current behavior.** Nothing validates a saved definition against a reducer whose arity
has since moved, so the mismatch surfaces at run time as a type-tag failure.

**Why it needs a ruling.** The fix reaches the registry, the validator, the builder and
every stored definition at once, and which of those absorbs the versioning is undecided.
