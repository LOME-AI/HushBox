/**
 * Every design token the product draws with, as data. `pnpm generate:design-tokens`
 * renders this module into the marked block of `packages/config/tailwind/index.css`,
 * which every frontend imports, and the generator's own test refuses a committed block
 * that differs from the render. Code that needs a value outside CSS (a
 * motion duration, the email palette) reads it here, through this subpath only: it is
 * never re-exported from the package root, so a light bundle takes this file alone.
 *
 * The values stay readable in the stylesheet on purpose. Tests and scripts across the
 * repository parse `index.css` text for them, and a rendering tool reads its `.dark`
 * custom properties at render time.
 */

import { MOBILE_BREAKPOINT } from '../platform/mobile.ts';

export type ThemeName = 'light' | 'dark';

export type ColourToken = `--${string}`;

/** White text on Signal Red, the one pairing both themes share. */
const ON_ACCENT = '#ffffff';

/**
 * The email-only canvas behind the dark card, darker than any theme surface so the card
 * reads as a card in a mail client's own dark frame. It is also the well code is set in.
 */
const EMAIL_DARK_CANVAS = '#0c0b0a';

const LIGHT = {
  '--brand-red': '#ec4755',
  '--brand-red-hover': '#d93d4a',
  '--brand-red-subtle': '#ec475515',

  '--background': '#faf9f6',
  '--background-paper': '#faf5ed',
  '--background-subtle': '#eae8e3',

  '--foreground': '#1a1a1a',
  // Warm rather than the neutral grey it replaces, and dark enough that muted text
  // clears 7:1 on every surface it lands on, --background-subtle included (chips,
  // wells, hover fills and the docket console's selected row). Pinned by
  // apps/admin/src/lib/theme-contrast.test.ts.
  '--foreground-muted': '#4d4a45',

  '--border': '#b5b1a8',
  '--border-strong': '#8f8b81',
  // Every control's boundary: inputs, the composer, outline buttons, chips. Held to the
  // 3:1 non-text floor on every surface a control sits on, which --border is not; each
  // contrast tier restates it for the same reason. Pinned by
  // apps/admin/src/lib/theme-contrast.test.ts.
  '--border-control': '#86827a',

  '--secondary': '#e5e2db',
  '--secondary-foreground': '#1a1a1a',
  '--accent': '#e5e2db',
  '--accent-foreground': '#1a1a1a',

  // Error red is darkened from #dc2626, warning amber from #d97706 and success green
  // from #16a34a so small status text meets WCAG AA (>= 4.5:1) on --background,
  // --background-paper and the --background-subtle fill. The contrast tiers never
  // redefine these, so no accessibility setting can rescue a lighter value; asserted by
  // apps/admin/src/lib/theme-contrast.test.ts.
  '--error': '#c2201f',
  '--warning': '#975304',
  '--info': '#2563eb',
  '--success': '#0f7334',

  // Status words set on a 12% tint of their own tone (badges, status lines), each held
  // to 4.5:1 on that tint over every surface in
  // apps/admin/src/lib/theme-contrast.test.ts.
  '--success-text': '#0b5e2a',
  '--warning-text': '#7a4303',
  '--error-text': '#a31b1a',
  '--info-text': '#1e4fa8',

  '--sidebar': '#f5f4f0',
  '--sidebar-foreground': '#1a1a1a',
  '--sidebar-border': '#d1cfc9',

  '--message-user': '#d4cdc4',
  '--message-assistant': 'transparent',

  // Predicted text: words the local completion model offers that the user has not typed.
  // Muted text cannot carry this meaning, because the accessibility contrast tiers pull
  // --foreground-muted toward --foreground; the token is therefore re-declared in every
  // tier (packages/ui/src/components/accessibility/styles/contrast.css) so no setting can
  // collapse a prediction into typed text. The dotted underline drawn at the call site
  // (apps/web/src/components/chat/input/prediction-overlay.tsx) is the cue that survives
  // with no colour vision, which is what keeps the mark off colour alone (WCAG 1.4.1).
  // Pinned by packages/ui/src/components/accessibility/styles/prediction-token.test.ts.
  '--prediction': '#24496b',

  // The track a gauge or usage bar fills along.
  '--meter-track': '#dcd8cf',
  // Text on a disabled control, which keeps full opacity rather than fading.
  '--disabled-ink': '#7d7973',

  // The one categorical palette for models: an 8px swatch beside a name that is always
  // printed, so the colour never carries the identity alone.
  '--model-1': '#0e6e66',
  '--model-2': '#2563eb',
  '--model-3': '#15803d',
  '--model-4': '#7c3aed',
  '--model-5': '#a16207',
  '--model-6': '#475569',
  '--model-7': '#a21caf',
  '--model-8': '#4d7c0f',

  '--chart-1': '#ec4755',
  '--chart-2': '#2563eb',
  '--chart-3': '#16a34a',
  '--chart-4': '#d97706',
  '--chart-5': '#8b5cf6',

  // Sequential ramp: the one continuous scale for magnitude, where the chart tokens above
  // are hues told apart rather than ranked. Five steps running away from the card, each
  // dark enough that --foreground on it clears 4.5:1 in the two untiered themes, because a
  // shaded cell prints its own figure; that floor is what stops the scale reaching full
  // strength, and opacity on the cell is what it replaces — that fades the figure along
  // with its fill. The a11y-contrast-low tier softens that ink and no tier derives the
  // ramp, so the deep steps do not clear the floor against it; why the scale is held
  // tier-invariant rather than derived is the reason on its TIER_INVARIANT entry in
  // packages/ui/src/components/accessibility/styles/contrast-surfaces.test.ts. One
  // consequence is load-bearing for every surface that shades by magnitude: the palest
  // step stands 1.07:1 off the card, so absence of data cannot be encoded as a shade at
  // all and is carried by a hatch or a dash instead. Pinned by
  // packages/ui/src/components/accessibility/styles/sequential-ramp.test.ts.
  '--seq-1': '#e8eef8',
  '--seq-2': '#cddbf1',
  '--seq-3': '#a9c2e7',
  '--seq-4': '#82a8db',
  '--seq-5': '#5b8ccb',
  // The ramp's own text partner: the ink a figure printed inside a shaded cell is set in.
  // It is not --foreground because a contrast tier restates that ink while no tier
  // derives the ramp, so under the softened tier the two close on each other at the deep
  // steps; a fill's text partner follows its fill, which is how --secondary-foreground and
  // its siblings are already treated. Held to 4.5:1 on every step of the ramp, per theme,
  // in packages/ui/src/components/accessibility/styles/sequential-ramp.test.ts.
  '--seq-foreground': '#1a1a1a',

  // Syntax highlighting. One color per token kind a highlighter can name; every value
  // clears 4.5:1 on all three surfaces, --background-subtle included, because highlighted
  // code is small text on a filled well.
  '--code-changed': '#9a4a12',
  '--code-comment': '#6a655c',
  '--code-constant': '#9a4a12',
  '--code-deleted': '#b3261e',
  '--code-function': '#1e4fa8',
  '--code-inserted': '#1a6b45',
  '--code-keyword': '#a3246d',
  '--code-link': '#1e4fa8',
  '--code-parameter': '#7a4a00',
  '--code-punctuation': '#5d5850',
  '--code-string': '#1a6b45',
  '--code-string-expression': '#1a6b45',
} as const satisfies Readonly<Record<ColourToken, string>>;

