import { describe, it, expect } from 'vitest';

import { MOBILE_BREAKPOINT } from '../platform/mobile.ts';

import {
  EMAIL_LIGHT_SCHEME_CONDITION,
  EMAIL_PALETTE,
  LAYOUT,
  MODEL_SWATCH_COUNT,
  MOTION,
  THEME_COLOURS,
  TYPE_ROLES,
  Z,
  type ColourToken,
  type ContainerKey,
  type EmailPalette,
  type ThemeName,
  type TypeRole,
} from './tokens.ts';

const THEMES: readonly ThemeName[] = ['light', 'dark'];

/** A rem length as the container table writes it: a plain decimal, never an expression. */
const REM_LENGTH = /^\d+(?:\.\d+)?rem$/;

function remOf(length: string): number {
  if (!REM_LENGTH.test(length)) throw new Error(`not a rem length: ${length}`);
  return Number(length.slice(0, -'rem'.length));
}

describe('the theme colours', () => {
  it('declare the same tokens in both themes', () => {
    expect(Object.keys(THEME_COLOURS.dark)).toStrictEqual(Object.keys(THEME_COLOURS.light));
  });

  it.each(THEMES)('%s declares every model swatch and no more', (theme) => {
    const swatches = Object.keys(THEME_COLOURS[theme]).filter((token) =>
      /^--model-\d+$/.test(token)
    );
    expect(swatches).toStrictEqual(
      Array.from({ length: MODEL_SWATCH_COUNT }, (_, index) => `--model-${String(index + 1)}`)
    );
  });

  it('offers eight model swatches', () => {
    expect(MODEL_SWATCH_COUNT).toBe(8);
  });

  it.each(THEMES)('%s gives every token a value', (theme) => {
    for (const value of Object.values(THEME_COLOURS[theme])) expect(value.trim()).not.toBe('');
  });
});

/**
 * Which theme colour each email colour is read from. The dark canvas is the one value
 * mail owns outright, so it has no row here.
 */
interface EmailSource {
  readonly theme: 'dark' | 'light';
  readonly field: keyof EmailPalette;
  readonly token: ColourToken | 'on-accent';
}

const EMAIL_SOURCES: readonly EmailSource[] = [
  { theme: 'dark', field: 'card', token: '--background' },
  { theme: 'dark', field: 'cardBorder', token: '--border' },
  { theme: 'dark', field: 'rule', token: '--border' },
  { theme: 'dark', field: 'text', token: '--foreground' },
  { theme: 'dark', field: 'muted', token: '--foreground-muted' },
  { theme: 'dark', field: 'accent', token: '--brand-red' },
  { theme: 'dark', field: 'onAccent', token: 'on-accent' },
  { theme: 'light', field: 'canvas', token: '--background' },
  { theme: 'light', field: 'card', token: '--background-paper' },
  { theme: 'light', field: 'cardBorder', token: '--border' },
  { theme: 'light', field: 'rule', token: '--sidebar-border' },
  { theme: 'light', field: 'text', token: '--foreground' },
  { theme: 'light', field: 'muted', token: '--foreground-muted' },
  { theme: 'light', field: 'accent', token: '--brand-red' },
  { theme: 'light', field: 'onAccent', token: 'on-accent' },
  { theme: 'light', field: 'codeWell', token: '--background-subtle' },
];

describe('the email palette', () => {
  it.each(EMAIL_SOURCES)('$theme $field is the $token theme colour', ({ theme, field, token }) => {
    const expected = token === 'on-accent' ? '#ffffff' : THEME_COLOURS[theme][token];
    expect(EMAIL_PALETTE[theme][field]).toBe(expected);
  });

  it('paints the dark canvas the email-only near-black', () => {
    expect(EMAIL_PALETTE.dark.canvas).toBe('#0c0b0a');
  });

  it('draws the dark code well on the dark canvas', () => {
    expect(EMAIL_PALETTE.dark.codeWell).toBe('#0c0b0a');
  });

  it('puts the light palette under the light colour-scheme media condition', () => {
    expect(EMAIL_LIGHT_SCHEME_CONDITION).toBe('@media (prefers-color-scheme: light)');
  });
});

type RoleValues = (typeof TYPE_ROLES)[TypeRole];

