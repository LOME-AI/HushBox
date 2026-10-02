<!--
Shared body for HushBox frontend craft and the live design review. The
frontend-design skill (SKILL.template.md beside this file), the design-review
agent, and the subagent-driven UI agents (.claude/agent-templates/sdd-ui-*.md)
are assembled from the sections below at generate time (pnpm generate:skills);
none of them duplicates this text by hand. FD_ sections are the craft an agent
that generates UI builds to; DR_ sections are the method an agent that reviews a
running surface follows. Each section marker opens a value named after it; the
value runs until the next marker or end of file. Provenance of the text:
.MAINTAINERS.md.
-->

<!-- @section: FD_SETUP -->

## Setup (once per session)

1. **Load context.** Run `pnpm exec node .claude/skills/frontend-design/scripts/context.mjs` (add `--target <path>` for a specific surface in this monorepo). It prints `PRODUCT.md` and `DESIGN.md`, which HushBox keeps in `docs/`. If it reports `NO_PRODUCT_MD`, follow `reference/init.md` then `reference/document.md` to write them into `docs/`, then continue. Skip the re-run if you have already seen its output this conversation.
2. **Read the register.** `reference/product.md` for app UI (chat, settings, account, billing, auth) or `reference/brand.md` for marketing, the public site, and `/welcome`. One per task, by the surface in focus.
3. **Read DESIGN.md and the token source** (`packages/config/tailwind/index.css`) plus one representative component. Reuse what is there; derive every color and type decision from them.
4. **Set the dials** from the table below, and declare the read in one line ("Reading this as: `<surface>` for `<audience>`, `<vibe>`").

<!-- @section: FD_DIRECTION -->

## Direction

HushBox is warm, quiet-but-expressive, editorial, privacy-first. The committed identity (palette, type, radius) is canonical in `DESIGN.md`; the strategy and design principles are in `PRODUCT.md`. Honor both.

- **Committed is not reflex.** A common-looking choice that is deliberate and recorded in `DESIGN.md` is not slop. Rarity is not the test, intent is. Never sand a committed choice toward something less common.
- **Expressive by default.** Set the dials per surface (below). Calm (reduced or no motion) is opt-in through the accessibility widget, never the silent default.
- **Type roles.** Reading surfaces use the editorial serif; product UI chrome uses the UI sans; code and data use mono. The families are in `DESIGN.md`.

### Dials (set per surface)

Three dials, each 1 to 10: `DESIGN_VARIANCE` (1 symmetric, 10 asymmetric), `MOTION_INTENSITY` (1 static, 10 cinematic), `VISUAL_DENSITY` (1 airy, 10 packed). The baseline is the expressive `8 / 6 / 4`; tune per surface:

| Surface                        | VARIANCE | MOTION | DENSITY |
| ------------------------------ | -------- | ------ | ------- |
| Marketing, /welcome, landing   | 8        | 6      | 3 to 4  |
| Chat thread                    | 5 to 6   | 4 to 5 | 3 to 4  |
| Settings, account, billing     | 3 to 4   | 3      | 5 to 6  |
| Auth, onboarding, empty states | 6        | 5      | 4       |

Above `VISUAL_DENSITY 7`, prefer line dividers over card containers.

<!-- @section: FD_CRAFT_FLOOR -->

## Always-on craft floor

Every surface honors these. For depth, load the matching guide (`reference/typeset.md`, `colorize.md`, `layout.md`, `animate.md`, `interaction-design.md`).

- **Color.** Body text at least 4.5:1 against its background; large text (18px or bold 14px) at least 3:1; placeholders the same 4.5:1. Gray on a colored background reads washed out; use a darker shade of that hue, or a transparency of the text color. Colors come from the tokens; no stray hex.
- **Typography.** Body line length 65 to 75ch; body at least 16px. Display ceiling about 6rem; display letter-spacing floor -0.04em. `text-wrap: balance` on headings, `pretty` on long prose.
- **Layout.** Vary spacing for rhythm. Cards only when truly the best affordance; never nested. Flexbox for 1D, Grid for 2D. A semantic z-index scale, never arbitrary 999 or 9999.
- **Motion.** Use Framer Motion for orchestration (cascades, layout and shared-element animation, AnimatePresence exits, springs) and CSS keyframes plus the View Transitions API for cheap and native motion (pulses, hovers, route and theme morphs), by role. Ease out with exponential curves; no bounce or elastic. Do not animate layout properties casually.
- **Interaction.** Dropdowns inside an `overflow: hidden` or `auto` container get clipped; use native `<dialog>` / popover, `position: fixed`, or a portal.

<!-- @section: FD_BANS -->

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

<!-- @section: FD_SLOP_TEST -->

## The AI slop test

If someone could look at this and say "AI made that" without doubt, it failed. Two altitudes: could someone guess the theme and palette from the category alone (first-order), or the aesthetic family from category-plus-anti-references (second-order)? Rework until neither is obvious. The one exception is HushBox's committed identity in `DESIGN.md`: it is deliberate and recorded, so it is not slop for being common. Committed is not reflex.

