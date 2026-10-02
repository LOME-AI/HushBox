---
id: "DT-OWN"
title: "Device-token ownership is split across two slices with no single writer"
severity: "medium"
kind: "decision"
status: "live"
status_note: "true today, but only for the web-push half"
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
questions: []
progress:
  status: "not-started"
  updated: "2026-07-30"
  verified: false
  notes:
    - { at: "2026-07-30", by: "agent", text: "Blocked: the ruling picks a writer, and neither slice can be chosen without one." }
---

**What this is.** Both `notifications` and `identity` write `device_tokens`, which the
single-writer rule forbids. The right owner is not obvious from the code, so no option set
is proposed.
