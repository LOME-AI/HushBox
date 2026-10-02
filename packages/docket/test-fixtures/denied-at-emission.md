---
id: "CLEAN-1"
title: "Session cookies were reported as readable by client script"
severity: "low"
kind: "defect"
status: "live"
status_note: null
area: "apps/api"
needs_ruling: false
needs_options: true
warning: false
related: []
group: null
dedicated: false
state: "denied"
ruling: null
denial:
  by: "audit"
  reason: "Refuted: the session cookie is set httpOnly and the claim did not survive verification."
  at: "2026-07-30"
history: []
questions: []
progress:
  status: "not-started"
  updated: null
  verified: false
  notes: []
---

**What this is.** A search hit suggested the session cookie was reachable from client
script. It is not, so this finding ships refuted rather than open.

**Why it is recorded.** So a later run suppresses the claim instead of rediscovering it.
