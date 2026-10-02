---
name: frontend-design
description: Build or reshape HushBox UI to a high craft bar. Use for any frontend design work (websites, landing, dashboards, product UI, components, forms, settings, onboarding, empty states) and for visual hierarchy, typography, color, layout, motion, UX copy, accessibility, responsive behavior, anti-patterns, and design systems. Runs a generate then detect then audit then fix loop against HushBox's committed identity. Accepts an optional additional-instructions argument. Not for backend-only or non-UI tasks, and not invoked inside a subagent-driven run, where the sdd-ui-implementer and sdd-ui-auditor agents carry its rules.
---

# Frontend Design (HushBox)

Design and iterate production-grade HushBox UI: real working code, committed choices, exceptional craft. You own HushBox's identity; execute it so well it could not be mistaken for any other product, and run the review loop until the work is genuinely clean.

This skill owns the **process** and the **always-on craft rules**. The project specifics live in two files that setup loads: strategy (who, why, principles, anti-references) in `docs/PRODUCT.md`, and the visual system (palette, type, radius, components) in `docs/DESIGN.md`. Derive every color and type decision from `DESIGN.md`; do not restate token values here. If the codebase contradicts this skill (renamed tokens, moved files, changed routes), follow the code and tell the user the skill needs updating.

## Optional argument: additional instructions

The user may pass freeform text after the skill name as additional instructions (a hint, a constraint, a focus, a target surface). Treat it as the highest-priority steer for this run, layered on everything below. It never overrides the accessibility floor or the absolute bans, but it narrows scope and biases the direction. If absent, infer scope from the request.

{{FD_SETUP}}

{{FD_DIRECTION}}

## The review loop

After generating or changing UI, run this loop. It has **no iteration maximum**; it runs until the stop gate is satisfied.

1. **Detector (you, the main agent).** Run it over the changed surface as §Detector states, control run included. Keep the JSON; do not show it to the audit subagent.
2. **Audit (one subagent).** Spawn the `design-review` subagent (`.claude/agents/design-review.md`), the only review agent. It drives Playwright MCP and Chrome DevTools MCP, screenshots the running app at 1440 / 768 / 375, and grades against `DESIGN.md` plus universal floors. Give it a self-contained prompt (cwd, target, live URL, the additional-instructions argument). **Do not pass detector output into its prompt;** it stays blind to the detector until you adjudicate.
3. **Adjudicate (you).** Once the subagent returns, bring both streams together. For every audit finding, decide real problem or false positive (a deliberate choice in `DESIGN.md` that the generic rubric flagged). **Fix every real one.**
4. **Gate.** Stop only when both hold at once: the detector passes as §Detector states on your changed surface, AND every audit finding is adjudicated with all real ones fixed and no unresolved true positives. False positives may remain; real ones may not. Else fix and re-run from step 1.

Two standing notes:

- If the codebase contradicts this skill, follow the code and tell the user which part needs updating.
- If a detector rule looks wrong for HushBox (it flags a committed, reasoned choice), do not silently suppress it. Tell the user what fired and why, and propose a suppression in `.impeccable/config.json` or a rule change. The only rule already suppressed is `cream-palette` (the committed warm paper).

{{FD_DETECTOR}}

{{FD_CRAFT_FLOOR}}

{{FD_BANS}}

{{FD_SLOP_TEST}}

{{FD_COPY}}

{{FD_WIDGET}}

{{FD_RESTRAINT}}

{{FD_SURFACES}}

{{FD_COMMANDS}}
