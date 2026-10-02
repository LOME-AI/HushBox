---
name: HushBox
description: Warm, quiet-but-expressive, editorial, privacy-first.
colors:
  brand-red: '#ec4755'
  brand-red-hover: '#d93d4a'
  white: '#ffffff'
  background: '#faf9f6'
  background-paper: '#faf5ed'
  background-subtle: '#eae8e3'
  foreground: '#1a1a1a'
  foreground-muted: '#4d4a45'
  border: '#b5b1a8'
  border-strong: '#8f8b81'
  secondary: '#e5e2db'
  error: '#c2201f'
  warning: '#975304'
  info: '#2563eb'
  success: '#0f7334'
  violet: '#8b5cf6'
  sidebar: '#f5f4f0'
  sidebar-border: '#d1cfc9'
  message-user: '#d4cdc4'
  prediction: '#24496b'
  background-dark: '#1a1816'
  background-paper-dark: '#252320'
  background-subtle-dark: '#2d2b28'
  foreground-dark: '#f2f1ef'
  foreground-muted-dark: '#bcb9b3'
  border-dark: '#3d3a36'
  border-strong-dark: '#4a4743'
  accent-dark: '#2d2b28'
  error-dark: '#f76e6e'
  warning-dark: '#f59e0b'
  info-dark: '#3b82f6'
  success-dark: '#22c55e'
  sidebar-dark: '#141311'
  message-user-dark: '#2a2725'
  prediction-dark: '#99bddd'
  red-light: '#f87171'
  blue-light: '#60a5fa'
  green-light: '#4ade80'
  amber-light: '#fbbf24'
  violet-light: '#a78bfa'
typography:
  display:
    fontFamily: 'Merriweather, Georgia, serif'
    fontSize: 'clamp(1.75rem, 4vw, 3rem)'
    fontWeight: 700
    lineHeight: 1.15
  body:
    fontFamily: 'Merriweather, Georgia, serif'
    fontSize: '1.0625rem'
    fontWeight: 400
    lineHeight: 1.6
  ui:
    fontFamily: 'Hanken Grotesk, system-ui, sans-serif'
    fontSize: '0.9375rem'
    fontWeight: 500
    lineHeight: 1.4
  mono:
    fontFamily: 'JetBrains Mono, monospace'
    fontSize: '0.875rem'
    fontWeight: 400
    lineHeight: 1.5
rounded:
  sm: '4px'
  md: '6px'
  lg: '8px'
  xl: '12px'
  full: '9999px'
spacing:
  xs: '4px'
  sm: '8px'
  md: '16px'
  lg: '24px'
  xl: '32px'
components:
  button-primary:
    backgroundColor: '{colors.brand-red}'
    textColor: '{colors.white}'
    rounded: '{rounded.md}'
    padding: '0.5rem 1rem'
  button-secondary:
    backgroundColor: '{colors.secondary}'
    textColor: '{colors.foreground}'
    rounded: '{rounded.md}'
    padding: '0.5rem 1rem'
  card:
    backgroundColor: '{colors.background-paper}'
    textColor: '{colors.foreground}'
    rounded: '{rounded.lg}'
    padding: '1rem'
  input:
    backgroundColor: '{colors.background}'
    textColor: '{colors.foreground}'
    rounded: '{rounded.md}'
    padding: '0.5rem 0.75rem'
---

# Design System: HushBox

## 1. Overview

**Creative North Star: "The Private Study"**

A quiet, warm room for thinking in private: paper-and-ink calm, an editorial voice, one decisive mark of color, and nothing that announces itself. HushBox fronts a hundred AI models but reads like none of them. The surface is warm rather than clinical, the type is set like a publication rather than a dashboard, and motion is present but unhurried. It is expressive by default and trustworthy by construction: every choice is deliberate and recorded, so the familiar warmth of paper and serif is a committed identity, not a reflex.

What this system rejects: the generic AI-chat look (gray bubbles, sparkle empty states, purple gradients), surveillance-SaaS coldness, hype-y neon marketing, and any dark pattern. Common is not the enemy; reflex is.

