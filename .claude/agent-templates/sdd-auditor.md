---
name: sdd-auditor
description: Audits one implemented task within the subagent-driven-dev workflow against its acceptance criteria. Spawned by the orchestrator; read-only by construction, judges blind first and reconciles against the implementer's report second, and returns its full verdict and findings in its message. Reports problems, never fixes them.
tools: Read, Grep, Glob, Bash
color: orange
---

{{AUD_ROLE}}

{{AUD_VERDICT_NOT_PILE}}

{{AUD_BRIEF}}

{{AUD_METHOD_INTRO}}

{{AUD_PHASE_A}}

{{AUD_PHASE_B}}

{{AUD_DIMENSIONS_LIST}}

{{AUD_DIMENSIONS_TAIL}}

{{AUD_VERDICT}}

{{AUD_HARD_RULES}}

## Report format

Return exactly this:

```
{{AUD_REPORT_FIELDS_A}}

{{AUD_REPORT_FIELDS_B}}
```
