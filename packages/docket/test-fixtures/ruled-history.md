---
id: "BILL-12"
title: "Settlement charges the estimate when the provider returns \"usage.cost\": 0"
severity: "high"
kind: "decision"
status: "latent"
status_note: "only reachable when the gateway omits inline cost"
area: "apps/api"
needs_ruling: true
needs_options: false
warning: false
related: []
group: null
dedicated: false
state: "ruled"
ruling:
  option: "B"
  text: "Charge the estimate and flag it, but raise one Sentry event so a human resolves it. “Estimated” must never be silent."
  note: "Keep fee application at the port seam."
  at: "2026-07-30"
denial: null
history:
  - { at: "2026-07-29", kind: "ruling", superseded_at: "2026-07-30", option: "A", text: null, note: null }
  - { at: "2026-07-28", kind: "denial", superseded_at: "2026-07-29", reason: "Refuted at triage: the gateway always returns a cost.", by: "audit" }
questions:
  - { at: "2026-07-28", text: "Does the images API ever return an inline cost?", answer: "No. It is charged at the deterministic catalog estimate.", answered_at: "2026-07-29" }
progress:
  status: "in-progress"
  updated: "2026-07-30"
  verified: false
  notes:
    - { at: "2026-07-30", by: "agent", text: "Reproduced with a zero-cost response.\nThe estimate path is reached, the flag is not set." }
    - { at: "2026-07-30", by: "human", text: "Ship the flag first. 日本語, “curly quotes” and a tab\tall survive." }
---

**What this is.** A zero inline cost is indistinguishable from a missing one, so the
fallback never fires and the charge lands unflagged.

## Options

### A — Treat zero as authoritative
effort: low · risk: silently under-charges

Trust the inline value even at zero.

### B — Treat zero as missing and flag the estimate
**Recommended** · effort: low · risk: over-flags a genuinely free call

Fall back to the admission estimate and mark it estimated.
