---
name: frontend-design
description: Build or reshape HushBox UI to a high craft bar. Use for any frontend design work (websites, landing, dashboards, product UI, components, forms, settings, onboarding, empty states) and for visual hierarchy, typography, color, layout, motion, UX copy, accessibility, responsive behavior, anti-patterns, and design systems. Runs a generate then detect then audit then fix loop against HushBox's committed identity. Accepts an optional additional-instructions argument. Not for backend-only or non-UI tasks.
---

# Frontend Design (HushBox)

Design and iterate production-grade HushBox UI: real working code, committed choices, exceptional craft. You own HushBox's identity; execute it so well it could not be mistaken for any other product, and run the review loop until the work is genuinely clean.

This skill owns the **process** and the **always-on craft rules**. The project specifics live in two files that setup loads: strategy (who, why, principles, anti-references) in `docs/PRODUCT.md`, and the visual system (palette, type, radius, components) in `docs/DESIGN.md`. Derive every color and type decision from `DESIGN.md`; do not restate token values here. If the codebase contradicts this skill (renamed tokens, moved files, changed routes), follow the code and tell the user the skill needs updating.

## Optional argument: additional instructions

The user may pass freeform text after the skill name as additional instructions (a hint, a constraint, a focus, a target surface). Treat it as the highest-priority steer for this run, layered on everything below. It never overrides the accessibility floor or the absolute bans, but it narrows scope and biases the direction. If absent, infer scope from the request.

## Setup (once per session)

1. **Load context.** Run `node .claude/skills/frontend-design/scripts/context.mjs` (add `--target <path>` for a specific surface in this monorepo). It prints `PRODUCT.md` and `DESIGN.md`, which HushBox keeps in `docs/`. If it reports `NO_PRODUCT_MD`, follow `reference/init.md` then `reference/document.md` to write them into `docs/`, then continue. Skip the re-run if you have already seen its output this conversation.
2. **Read the register.** `reference/product.md` for app UI (chat, settings, account, billing, auth) or `reference/brand.md` for marketing, the public site, and `/welcome`. One per task, by the surface in focus.
3. **Read DESIGN.md and the token source** (`packages/config/tailwind/index.css`) plus one representative component. Reuse what is there; derive every color and type decision from them.
4. **Set the dials** from the table below, and declare the read in one line ("Reading this as: `<surface>` for `<audience>`, `<vibe>`").

## Direction

HushBox is warm, quiet-but-expressive, editorial, privacy-first. The committed identity (palette, type, radius) is canonical in `DESIGN.md`; the strategy and design principles are in `PRODUCT.md`. Honor both.

- **Committed is not reflex.** A common-looking choice that is deliberate and recorded in `DESIGN.md` is not slop. Rarity is not the test, intent is. Never sand a committed choice toward something less common.
- **Expressive by default.** Set the dials per surface (below). Calm (reduced or no motion) is opt-in through the accessibility widget, never the silent default.
- **Type roles.** Reading surfaces use the editorial serif; product UI chrome uses the UI sans; code and data use mono. The families are in `DESIGN.md`.

### Dials (set per surface)

Three dials, each 1 to 10: `DESIGN_VARIANCE` (1 symmetric, 10 asymmetric), `MOTION_INTENSITY` (1 static, 10 cinematic), `VISUAL_DENSITY` (1 airy, 10 packed). The baseline is the expressive `8 / 6 / 4`; tune per surface:

| Surface | VARIANCE | MOTION | DENSITY |
|---|---|---|---|
| Marketing, /welcome, landing | 8 | 6 | 3 to 4 |
| Chat thread | 5 to 6 | 4 to 5 | 3 to 4 |
| Settings, account, billing | 3 to 4 | 3 | 5 to 6 |
| Auth, onboarding, empty states | 6 | 5 | 4 |

Above `VISUAL_DENSITY 7`, prefer line dividers over card containers.

## The review loop

After generating or changing UI, run this loop. It has **no iteration maximum**; it runs until the stop gate is satisfied.

1. **Detector (you, the main agent).** Run the deterministic scanner on the changed surface:
   ```bash
   node .claude/skills/frontend-design/scripts/detect.mjs --json <file-or-dir>
   ```
   Exit `0` = clean (`[]`), `2` = findings, `1` = detector missing. Pass markup/style/component files or a directory. Keep the JSON; do not show it to the audit subagent.
2. **Audit (one subagent).** Spawn the `design-review` subagent (`.claude/agents/design-review.md`), the only review agent. It drives Playwright MCP and Chrome DevTools MCP, screenshots the running app at 1440 / 768 / 375, and grades against `DESIGN.md` plus universal floors. Give it a self-contained prompt (cwd, target, live URL, the additional-instructions argument). **Do not pass detector output into its prompt;** it stays blind to the detector until you adjudicate.
3. **Adjudicate (you).** Once the subagent returns, bring both streams together. For every audit finding, decide real problem or false positive (a deliberate choice in `DESIGN.md` that the generic rubric flagged). **Fix every real one.**
4. **Gate.** Stop only when both hold at once: the detector returns zero issues, AND every audit finding is adjudicated with all real ones fixed and no unresolved true positives. False positives may remain; real ones may not. Else fix and re-run from step 1.