<!-- @section: FD_COPY -->

## Writing and UX copy

Words are design material. Write from the user's side of the screen; name things by what people control, not how the system is built. Active voice; an action keeps the same name through a flow. HushBox's register is direct, technical-but-human, transparent to a fault: confident without hype, never a dark pattern or fake urgency, privacy and cost claims precise. Errors explain what happened and how to fix it, never vague, never apologizing. Where copy is centralized (the shared error-message map keyed by code), change it there, not inline. For depth, load `reference/clarify.md`.

<!-- @section: FD_WIDGET -->

## Design that survives the accessibility widget

HushBox re-paints the whole UI at runtime: users can force contrast, desaturate or simulate color blindness, invert colors, scale type well past default, loosen spacing, swap a dyslexia-friendly face, and stop motion entirely. A design is not finished until it survives all of it. This is the quality floor; build to it without announcing it, and the review grades against it.

- Never encode meaning in color alone; the one accent must read when desaturated.
- Let content images invert and keep brand art from inverting by using the project's image and brand-mark wrappers, never a raw image element.
- Design fluid: layouts must not break at large type scales or loose spacing.
- **Gate every animation through the project's motion-aware helper so it degrades to a no-op under reduced or stopped motion.** This is what makes "expressive by default, calm on demand" true; never make meaning depend on motion.
- Prefer semantic HTML to ARIA roles, keep keyboard focus visible, tag structural chrome.

<!-- @section: FD_RESTRAINT -->

## Restraint and signature

Spend boldness in one place. Let one signature element be the memorable thing and keep everything around it disciplined; cut decoration that does not serve the brief. HushBox already concentrates its boldness well (the CipherWall encrypted-state moment, the circular theme-reveal). Before shipping, take one thing away.

<!-- @section: FD_SURFACES -->

## Surfaces

- **Product app** (chat, settings, account, billing): craft is clarity, calm spacing, precise interaction, instant feel. The content is the design; chrome recedes.
- **Marketing and `/welcome`** (Astro): the expressive register, hero-as-thesis, one orchestrated motion moment. Lean editorial-minimalist; reach for a higher-wow treatment only with a real reason.
- **In-conversation content** (Streamdown markdown, Shiki + mono code, KaTeX, React Virtuoso lists): readable measure, code-block craft, smooth virtualized scroll, not animation.

<!-- @section: FD_DETECTOR -->

## Detector

The deterministic scanner runs over files, never a URL:

```bash
pnpm exec node .claude/skills/frontend-design/scripts/detect.mjs --json <file-or-dir>
```

Findings go to stdout as JSON; exit `0` = none, `2` = findings, `1` = detector missing. Pass markup, style, and component files, or a directory. Its stderr is negative-only: it names what the detector could not read (so which verdicts come from part of a file) and counts generated files the walk skipped; a clean, fully read scan prints nothing there, and a directory of build output scans nothing and still exits `0` with `[]`. A zero is therefore evidence only once the scan has been shown to reach the target (`docs/AGENT-RULES.md` §Communication, the silent instrument): plant a control — a file carrying a known violation, such as a `borderLeft: '4px solid'` accent, under the same target, or under a copy of it outside the repository when you may not write into the tree — see it reported, remove it, and cite that run beside the zero. A pass is exit `0`, `[]`, empty stderr, and the control run.

<!-- @section: FD_COMMANDS -->

## Commands (load on demand)

Build: `craft` (shape then build), `shape` (plan first), `init` (write PRODUCT.md), `document` (write DESIGN.md), `extract`. Refine: `polish`, `bolder`, `quieter`, `distill`, `harden`, `onboard`. Enhance: `animate`, `colorize`, `typeset`, `layout`, `delight`, `overdrive`. Fix: `clarify`, `adapt`, `optimize`. Each is `reference/<command>.md`; load it when the request maps to it (exact word, or intent: "fix the spacing" loads `layout`, "rewrite this error" loads `clarify`). There is no evaluation command; evaluation is the review.

<!-- @section: DR_DIRECTION_RULE -->

## The one rule that makes you different: direction-aware, not generic

You grade against **HushBox's committed identity plus universal quality floors**, never against a generic aesthetic. Before anything else, read `DESIGN.md` and `PRODUCT.md` (HushBox keeps them in `docs/`) and the token source `packages/config/tailwind/index.css`. Those define what HushBox deliberately is.

- **Do not flag committed identity as a problem.** Treat everything declared in `DESIGN.md` as a deliberate, recorded choice: its tokens, type roles, radius, and the expressive-by-default direction. A generic SaaS rubric would call some of these out (the warm paper as "cream slop," a serif as "an AI tell"); here they are correct. Committed is not reflex. Judge against the brief and `DESIGN.md`, not against "what most apps do." On an `apps/admin` surface, the deltas `DESIGN.md` §Admin app records are committed identity too.
- **Universal floors always apply,** whatever the aesthetic: accessibility (WCAG AA+), color contrast (4.5:1 body, 3:1 large), keyboard operability and visible focus, responsiveness with no overflow, all interaction states present, no console errors, and reasonable performance. These are never waived by direction.
- If you are unsure whether something is a committed choice or a real defect, say so in the finding and let your caller adjudicate. Flag it as "possible false positive (may be committed identity)."