const DARK = {
  '--brand-red': '#ec4755',
  '--brand-red-hover': '#d93d4a',
  '--brand-red-subtle': '#ec475520',

  '--background': '#1a1816',
  '--background-paper': '#252320',
  '--background-subtle': '#2d2b28',

  '--foreground': '#f2f1ef',
  // Lightened for the same 7:1 floor as the light theme; the three dark surfaces sit
  // close together, so muted text on the lightest of them (--background-subtle) is what
  // sets this value.
  '--foreground-muted': '#bcb9b3',

  '--border': '#3d3a36',
  '--border-strong': '#4a4743',
  '--border-control': '#7a756d',

  '--secondary': '#3d3a36',
  '--secondary-foreground': '#f2f1ef',
  '--accent': '#2d2b28',
  '--accent-foreground': '#f2f1ef',

  // Error red is lightened from #ef4444 so small error text meets WCAG AA (>= 4.5:1) on
  // dark --background, --background-paper and the --background-subtle fill; asserted by
  // apps/admin/src/lib/theme-contrast.test.ts. Every shipped destructive fill overrides
  // to `dark:bg-destructive/60`, so this token is a text colour in dark mode, never a
  // solid fill behind white.
  '--error': '#f76e6e',
  '--warning': '#f59e0b',
  '--info': '#3b82f6',
  '--success': '#22c55e',

  '--success-text': '#4ade80',
  '--warning-text': '#fbbf24',
  '--error-text': '#ff9090',
  '--info-text': '#8fb8ff',

  '--sidebar': '#141311',
  '--sidebar-foreground': '#f2f1ef',
  '--sidebar-border': '#3d3a36',

  '--message-user': '#2a2725',
  '--message-assistant': 'transparent',

  // Predicted text, lightened for the dark surfaces against the same floors the light
  // theme is held to. The backdrop those floors are measured against is the composer
  // field rather than this background: primitives/textarea.tsx washes the field with a
  // fraction of --input in dark mode, which lightens what the words sit on.
  '--prediction': '#99bddd',

  '--meter-track': '#3a3632',
  '--disabled-ink': '#8f8b84',

  '--model-1': '#2dd4bf',
  '--model-2': '#60a5fa',
  '--model-3': '#4ade80',
  '--model-4': '#a78bfa',
  '--model-5': '#facc15',
  '--model-6': '#94a3b8',
  '--model-7': '#e879f9',
  '--model-8': '#a3e635',

  '--chart-1': '#f87171',
  '--chart-2': '#60a5fa',
  '--chart-3': '#4ade80',
  '--chart-4': '#fbbf24',
  '--chart-5': '#a78bfa',

  // Sequential ramp, running the other way: away from the dark card means lightening,
  // held to the same ink floor on every step.
  '--seq-1': '#1e2733',
  '--seq-2': '#26364a',
  '--seq-3': '#2f4661',
  '--seq-4': '#39567a',
  '--seq-5': '#436894',
  '--seq-foreground': '#f2f1ef',

  // Syntax highlighting, lightened for the dark surfaces against the same 4.5:1 floor the
  // light theme is held to.
  '--code-changed': '#f0b45f',
  '--code-comment': '#9a938a',
  '--code-constant': '#f0b45f',
  '--code-deleted': '#f78a8a',
  '--code-function': '#8fb8ff',
  '--code-inserted': '#86d9a8',
  '--code-keyword': '#f090c0',
  '--code-link': '#8fb8ff',
  '--code-parameter': '#e3c489',
  '--code-punctuation': '#a8a199',
  '--code-string': '#86d9a8',
  '--code-string-expression': '#86d9a8',
} as const satisfies Readonly<Record<keyof typeof LIGHT, string>>;