Two standing notes:
- If the codebase contradicts this skill, follow the code and tell the user which part needs updating.
- If a detector rule looks wrong for HushBox (it flags a committed, reasoned choice), do not silently suppress it. Tell the user what fired and why, and propose a suppression in `.impeccable/config.json` or a rule change. The only rule already suppressed is `cream-palette` (the committed warm paper).

## Always-on craft floor

Every surface honors these. For depth, load the matching guide (`reference/typeset.md`, `colorize.md`, `layout.md`, `animate.md`, `interaction-design.md`).

- **Color.** Body text at least 4.5:1 against its background; large text (18px or bold 14px) at least 3:1; placeholders the same 4.5:1. Gray on a colored background reads washed out; use a darker shade of that hue, or a transparency of the text color. Colors come from the tokens; no stray hex.
- **Typography.** Body line length 65 to 75ch; body at least 16px. Display ceiling about 6rem; display letter-spacing floor -0.04em. `text-wrap: balance` on headings, `pretty` on long prose.
- **Layout.** Vary spacing for rhythm. Cards only when truly the best affordance; never nested. Flexbox for 1D, Grid for 2D. A semantic z-index scale, never arbitrary 999 or 9999.
- **Motion.** Use Framer Motion for orchestration (cascades, layout and shared-element animation, AnimatePresence exits, springs) and CSS keyframes plus the View Transitions API for cheap and native motion (pulses, hovers, route and theme morphs), by role. Ease out with exponential curves; no bounce or elastic. Do not animate layout properties casually.
- **Interaction.** Dropdowns inside an `overflow: hidden` or `auto` container get clipped; use native `<dialog>` / popover, `position: fixed`, or a portal.

## Absolute bans (match and refuse, then rewrite)

- Side-stripe borders (`border-left/right` > 1px as a colored accent).
- Gradient text (`background-clip: text` over a gradient).
- Glassmorphism as a default decoration.
- The hero-metric template (big number, small label, stats, gradient accent).
- Identical card grids (same-sized icon + heading + text, repeated).
- A tiny uppercase tracked eyebrow above every section.
- Numbered section markers (01 / 02 / 03) used as default scaffolding.
- Text that overflows its container at any breakpoint.

Copy rules (long dashes, voice, dark patterns) are canonical in `DESIGN.md`; honor them when authoring user-facing copy.

## The AI slop test

If someone could look at this and say "AI made that" without doubt, it failed. Two altitudes: could someone guess the theme and palette from the category alone (first-order), or the aesthetic family from category-plus-anti-references (second-order)? Rework until neither is obvious. The one exception is HushBox's committed identity in `DESIGN.md`: it is deliberate and recorded, so it is not slop for being common. Committed is not reflex.

## Writing and UX copy

Words are design material. Write from the user's side of the screen; name things by what people control, not how the system is built. Active voice; an action keeps the same name through a flow. HushBox's register is direct, technical-but-human, transparent to a fault: confident without hype, never a dark pattern or fake urgency, privacy and cost claims precise. Errors explain what happened and how to fix it, never vague, never apologizing. Where copy is centralized (the shared error-message map keyed by code), change it there, not inline. For depth, load `reference/clarify.md`.

## Design that survives the accessibility widget

HushBox re-paints the whole UI at runtime: users can force contrast, desaturate or simulate color blindness, invert colors, scale type well past default, loosen spacing, swap a dyslexia-friendly face, and stop motion entirely. A design is not finished until it survives all of it. This is the quality floor; build to it without announcing it, and the audit subagent grades against it.

- Never encode meaning in color alone; the one accent must read when desaturated.
- Let content images invert and keep brand art from inverting by using the project's image and brand-mark wrappers, never a raw image element.
- Design fluid: layouts must not break at large type scales or loose spacing.
- **Gate every animation through the project's motion-aware helper so it degrades to a no-op under reduced or stopped motion.** This is what makes "expressive by default, calm on demand" true; never make meaning depend on motion.
- Prefer semantic HTML to ARIA roles, keep keyboard focus visible, tag structural chrome.

## Restraint and signature

Spend boldness in one place. Let one signature element be the memorable thing and keep everything around it disciplined; cut decoration that does not serve the brief. HushBox already concentrates its boldness well (the CipherWall encrypted-state moment, the circular theme-reveal). Before shipping, take one thing away.

## Surfaces

- **Product app** (chat, settings, account, billing): craft is clarity, calm spacing, precise interaction, instant feel. The content is the design; chrome recedes.
- **Marketing and `/welcome`** (Astro): the expressive register, hero-as-thesis, one orchestrated motion moment. Lean editorial-minimalist; reach for a higher-wow treatment only with a real reason.
- **In-conversation content** (Streamdown markdown, Shiki + mono code, KaTeX, React Virtuoso lists): readable measure, code-block craft, smooth virtualized scroll, not animation.

## Commands (load on demand)

Build: `craft` (shape then build), `shape` (plan first), `init` (write PRODUCT.md), `document` (write DESIGN.md), `extract`. Refine: `polish`, `bolder`, `quieter`, `distill`, `harden`, `onboard`. Enhance: `animate`, `colorize`, `typeset`, `layout`, `delight`, `overdrive`. Fix: `clarify`, `adapt`, `optimize`. Each is `reference/<command>.md`; load it when the request maps to it (exact word, or intent: "fix the spacing" loads `layout`, "rewrite this error" loads `clarify`). Evaluation is the review loop above, not a separate command.