const KIT_ROLES: readonly (readonly [TypeRole, RoleValues])[] = [
  [
    'display-1',
    {
      face: 'serif',
      size: 'clamp(2.25rem, 1.6rem + 3.2vw, 3.75rem)',
      lineHeight: '1.08',
      weight: 700,
      tracking: '-0.025em',
    },
  ],
  [
    'display-2',
    {
      face: 'serif',
      size: 'clamp(1.875rem, 1.4rem + 2vw, 3rem)',
      lineHeight: '1.15',
      weight: 700,
      tracking: '-0.02em',
    },
  ],
  ['title-1', { face: 'serif', size: '1.5rem', lineHeight: '1.25', weight: 700 }],
  ['title-2', { face: 'serif', size: '1.25rem', lineHeight: '1.3', weight: 700 }],
  ['title-3', { face: 'sans', size: '1rem', lineHeight: '1.35', weight: 600 }],
  ['title-3-read', { face: 'serif', size: '1.0625rem', lineHeight: '1.35', weight: 700 }],
  ['lead', { face: 'serif', size: '1.125rem', lineHeight: '1.55', weight: 400 }],
  ['body', { face: 'serif', size: '1rem', lineHeight: '1.65', weight: 400 }],
  [
    'body-lg',
    {
      face: 'serif',
      size: '1rem',
      lineHeight: '1.7',
      weight: 400,
      fromDesktop: { size: '1.0625rem', lineHeight: '1.7' },
    },
  ],
  [
    'body-sub',
    { face: 'serif', size: '0.9375rem', lineHeight: '1.65', weight: 400, tone: 'muted' },
  ],
  ['ui-lg', { face: 'sans', size: '1rem', lineHeight: '1.4', weight: 500 }],
  ['ui', { face: 'sans', size: '0.875rem', lineHeight: '1.43', weight: 400 }],
  ['ui-sm', { face: 'sans', size: '0.8125rem', lineHeight: '1.4', weight: 400 }],
  ['caption', { face: 'sans', size: '0.75rem', lineHeight: '1.35', weight: 400, tone: 'muted' }],
  ['mono', { face: 'mono', size: '0.875rem', lineHeight: '1.55', weight: 400 }],
  ['num', { face: 'mono', size: '0.8125rem', lineHeight: '1.4', weight: 400, tracking: '-0.01em' }],
  [
    'tabular',
    { face: 'mono', size: '1em', lineHeight: 'inherit', weight: 500, tracking: '-0.02em' },
  ],
];

const SITE_ROLES: readonly (readonly [TypeRole, RoleValues])[] = [
  [
    'site-hero',
    {
      face: 'serif',
      size: 'clamp(2.25rem, 1.2rem + 3.5vw, 3.75rem)',
      lineHeight: '1.1',
      weight: 700,
      tracking: '-0.025em',
    },
  ],
  [
    'site-section',
    {
      face: 'serif',
      size: 'clamp(1.875rem, 1.55rem + 1.1vw, 2.25rem)',
      lineHeight: '1.2',
      weight: 700,
      tracking: '-0.025em',
    },
  ],
  [
    'site-title',
    {
      face: 'serif',
      size: '1.875rem',
      lineHeight: '1.2',
      weight: 700,
      tracking: '-0.025em',
      fromDesktop: { size: '2.25rem', lineHeight: '1.111' },
    },
  ],
  [
    'site-post-title',
    {
      face: 'serif',
      size: '2.25rem',
      lineHeight: '1.111',
      weight: 700,
      tracking: '-0.025em',
      fromDesktop: { size: '3rem', lineHeight: '1' },
    },
  ],
  [
    'site-lead',
    {
      face: 'serif',
      size: 'clamp(1.5rem, 1.2rem + 1.2vw, 2.25rem)',
      lineHeight: '1.2',
      weight: 700,
      tracking: '-0.02em',
    },
  ],
  [
    'site-value',
    {
      face: 'serif',
      size: 'clamp(1.125rem, 1.08rem + 0.2vw, 1.25rem)',
      lineHeight: '1.4',
      weight: 700,
      tracking: '-0.025em',
    },
  ],
  ['site-subhead', { face: 'serif', size: '1.25rem', lineHeight: '1.4', weight: 600 }],
  ['site-trust', { face: 'serif', size: '1rem', lineHeight: '1.5', weight: 600 }],
  ['site-card-title', { face: 'serif', size: '1rem', lineHeight: '1.4', weight: 600 }],
  ['site-cipher', { face: 'mono', size: '0.8125rem', lineHeight: '1.55', weight: 400 }],
];

const AUTH_ROLES: readonly (readonly [TypeRole, RoleValues])[] = [
  ['auth-title', { face: 'serif', size: '1.875rem', lineHeight: '1.2', weight: 700 }],
];

const HEADER_ROLES: readonly (readonly [TypeRole, RoleValues])[] = [
  ['header-title', { face: 'sans', size: '0.875rem', lineHeight: '1.25', weight: 500 }],
];

const GREETING_ROLES: readonly (readonly [TypeRole, RoleValues])[] = [
  [
    'chat-greeting',
    {
      face: 'serif',
      size: '1.875rem',
      lineHeight: '1.2',
      weight: 700,
      tracking: '-0.025em',
      fromDesktop: { size: '2.75rem', lineHeight: '1.15' },
    },
  ],
];

const SNUG_ROLES: readonly (readonly [TypeRole, RoleValues])[] = [
  ['ui-snug', { face: 'sans', size: '0.875rem', lineHeight: '1.35', weight: 400 }],
];