export const THEME_COLOURS: Readonly<Record<ThemeName, Readonly<Record<ColourToken, string>>>> = {
  light: LIGHT,
  dark: DARK,
};

/**
 * Colour utilities that name a role rather than a token, for shadcn/ui compatibility.
 * `--color-muted-foreground` is the canonical muted-text utility: the accessibility
 * contrast tiers override --foreground-muted, so this alias is what makes those tiers
 * affect muted text.
 */
export const THEME_ALIASES: Readonly<Record<string, string>> = {
  primary: 'var(--brand-red)',
  'primary-foreground': ON_ACCENT,
  destructive: 'var(--error)',
  'destructive-foreground': ON_ACCENT,
  muted: 'var(--background-subtle)',
  'muted-foreground': 'var(--foreground-muted)',
  card: 'var(--background-paper)',
  'card-foreground': 'var(--foreground)',
  popover: 'var(--background-paper)',
  'popover-foreground': 'var(--foreground)',
  input: 'var(--border)',
  ring: 'var(--brand-red)',
};

/**
 * Sans is the global default (UI chrome); serif is opt-in for reading surfaces; mono for
 * code. See the cascade rule in the stylesheet's base layer and the Reading-versus-Chrome
 * Rule in docs/DESIGN.md.
 */
export const FONT_FAMILIES = {
  sans: "'Hanken Grotesk', system-ui, sans-serif",
  serif: "'Merriweather', Georgia, serif",
  mono: "'JetBrains Mono', ui-monospace, monospace",
} as const;

/** The corner radius and its steps, in rem so radii scale with the accessibility text size. */
export const RADIUS = {
  base: '0.5rem',
  steps: {
    sm: 'calc(var(--radius) - 4px)',
    md: 'calc(var(--radius) - 2px)',
    lg: 'var(--radius)',
    xl: 'calc(var(--radius) + 4px)',
  },
} as const;

