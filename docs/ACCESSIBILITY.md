# Accessibility

This document covers the design rationale for HushBox's accessibility approach, our WCAG 2.2 AA compliance status, and the manual screen-reader test procedure.

## Design rationale

HushBox ships an accessibility settings widget — a panel of toggles for contrast, color-blindness filters, font scaling, alternative fonts, motion control, text-to-speech, and reading aids. The widget is **personalization**, not WCAG remediation.

We deliberately differ from the AccessiBe / UserWay / EqualWeb category of "accessibility overlays." The disability community has near-universally rejected those products. The Overlay Fact Sheet (https://overlayfactsheet.com), signed by hundreds of accessibility professionals including disabled users, states: "We will never recommend the use of accessibility overlays" and documents that overlays often *interfere* with assistive technology. WebAIM's analysis (https://webaim.org/blog/accessibility-overlays/) is unambiguous on the same point.

Our widget complies with the published critique:

- **No DOM modification.** The widget never injects ARIA, alt text, or headings via heuristics or AI. Wrong labels are worse than missing ones.
- **No screen-reader interference.** No "screen-reader mode" announcements, no focus hijacking, no bot-detection.
- **No compliance claims.** The widget is personalization. WCAG compliance comes from the underlying site's design and code, not from the widget.
- **OS preferences as defaults.** `prefers-reduced-motion`, `prefers-color-scheme`, and `prefers-contrast` are honored from page load via an inline init script that runs synchronously in `<head>` before first paint.
- **Self-imposed guardrails.** Lint rules block patterns that would silently break the widget's effectiveness (inline color styles, raw `<img>`, raw `requestAnimationFrame`, JS animation libraries that bypass `MotionConfig`).

The widget exists because *some* users genuinely benefit from in-product personalization on top of an accessible site (font scaling, dyslexia-friendly fonts, color-blindness filters, on-device TTS for long-form reading). The widget never claims to substitute for an accessible site — and our site is built to WCAG 2.2 AA without it.

## WCAG 2.2 AA compliance checklist

Status as of 2026-05-09.

### 1. Perceivable

- [ ] 1.1.1 Non-text content (alt text) — `<Img>`/`<Logo>` wrappers enforce alt; lint blocks raw `<img>`. **Status: enforced**
- [ ] 1.3.1 Info and relationships (semantic markup) — semantic landmarks in shell; lint encourages them. **Status: enforced**
- [ ] 1.3.4 Orientation — no orientation lock. **Status: enforced**
- [ ] 1.4.3 Contrast (minimum) — design tokens meet 4.5:1 by default; widget offers stronger contrast presets. **Status: needs audit**
- [ ] 1.4.10 Reflow — Tailwind's responsive design + `useIsMobile` ensures content reflows. **Status: needs audit at 320 CSS px**
- [ ] 1.4.11 Non-text contrast — needs audit
- [ ] 1.4.12 Text spacing — widget offers letter/line/paragraph spacing controls; default rendering passes. **Status: enforced via widget**
- [ ] 1.4.13 Content on hover/focus — needs audit (tooltips, popovers)

### 2. Operable

- [ ] 2.1.1 Keyboard — every interactive element tested for keyboard nav. **Status: needs full audit**
- [ ] 2.1.4 Character key shortcuts — none used (no widget shortcut per design). **Status: pass**
- [ ] 2.3.1 Three flashes — no flashing content. **Status: pass**
- [ ] 2.4.3 Focus order — logical, follows DOM order. **Status: needs audit**
- [ ] 2.4.4 Link purpose (in context) — needs audit
- [ ] 2.4.6 Headings and labels — semantic headings throughout. **Status: enforced**
- [ ] 2.4.7 Focus visible — Tailwind/shadcn focus rings; widget offers stronger options. **Status: enforced**
- [ ] 2.5.5 Target size — needs audit (mobile especially)
- [ ] 2.5.7 Dragging movements — no drag-only interactions. **Status: pass**
- [ ] 2.5.8 Target size (minimum) — Tailwind sizing satisfies; needs audit at small breakpoints

### 3. Understandable

- [ ] 3.1.1 Language of page — `<html lang="en">` set in Layout.astro and apps/web. **Status: pass**
- [ ] 3.2.1 On focus — no surprising context changes. **Status: pass**
- [ ] 3.2.2 On input — no surprising context changes. **Status: pass**
- [ ] 3.3.1 Error identification — form error states implemented. **Status: needs audit**
- [ ] 3.3.2 Labels or instructions — form labels via shadcn `Label`. **Status: enforced**
- [ ] 3.3.3 Error suggestion — needs audit
- [ ] 3.3.4 Error prevention (legal/financial) — billing flows have confirm dialogs. **Status: needs audit**
- [ ] 3.3.7 Redundant entry — needs audit
- [ ] 3.3.8 Accessible authentication — auth uses standard form patterns; OPAQUE doesn't introduce barriers. **Status: needs audit**

### 4. Robust

- [ ] 4.1.1 Parsing — typecheck enforces valid JSX. **Status: pass**
- [ ] 4.1.2 Name, role, value — Radix/shadcn primitives provide. **Status: pass**
- [ ] 4.1.3 Status messages — toasts use `aria-live`. **Status: needs verification**

CI runs `@axe-core/playwright` against marketing and authenticated app pages. Run `pnpm e2e` (or whatever the project uses) to execute.

## Manual screen-reader smoke test

Before each major release, verify the widget and core flows work with at least one screen reader on each platform. Documented procedures:

### NVDA (Windows)

1. Install NVDA from https://www.nvaccess.org
2. Start NVDA, open the marketing landing page
3. Tab through the page — verify focus order is logical, labels are announced
4. Tab to the floating accessibility button — verify it announces "Accessibility settings, button"
5. Press Enter — verify the panel opens and focus moves into it
6. Tab through panel controls — verify each control announces its label and current value
7. Toggle a setting — verify NVDA announces the change
8. Press Esc — verify the panel closes and focus returns to the trigger
9. Repeat for the authenticated `/accessibility` route

### VoiceOver (macOS / iOS)

macOS: System Settings > Accessibility > VoiceOver > enable. Toggle with Cmd+F5.
iOS: Settings > Accessibility > VoiceOver > enable. Triple-click side button to toggle.

Steps mirror the NVDA flow above. Pay attention to:
- Rotor navigation (VO+U on macOS) — verify landmarks list shows main, navigation, etc.
- Touch gestures on iOS — single-tap to focus, double-tap to activate

### TalkBack (Android Capacitor app)

Settings > Accessibility > TalkBack > enable.
Verify the same flows work in the wrapped Android app. Pay attention to gesture differences and any iOS-specific behaviors that don't translate.

### Result reporting

After each smoke test, file a checkbox list as a GitHub issue with the test date, NVDA/VoiceOver/TalkBack version, and any issues encountered. Resolve P1 issues before the release; P2/P3 can be tracked.