**Key Characteristics:**

- Warm paper surfaces, never pure white; warm charcoal in dark, never pure black.
- One saturated brand red, used as a signal, never as decoration.
- An editorial serif for reading, a humanist sans for chrome, mono for code.
- Expressive by default; calm is one accessibility toggle away.

## 2. Colors

A warm-neutral system carrying a single decisive accent. Every color comes from a token; literal hex in product code is drift.

### Primary

- **Signal Red** (#ec4755): the one brand accent. Primary actions, current selection, focus rings, headings, links. Hover deepens to **Signal Red Deep** (#d93d4a). Used sparingly; its rarity is the point.

### Neutral (warm paper to ink)

- **Warm Paper** (#faf9f6): the body background. Lower-glare than white, calm to read against for hours.
- **Paper Cream** (#faf5ed): raised surfaces, cards, popovers.
- **Paper Subtle** (#eae8e3): muted panels and wells.
- **Ink** (#1a1a1a) and **Muted Ink** (#4d4a45): primary and secondary text. Muted Ink is warm rather than neutral grey, and dark enough to clear 7:1 on every surface it lands on, Paper Subtle included.
- **Warm Border** (#b5b1a8) and **Strong Border** (#8f8b81): hairlines and dividers.
- Dark mode is a warm charcoal scale (background #1a1816, paper #252320), not inverted light, with depth from surface lightness rather than shadow.

### Semantic

- **Error** (#c2201f), **Warning** (#975304), **Info** (#2563eb), **Success** (#0f7334). The error red is deliberately distinct from the brand red so danger never reads as branding. Error, Warning and Success each clear 4.5:1 for small text on every paper surface. (Dark-mode variants: #f76e6e / #f59e0b / #3b82f6 / #22c55e.)
- **Prediction** (#24496b): words the on-device completion model offers that the user has not typed, drawn over the composer field. Muted Ink cannot carry that meaning - the accessibility contrast tiers pull it toward Ink, so a prediction drawn as muted text collapses into typed text at exactly the setting a low-vision reader picks. Prediction carries its own value in every tier instead, clearing 7:1 on every surface untiered and the 4.5:1 floor on the composer field in each tier. A dotted underline marks the same words, so predicted text never rests on colour alone. (Dark-mode variant: #99bddd.)

### Named Rules

**The One Red Rule.** The brand red appears on a small fraction of any screen and only as a signal (action, selection, focus, heading). It is never a background wash or decoration. The error red is reserved for danger and is never used for emphasis.

**The Literal-Class Rule.** A `packages/ui` module holding Tailwind class literals is a `.tsx` file, and each class is written whole. An app stylesheet reaches that package only through `@source` globs that match `.tsx` (`packages/config/tailwind/index.css`, `apps/marketing/src/styles/global.css`), and the scanner emits only the class tokens it finds written out, so a class in a `.ts` module or one assembled from fragments is absent from the built stylesheet with nothing reporting it.

**The Warm-Surface Rule.** No pure-white (#ffffff) or pure-black (#000000) canvas. Surfaces are warm paper in light and warm charcoal in dark. This is committed identity, not a default to flee from. The accessibility widget's high contrast tier is the one exception: its canvas is pure white in light and pure black in dark, because maximum contrast is what that tier is for, and its cards, wells and fills follow the canvas to neutral grey rather than staying warm.

**The Derived-Surface Rule.** Under a contrast tier, no surface is authored per tier: each is a fixed step of the tier's own ink mixed into the tier's own canvas, so a tier that moves either anchor moves its cards, wells, fills and sidebar rail with it, and a tier added later gets its surfaces without declaring any. A new colour token is therefore a decision, never a default: it joins the derivation, or it is listed as tier-invariant with the reason, in the test that pins this rule (`packages/ui/src/components/accessibility/styles/contrast-surfaces.test.ts`), which refuses a theme colour that is neither. The low contrast tier is the ruled exception on one surface: the fill behind a hovered or active sidebar item must keep muted text legible, and no step does that while also standing visibly off the rail, so legibility wins and that tier's sidebar hover and active wash is fainter than any other tier's — in the light half, all but indistinguishable from the rail. That is the recorded cost of the ruling (2026-09-14), not a defect to tune away; it is why §5 Navigation's rule — active state marked with Signal Red, not position alone — carries the weight there.

## 3. Typography

**Reading Font:** Merriweather (with Georgia, serif fallback)
**UI Font:** Hanken Grotesk (with system-ui, sans-serif fallback)
**Code Font:** JetBrains Mono (with monospace fallback)

**Character:** An editorial serif gives reading surfaces a considered, trustworthy, publication-like voice; a warm humanist sans keeps dense product chrome crisp at small sizes; mono carries code and data. Personality comes from scale, weight, and rhythm, not from reaching for a trendy face.

### Hierarchy

- **Display** (Merriweather, 700, clamp to ~3rem, line-height 1.15): hero and section headlines.
- **Body** (Merriweather, 400, ~1.0625rem, line-height 1.6): reading content, chat messages, long-form prose. Measure 65 to 75ch.
- **Subordinate reading** (Merriweather, 400, ~0.9375rem, Muted Ink): model-authored prose that is secondary to the answer, such as a reasoning trace. One size step below Body plus the muted ink step is what marks it subordinate; it takes no box, no rule, and no change of face, because the accessibility widget's font override collapses every face to one, and a face-only distinction would vanish at exactly the setting that needs it.
- **UI** (Hanken Grotesk, 500, ~0.9375rem, line-height 1.4): buttons, labels, form fields, settings rows, navigation, data.
- **Code** (JetBrains Mono, 400, ~0.875rem): code blocks, keystrokes, metadata, tabular numbers.

### Named Rules

**The Reading-versus-Chrome Rule.** Reading surfaces use the serif; product UI chrome uses the sans; code uses mono. Do not set dense UI chrome in the serif, and do not set reading prose in the sans.

## 4. Elevation

Flat by default. Depth comes from warm surface layering (paper over background over subtle) and hairline borders, not from heavy shadow. Where a shadow is used, it is low and warm-tinted, never a hard black drop. In dark mode, elevation is conveyed by lighter warm-charcoal surfaces rather than shadow.

### Named Rules

**The Flat-by-Default Rule.** Surfaces are flat at rest. A shadow appears only as a response to state (hover, active elevation, focus), and it is soft and warm, never decorative.

## 5. Components

### Buttons

- **Shape:** medium radius (6px). Pills (9999px) only for tags and small chips.
- **Primary:** Signal Red fill, white text; hover deepens to Signal Red Deep; tactile press (slight translate or scale-down on active).
- **Secondary / ghost:** warm neutral surface or transparent with a hairline; never a second saturated color.
- Every interactive element ships default, hover, focus-visible, active, disabled, loading states.

### Inputs / Fields

- Warm paper background, hairline border, medium radius. Label above the field, error below. Focus ring in Signal Red. Placeholders carry Muted Ink, so they clear 7:1 rather than the 4.5:1 floor.

### Cards / Containers

- Paper-cream background, large radius (8px), hairline border, generous internal padding. Flat at rest. Never nested.

### Navigation

- Calm, consistent. Sidebar and top chrome use the UI sans, tagged as structural chrome. Active state marked with Signal Red, not just position.

### Message surfaces

- The user message carries a subtle warm fill; the assistant message is transparent so the content carries itself. The words are the design.

### Signature

- The CipherWall encrypted-state indicator and the circular theme-reveal wipe are HushBox's concentrated boldness. One memorable animated moment; everything around it stays quiet.

## 6. Do's and Don'ts

### Do

- **Do** derive every color and type decision from these tokens; use `var(--token)`, never a literal hex in product code.
- **Do** keep the brand red to a small fraction of any screen, as a signal only.
- **Do** set reading surfaces in the serif and product chrome in the sans.
- **Do** make every surface survive the accessibility widget: contrast, inversion, scaling, loosened spacing, and stopped motion.
- **Do** gate every animation through the motion-aware helper so it degrades to a no-op.

### Don't

- **Don't** use a pure-white or pure-black canvas; the warm paper and warm charcoal are committed.
- **Don't** use the error red for emphasis, or any second saturated accent.
- **Don't** ship the generic AI-chat look: gray symmetrical bubbles, a sparkle empty state with "How can I help you today?", a purple-blue gradient, an assistant-avatar blob.
- **Don't** use surveillance-SaaS coldness, hype-y neon marketing, fake urgency, or any dark pattern.
- **Don't** use long dashes (the em-dash, or the en-dash used as a separator) in user-facing copy: anything users read in the product or marketing (UI labels, buttons, error messages, prose). Use a hyphen, comma, colon, period, or parentheses. This does not govern internal text (code comments, these docs, commit messages) or a user's own chat content. This is the one canonical statement of the rule.
- **Don't** nest cards, use side-stripe borders, gradient text, the hero-metric template, identical card grids, or a tracked eyebrow above every section.

## 7. Admin app

The admin SPA (`apps/admin`) inherits this identity — tokens, dark mode, `@hushbox/ui` primitives, the accessibility conventions — with these deltas. It is an ops tool for 1–3 operators, not a product surface:

- **Density over whitespace:** tables over cards, monospace ids with copy buttons, counts over charts. Compact spacing is correct here, not a violation.
- **Function over expression:** no signature moments, no marketing polish, no empty-state illustration. The CipherWall and theme-reveal wipe do not appear.
- **The OpModal is the only mutation surface** — its form → preview-diff → execute/undo grammar is the app's one interaction signature; no bespoke confirm dialogs.
- **Keyboard-first:** the command palette is the primary navigation; every screen reachable without a pointer.

A future design pass must not "improve" the admin app toward the product's warmth; its craft bar is legibility and speed.

## 8. Accessibility conventions

These conventions keep the accessibility widget's CSS overrides and the semantic theming effective as the codebase grows. Each names the gate that holds it; the gate catches the direct written form, and the convention binds where the gate cannot see: a hoisted style object passed as `style={s}`, a spread into `style`, a `React.createElement('img', …)` call, or a Tailwind arbitrary value such as `text-[#ff0000]`.

- **Color and font come from Tailwind classes or CSS variables.** `<div className="text-destructive text-sm" />` carries values the widget's contrast and font-scaling toggles can override; an inline `style` for `color`, `backgroundColor`, `borderColor`, `fontFamily`, `fontSize`, `fill` or `stroke` does not. Native-asset generators that render to PNG (splash screen, app icon) are the exemption, each carrying `eslint-disable-next-line no-restricted-syntax -- <reason>`. Enforcement: `lint:no-restricted-syntax(inline style color/font)` over every `.tsx` and `.astro` file.
- **Color classes are semantic tokens.** `text-destructive` resolves per theme at a value the design system adjusted for contrast; `text-red-500` names a color, not a meaning, and resolves the same in both themes. Development-only surfaces, listed by exact path in the guard's exemption set, mark scaffolding that ships in no production build. Enforcement: `ci:verify:design-tokens` over the web, admin, ui and marketing trees.
- **Content images render through `<Img>`, the brand mark through `<Logo>`**, both from `@hushbox/ui`: `Img` requires `alt` and defaults to `loading="lazy"`; `Logo` keeps the brand mark one component. Enforcement: `lint:no-restricted-syntax(raw img)` over every `.tsx` and `.astro` file.
- **Animation frames come from `useAnimationFrame`** in `@hushbox/ui`, which respects `prefers-reduced-motion` and the user's "stop animations" toggle; motion beyond it is Framer Motion or CSS. Enforcement: `lint:no-restricted-globals(requestAnimationFrame)` · `lint:no-restricted-syntax(requestAnimationFrame)` · `lint:no-restricted-imports(animation libraries)`.
- **Structure is semantic HTML**: `<main>`, `<nav>`, `<button onClick={…}>` imply their roles, support keyboard interaction natively, and reach the landmarks navigator without configuration. Chrome wrappers (sidebar, header, footer, panels around main content) carry `data-chrome=""` for opt-out behaviours such as a focus-mode toggle. Enforcement: `doc`.