/**
 * The one app header height (chat header, sidebar header, settings and usage page
 * headers). Rem-based so every header scales together with the root font size, the
 * accessibility text-size control and the embedded demo's reduced root font included.
 */
export const APP_HEADER_HEIGHT = '3.3125rem';

export type ModelSwatch = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export const MODEL_SWATCH_COUNT = 8;

export const MOTION = {
  fastMs: 150,
  baseMs: 200,
  slowMs: 300,
  deliberateMs: 500,
  easeStandard: [0.4, 0, 0.2, 1],
} as const;

export type TypeRole =
  | 'display-1'
  | 'display-2'
  | 'title-1'
  | 'title-2'
  | 'title-3'
  | 'title-3-read'
  | 'lead'
  | 'body'
  | 'body-lg'
  | 'body-sub'
  | 'ui-lg'
  | 'ui'
  | 'ui-sm'
  | 'caption'
  | 'mono'
  | 'num'
  | 'tabular'
  | 'site-hero'
  | 'site-section'
  | 'site-title'
  | 'auth-title'
  | 'header-title'
  | 'chat-greeting'
  | 'site-post-title'
  | 'site-lead'
  | 'site-value'
  | 'site-subhead'
  | 'site-trust'
  | 'ui-snug'
  | 'site-card-title'
  | 'mono-sm'
  | 'site-cipher';

export interface TypeRoleValues {
  readonly face: 'serif' | 'sans' | 'mono';
  readonly size: string;
  readonly lineHeight: string;
  readonly weight: number;
  readonly tracking?: string;
  readonly tone?: 'muted';
  /** The role's size from the 768 band up; the role keeps its weight and tracking. */
  readonly fromDesktop?: { readonly size: string; readonly lineHeight: string };
}

/**
 * The type roles. The family is the role's, applied by the component that draws it.
 * `tabular` is a figure style rather than a size: it sets figures in the mono face at
 * whatever size and leading surround them, so its size is `1em` and its leading
 * inherits. The `site-*` roles are the public site's headings, whose sizes match no
 * app role.
 */