<!-- @section: DR_METHOD -->

## Methodology: live environment first

Assess the running experience before reasoning about code. Use Playwright MCP for navigation, interaction, screenshots, and viewport testing, and Chrome DevTools MCP for performance traces, Lighthouse, network, and console. Open a fresh tab; do not reuse one. If you are given a target file rather than a URL, find the route that renders it and the dev server URL (ask in your report if the URL is genuinely unknowable).

Save every screenshot under `.playwright-mcp/` (gitignored) by passing an explicit `filePath` like `.playwright-mcp/<name>.png` — never a bare filename. The Playwright MCP already defaults there via `--output-dir`, but the Chrome DevTools MCP has no output-dir option and writes bare filenames into the repo root.

### Phase 0: Preparation

Read the change description and the additional-instructions hint if provided. Read DESIGN.md and PRODUCT.md. Set the initial viewport to 1440x900.

### Phase 1: Interaction and flow

Walk the primary user flow. Test every interactive state: default, hover, focus-visible, active, disabled, loading, error, success. Verify destructive actions confirm or offer undo. Assess perceived performance.

### Phase 2: Responsiveness

Test 1440px (desktop), 768px (tablet), 375px (mobile). Capture a screenshot at each. Verify no horizontal scroll and no element overlap. Read a screenshot you captured back into your context; a screenshot you did not look at does not count.

### Phase 3: Visual craft (against DESIGN.md)

Alignment and spacing consistency, typographic hierarchy and measure, color use against the token system, visual hierarchy, optical alignment. Check that the surface reads as HushBox, not as a reskin of the model it fronts. Confirm no long dashes in any visible copy, per DESIGN.md's copy rule.

### Phase 4: Accessibility (WCAG 2.1 AA+), including the HushBox widget

Keyboard navigation and tab order, visible focus on every interactive element, semantic HTML over ARIA, form labels and associations, image alt text, contrast 4.5:1. **HushBox-specific:** the UI is re-painted at runtime by the accessibility widget. Check the design survives: meaning never encoded in color alone (the one red must read desaturated), content images invert while brand art does not, layouts hold at large type scale and loose spacing, and all motion no-ops under stopped motion. If you can toggle these in the running app, do; otherwise inspect for the patterns that would break them.

### Phase 5: Robustness

Form validation with invalid input, content-overflow stress, loading and empty and error states, long and short text, first-run.

### Phase 6: Performance and theming (the technical audit, folded in)

Use Chrome DevTools MCP: run a performance trace and Lighthouse on the surface; check LCP under 2.5s, INP under 200ms, CLS under 0.1; look for layout thrash, casual layout-property animation, and unbounded expensive effects. Theming: colors come from tokens (no stray hex), dark mode holds contrast and hierarchy, the design survives both themes.

### Phase 7: Content and console

Grammar and clarity of all copy (HushBox voice: direct, transparent, no hype, no dark patterns; no long dashes in visible copy per DESIGN.md). Check the browser console via both MCPs for errors and warnings.

### Phase 8: Teardown (always, even if the review fails)

Before you return, close every browser tab/page you opened so the MCP-driven Chromium does not linger and leak memory across sessions: call `mcp__playwright__browser_close` to close the Playwright browser, and `mcp__chrome-devtools__close_page` for any page you opened via the Chrome DevTools MCP. Do this last, after all screenshots are captured and read back; a long review can leave a multi-GB Chromium renderer behind if the browser is never closed.

<!-- @section: DR_LENSES -->

## Evaluation lenses

Score the surface against Nielsen's 10 heuristics (0 to 4 each; be honest, most real interfaces land 20 to 32 of 40) and note cognitive-load failures (any decision point with more than 4 visible options, any step that forces the user to remember earlier-screen state). Walk the surface as 2 or 3 relevant personas (impatient power user, confused first-timer, accessibility-dependent user, deliberate stress-tester, distracted mobile user) and report what specifically broke for each. These lenses generate findings; they are not the deliverable on their own.

<!-- @section: DR_SEVERITY -->

## Severity (Triage Matrix)

Tag every finding:

- **[Blocker]** critical failure, must fix immediately (broken flow, WCAG A failure, console error that breaks the page).
- **[High]** significant issue, fix before this is done (contrast failure, missing focus, broken responsive layout, missing critical state).
- **[Medium]** improvement, real but not blocking.
- **[Nit]** minor aesthetic detail.

<!-- @section: DR_COMMUNICATION -->

## Communication

Describe problems and their impact, not prescriptions. Not "change margin to 16px" but "the spacing between the header and the list is inconsistent with the rest of the page, which makes the grouping read as accidental." Lead with what works. Provide screenshots for visual findings.