const SMALL_MONO_ROLES: readonly (readonly [TypeRole, RoleValues])[] = [
  ['mono-sm', { face: 'mono', size: '0.75rem', lineHeight: '1.43', weight: 400 }],
];

describe('the type roles', () => {
  it('are exactly the seventeen kit roles, the ten site roles, the auth title, the header title, the chat greeting, the snug ui row and the small mono line', () => {
    expect(Object.keys(TYPE_ROLES).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(
      [
        ...KIT_ROLES,
        ...SITE_ROLES,
        ...AUTH_ROLES,
        ...HEADER_ROLES,
        ...GREETING_ROLES,
        ...SNUG_ROLES,
        ...SMALL_MONO_ROLES,
      ]
        .map(([role]) => role)
        .toSorted((a, b) => a.localeCompare(b))
    );
    expect(KIT_ROLES).toHaveLength(17);
    expect(SITE_ROLES).toHaveLength(10);
    expect(AUTH_ROLES).toHaveLength(1);
    expect(HEADER_ROLES).toHaveLength(1);
    expect(GREETING_ROLES).toHaveLength(1);
    expect(SNUG_ROLES).toHaveLength(1);
    expect(SMALL_MONO_ROLES).toHaveLength(1);
  });

  it.each([
    ...KIT_ROLES,
    ...SITE_ROLES,
    ...AUTH_ROLES,
    ...HEADER_ROLES,
    ...GREETING_ROLES,
    ...SNUG_ROLES,
    ...SMALL_MONO_ROLES,
  ])('%s carries its values', (role, values) => {
    expect(TYPE_ROLES[role]).toStrictEqual(values);
  });
});

const CONTAINER_KEYS: readonly ContainerKey[] = [
  'composer-compact',
  'composer-ai-icon',
  'composer-mode-icon',
  'composer-minimal',
  'cmp-columns',
  'cmp-grid',
  'panehost-dock',
  'docpane-run-row',
  'a11y-two-col',
  'auth-wall',
  'header-new-chat',
  'header-branch-label',
  'budget-table',
  'cost-split',
  'usage-pair',
  'branch-current-3line',
  'mkt-cost-stack',
  'mkt-list-provider',
  'mkt-compare-tight',
  'mkt-stack-label-above',
];

describe('the layout', () => {
  it('reads its band from the one breakpoint constant', () => {
    expect(LAYOUT.bandPx).toBe(MOBILE_BREAKPOINT);
  });

  it('keys exactly the listed containers', () => {
    expect(Object.keys(LAYOUT.containers).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(
      CONTAINER_KEYS.toSorted((a, b) => a.localeCompare(b))
    );
  });

  it.each(CONTAINER_KEYS)('%s is a rem length', (key) => {
    expect(LAYOUT.containers[key]).toMatch(REM_LENGTH);
  });

  it('shows the auth wall once it gets its share beside the form minimum', () => {
    const { formMin, wallShare } = LAYOUT.authWall;
    expect(remOf(LAYOUT.containers['auth-wall'])).toBeCloseTo(remOf(formMin) / (1 - wallShare), 6);
  });

  it('splits costs at two 17rem columns and the 2.5rem gap', () => {
    expect(remOf(LAYOUT.containers['cost-split'])).toBe(2 * 17 + 2.5);
  });

  it('pairs the usage charts at two 24rem columns and the 2.5rem gap', () => {
    expect(remOf(LAYOUT.containers['usage-pair'])).toBe(2 * 24 + 2.5);
  });

  it('stacks a site cost row only below the width a 360px phone leaves inside the 1.5rem page gutters', () => {
    expect(remOf(LAYOUT.containers['mkt-cost-stack'])).toBe(360 / 16 - 2 * 1.5);
  });

  it('tightens the site comparison table only below the width a 480px screen leaves inside the 1.5rem page gutters', () => {
    expect(remOf(LAYOUT.containers['mkt-compare-tight'])).toBe(480 / 16 - 2 * 1.5);
  });

  it('lifts a stacked row label above its answer at the width where the widest answer, in the widest face, no longer fits beside it', () => {
    expect(remOf(LAYOUT.containers['mkt-stack-label-above'])).toBe(16.75);
  });

  it('keeps a stacked row label beside its answer in the width a 320px phone leaves inside the 1.5rem page gutters', () => {
    expect(remOf(LAYOUT.containers['mkt-stack-label-above'])).toBeLessThan(320 / 16 - 2 * 1.5);
  });
});

describe('the motion and stacking scales', () => {
  it('carries the four durations and the standard easing', () => {
    expect(MOTION).toStrictEqual({
      fastMs: 150,
      baseMs: 200,
      slowMs: 300,
      deliberateMs: 500,
      easeStandard: [0.4, 0, 0.2, 1],
    });
  });

  it('orders the stacking layers from sticky chrome to the offline overlay', () => {
    expect(Z).toStrictEqual({
      sticky: 20,
      drawer: 40,
      popover: 50,
      modal: 50,
      toast: 60,
      overlay: 70,
    });
  });
});