export const TYPE_ROLES: Readonly<Record<TypeRole, TypeRoleValues>> = {
  'display-1': {
    face: 'serif',
    size: 'clamp(2.25rem, 1.6rem + 3.2vw, 3.75rem)',
    lineHeight: '1.08',
    weight: 700,
    tracking: '-0.025em',
  },
  'display-2': {
    face: 'serif',
    size: 'clamp(1.875rem, 1.4rem + 2vw, 3rem)',
    lineHeight: '1.15',
    weight: 700,
    tracking: '-0.02em',
  },
  'title-1': { face: 'serif', size: '1.5rem', lineHeight: '1.25', weight: 700 },
  'title-2': { face: 'serif', size: '1.25rem', lineHeight: '1.3', weight: 700 },
  'title-3': { face: 'sans', size: '1rem', lineHeight: '1.35', weight: 600 },
  'title-3-read': { face: 'serif', size: '1.0625rem', lineHeight: '1.35', weight: 700 },
  lead: { face: 'serif', size: '1.125rem', lineHeight: '1.55', weight: 400 },
  body: { face: 'serif', size: '1rem', lineHeight: '1.65', weight: 400 },
  'body-lg': {
    face: 'serif',
    size: '1rem',
    lineHeight: '1.7',
    weight: 400,
    fromDesktop: { size: '1.0625rem', lineHeight: '1.7' },
  },
  'body-sub': {
    face: 'serif',
    size: '0.9375rem',
    lineHeight: '1.65',
    weight: 400,
    tone: 'muted',
  },
  'ui-lg': { face: 'sans', size: '1rem', lineHeight: '1.4', weight: 500 },
  ui: { face: 'sans', size: '0.875rem', lineHeight: '1.43', weight: 400 },
  'ui-sm': { face: 'sans', size: '0.8125rem', lineHeight: '1.4', weight: 400 },
  caption: { face: 'sans', size: '0.75rem', lineHeight: '1.35', weight: 400, tone: 'muted' },
  mono: { face: 'mono', size: '0.875rem', lineHeight: '1.55', weight: 400 },
  num: { face: 'mono', size: '0.8125rem', lineHeight: '1.4', weight: 400, tracking: '-0.01em' },
  tabular: { face: 'mono', size: '1em', lineHeight: 'inherit', weight: 500, tracking: '-0.02em' },
  'site-hero': {
    face: 'serif',
    size: 'clamp(2.25rem, 1.2rem + 3.5vw, 3.75rem)',
    lineHeight: '1.1',
    weight: 700,
    tracking: '-0.025em',
  },
  'site-section': {
    face: 'serif',
    size: 'clamp(1.875rem, 1.55rem + 1.1vw, 2.25rem)',
    lineHeight: '1.2',
    weight: 700,
    tracking: '-0.025em',
  },
  'site-title': {
    face: 'serif',
    size: '1.875rem',
    lineHeight: '1.2',
    weight: 700,
    tracking: '-0.025em',
    fromDesktop: { size: '2.25rem', lineHeight: '1.111' },
  },
  'auth-title': { face: 'serif', size: '1.875rem', lineHeight: '1.2', weight: 700 },
  'header-title': { face: 'sans', size: '0.875rem', lineHeight: '1.25', weight: 500 },
  'chat-greeting': {
    face: 'serif',
    size: '1.875rem',
    lineHeight: '1.2',
    weight: 700,
    tracking: '-0.025em',
    fromDesktop: { size: '2.75rem', lineHeight: '1.15' },
  },
  'site-post-title': {
    face: 'serif',
    size: '2.25rem',
    lineHeight: '1.111',
    weight: 700,
    tracking: '-0.025em',
    fromDesktop: { size: '3rem', lineHeight: '1' },
  },
  'site-lead': {
    face: 'serif',
    size: 'clamp(1.5rem, 1.2rem + 1.2vw, 2.25rem)',
    lineHeight: '1.2',
    weight: 700,
    tracking: '-0.02em',
  },
  'site-value': {
    face: 'serif',
    size: 'clamp(1.125rem, 1.08rem + 0.2vw, 1.25rem)',
    lineHeight: '1.4',
    weight: 700,
    tracking: '-0.025em',
  },
  'site-subhead': { face: 'serif', size: '1.25rem', lineHeight: '1.4', weight: 600 },
  'site-trust': { face: 'serif', size: '1rem', lineHeight: '1.5', weight: 600 },
  'ui-snug': { face: 'sans', size: '0.875rem', lineHeight: '1.35', weight: 400 },
  'site-card-title': { face: 'serif', size: '1rem', lineHeight: '1.4', weight: 600 },
  'mono-sm': { face: 'mono', size: '0.75rem', lineHeight: '1.43', weight: 400 },
  'site-cipher': { face: 'mono', size: '0.8125rem', lineHeight: '1.55', weight: 400 },
};

export type ContainerKey =
  | 'composer-compact'
  | 'composer-ai-icon'
  | 'composer-mode-icon'
  | 'composer-minimal'
  | 'cmp-columns'
  | 'cmp-grid'
  | 'panehost-dock'
  | 'docpane-run-row'
  | 'a11y-two-col'
  | 'auth-wall'
  | 'header-new-chat'
  | 'header-branch-label'
  | 'budget-table'
  | 'cost-split'
  | 'usage-pair'
  | 'branch-current-3line'
  | 'mkt-cost-stack'
  | 'mkt-list-provider'
  | 'mkt-compare-tight'
  | 'mkt-stack-label-above';

type Rem = `${number}rem`;

/** A length in rem, rounded so float noise never reaches the stylesheet. */
function rem(value: number): Rem {
  const rounded = Number(value.toFixed(4));
  // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- a finite number renders as the plain decimal the `${number}rem` type names, which String() would widen to `${string}rem`
  return `${rounded}rem`;
}

/** The width at which two equal columns and the gap between them fit side by side. */
function twoColumns(columnRem: number, gapRem: number): Rem {
  return rem(2 * columnRem + gapRem);
}

/**
 * The auth frame shows its wall only once the wall gets this share of the frame beside
 * a form column that keeps its minimum, so the threshold is derived from the two.
 */
const AUTH_WALL = { formMin: '34rem', wallShare: 1 / 3 } as const;

