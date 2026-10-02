---
id: "WL-23-B"
title: "The dispatcher re-arms before dead-lettering, so an exhausted row waits a full pass"
severity: "medium"
kind: "defect"
status: "unclear"
status_note: null
area: "apps/api"
needs_ruling: true
needs_options: true
warning: false
related: []
group: null
dedicated: false
state: "open"
ruling: null
denial: null
history: []
questions:
  - { at: "2026-07-30", text: "Is a one-pass delay on an already-dead row worth changing the claim order for?", answer: null, answered_at: null }
progress:
  status: "not-started"
  updated: null
  verified: false
  notes: []
---

**What this is.** Dead-lettering happens at claim time, one pass after the row exhausts
its failure cap.