// Thresholds in rem rather than em: in a container condition an em resolves against
// the query container's own font size, so a component set in smaller text would move
// its own threshold, while a rem threshold follows only the root and the user's text
// size.
const CONTAINERS = {
  'composer-compact': '34rem',
  'composer-ai-icon': '24rem',
  'composer-mode-icon': '20.5rem',
  'composer-minimal': '20rem',
  'cmp-columns': '38rem',
  'cmp-grid': '58rem',
  'panehost-dock': '51rem',
  'docpane-run-row': '24.75rem',
  'a11y-two-col': '26rem',
  'auth-wall': rem(Number.parseFloat(AUTH_WALL.formMin) / (1 - AUTH_WALL.wallShare)),
  'header-new-chat': '22.5rem',
  // Below it the header's branch switcher shows its icon alone: the trailing controls
  // (~9.5rem), the full trigger (~6.5rem) and the gaps leave the title less than its first word.
  'header-branch-label': '20rem',
  'budget-table': '24rem',
  'cost-split': twoColumns(17, 2.5),
  'usage-pair': twoColumns(24, 2.5),
  'branch-current-3line': '22.125rem',
  'mkt-cost-stack': '19.5rem',
  'mkt-list-provider': '30rem',
  'mkt-compare-tight': '27rem',
  // Where the widest stacked answer, in the widest face the widget offers, no longer fits
  // beside its 6.5rem label: OpenDyslexic clips there up to a 16rem box and is clean at 16.33rem.
  'mkt-stack-label-above': '16.75rem',
} as const satisfies Readonly<Record<ContainerKey, Rem>>;

export const LAYOUT = {
  bandPx: MOBILE_BREAKPOINT,
  measureChat: '42rem',
  gutter: { phone: '1rem', desktop: '1.5rem' },
  // A button fills a space 40rem or narrower and keeps its own width, at least 12rem,
  // beyond it; a row of two stacks below 18rem and a row of three or more below 28rem.
  buttonRule: {
    fullWidthMax: '40rem',
    minWidth: '12rem',
    stackTwoBelow: '18rem',
    stackManyBelow: '28rem',
  },
  containers: CONTAINERS,
  authWall: AUTH_WALL,
} as const;

/**
 * The semantic stacking scale, and the one source of overlay stacking order so portaled
 * surfaces layer predictably instead of all sharing a flat band. Ascending: sticky page
 * chrome, the sidebar drawer, then popovers and menus sharing the base overlay band with
 * modals (they live in separate portal stacking contexts and never need to outrank each
 * other); toasts sit above modals, and the offline overlay sits on top of everything so a
 * lost connection is never hidden behind a dialog. Values leave headroom below the
 * view-transition layer (z-index: 9999) the theme-toggle animation uses.
 */
export const Z = {
  sticky: 20,
  drawer: 40,
  popover: 50,
  modal: 50,
  toast: 60,
  overlay: 70,
} as const;

export interface EmailPalette {
  readonly canvas: string;
  readonly card: string;
  readonly cardBorder: string;
  readonly rule: string;
  readonly text: string;
  readonly muted: string;
  readonly accent: string;
  readonly onAccent: string;
  readonly codeWell: string;
}

/**
 * The media condition an email's light palette is written under. The dev email gallery
 * rewrites this exact text to pin a frame's scheme, so writer and gallery read it here.
 */
export const EMAIL_LIGHT_SCHEME_CONDITION = '@media (prefers-color-scheme: light)';

/**
 * Literal colours for mail, which reads no CSS custom property. Every value but the dark
 * canvas is read from the theme, so a retuned token reaches mail.
 */
export const EMAIL_PALETTE: Readonly<Record<'dark' | 'light', EmailPalette>> = {
  dark: {
    canvas: EMAIL_DARK_CANVAS,
    card: DARK['--background'],
    cardBorder: DARK['--border'],
    rule: DARK['--border'],
    text: DARK['--foreground'],
    muted: DARK['--foreground-muted'],
    accent: DARK['--brand-red'],
    onAccent: ON_ACCENT,
    codeWell: EMAIL_DARK_CANVAS,
  },
  light: {
    canvas: LIGHT['--background'],
    card: LIGHT['--background-paper'],
    cardBorder: LIGHT['--border'],
    rule: LIGHT['--sidebar-border'],
    text: LIGHT['--foreground'],
    muted: LIGHT['--foreground-muted'],
    accent: LIGHT['--brand-red'],
    onAccent: ON_ACCENT,
    codeWell: LIGHT['--background-subtle'],
  },
};
