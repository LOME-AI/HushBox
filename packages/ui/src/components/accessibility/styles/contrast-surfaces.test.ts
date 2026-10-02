import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { contrastRatio, parseCssColor, relativeLuminance } from '@hushbox/shared/color/contrast';

import { A11Y_CLASS_RULES } from '../lib/class-toggles';
import { declaredValue } from './css-declarations';
import { mixSrgb } from './mix-srgb';

/**
 * The six surfaces a reader sees behind content — cards and popovers, muted wells,
 * secondary and hover fills, the sidebar rail and its edge — are not authored per tier.
 * One rule mixes each of them out of the anchors the active tier already declares, so a
 * tier that moves its canvas or its ink moves its surfaces with it and no tier can be
 * left showing the base theme's cream cards on a canvas it has turned pure white.
 *
 * Everything here is measured on values resolved from the stylesheet source the same way
 * the cascade resolves them — tier block, then theme — and never on hex typed into this
 * file: a literal pins the letter and has to be rewritten whenever a value is retuned,
 * where a resolved value pins what the value is for and survives the retune.
 */

const stylesDir = path.dirname(fileURLToPath(import.meta.url));
const contrastCss = readFileSync(path.join(stylesDir, 'contrast.css'), 'utf8');
const themeCss = readFileSync(
  path.join(stylesDir, '../../../../../config/tailwind/index.css'),
  'utf8'
);

/**
 * The rule carrying the derivation. The attribute selector matches every tier class the
 * settings applier toggles onto <html> and nothing in the untiered themes, so one block
 * covers tiers that do not exist yet.
 */
const SURFACE_RULE = "html[class*='a11y-contrast-']";

/** The class substring the rule matches on. */
const RULE_SUBSTRING = (() => {
  const match = /\[class\*='([^']+)']/.exec(SURFACE_RULE);
  if (match === null) throw new Error('the surface rule does not match on a class substring');
  return match[1]!;
})();

/**
 * The tier classes, taken from the applier's own list rather than restated here: a tier
 * renamed or added there has to reach this file, and a second spelling of the list would
 * let it stop reaching the rule without anything saying so.
 */
const TIER_CLASSES = A11Y_CLASS_RULES.filter((rule) => rule.field === 'contrast').map(
  (rule) => rule.className
);

const DERIVED_SURFACES = [
  '--background-paper',
  '--background-subtle',
  '--secondary',
  '--accent',
  '--sidebar',
  '--sidebar-border',
] as const;

/**
 * `color-mix(in srgb, <partner> var(--surface-step-*), var(--background))`, with the
 * partner either an anchor reference or a literal. Capturing the pieces rather than
 * matching the whole string is what lets the arithmetic below follow a retuned rule
 * instead of a copy of it.
 */
const DERIVED_FORM =
  /^color-mix\(\s*in srgb,\s*(?:var\((--[\w-]+)\)|(#[0-9a-f]{6}))\s+var\((--surface-step-[\w-]+)\),\s*var\((--[\w-]+)\)\s*\)$/;

interface DerivedSurface {
  readonly partnerToken: string | null;
  readonly partnerLiteral: string | null;
  readonly stepToken: string;
  readonly bottomToken: string;
}

function derivedSurface(variable: string): DerivedSurface {
  const value = declaredValue(contrastCss, SURFACE_RULE, variable);
  if (value === null) throw new Error(`${variable} is not declared by the surface rule`);
  const match = DERIVED_FORM.exec(value.replaceAll(/\s+/g, ' '));
  if (match === null) throw new Error(`${variable} is not a derived surface: ${value}`);
  const [, partnerToken, partnerLiteral, stepToken, bottomToken] = match;
  return {
    partnerToken: partnerToken ?? null,
    partnerLiteral: partnerLiteral ?? null,
    stepToken: stepToken!,
    bottomToken: bottomToken!,
  };
}

/** Every declaration of `variable` in a stylesheet, `!important` marker included. */
function declarations(css: string, variable: string): string[] {
  return [...css.matchAll(new RegExp(String.raw`${variable}:\s*([^;]+);`, 'g'))].map(([, value]) =>
    value!.trim()
  );
}

describe('the tier rule derives every surface the base theme layers over the canvas', () => {
  it.each(DERIVED_SURFACES)('%s is declared by the tier rule', (variable) => {
    expect(declaredValue(contrastCss, SURFACE_RULE, variable)).not.toBeNull();
  });

  // Tailwind's :root and .dark are unlayered, and an unlayered declaration beats a layered
  // one whatever its specificity; without the marker every one of these silently loses to
  // the base theme's value.
  it.each(DERIVED_SURFACES)('%s is declared exactly once, with !important', (variable) => {
    const declared = declarations(contrastCss, variable);
    expect(declared).toHaveLength(1);
    expect(declared[0]).toMatch(/!important$/);
  });

  it.each(DERIVED_SURFACES)('%s mixes a step of its own into this tier’s canvas', (variable) => {
    const surface = derivedSurface(variable);
    expect(surface.bottomToken).toBe('--background');
    // The partner is this tier's own ink, or a fixed literal where a surface deliberately
    // moves away from it; anything else would be a third colour the tier does not control.
    expect(surface.partnerToken ?? surface.partnerLiteral).toMatch(
      /^(?:--foreground|#[0-9a-f]{6})$/
    );
  });

  // A tier class the selector's substring misses is a tier the rule never reaches, and every
  // measurement below would still pass while that tier rendered the base theme's surfaces.
  it('the rule reaches every contrast class the applier can set', () => {
    expect(TIER_CLASSES.length).toBeGreaterThan(0);
    for (const className of TIER_CLASSES) expect(className).toContain(RULE_SUBSTRING);
  });

  // Secondary fills and hover fills are one family: a reader who tells a secondary button
  // from a ghost one is reading the same step the dropdown highlight uses.
  it('the secondary fill and the hover fill take the same step', () => {
    expect(derivedSurface('--accent').stepToken).toBe(derivedSurface('--secondary').stepToken);
  });
});

/** WCAG 2 floors, by the criterion each one comes from. */
const AAA = 7;
const AA = 4.5;
const NON_TEXT = 3;

/**
 * The tier whose purpose is less contrast, not more: it holds text to the AA floor where
 * the other tiers hold it to AAA. Relaxing it further is what its own floors below refuse.
 */
const SOFTENED_TIER = 'low';

/**
 * Every theme-and-tier a reader can put the app into. A dark cell lists its dark block
 * first and its tier's plain block second, because both selectors match a dark tiered
 * document and the more specific one wins — so a value the dark half does not restate is
 * the one the tier declares once, not the theme's.
 */
const CELLS = TIER_CLASSES.flatMap((className) => {
  const tier = className.slice(RULE_SUBSTRING.length);
  return [
    { name: `contrast-${tier}, light`, tier, theme: ':root', blocks: [`html.${className}`] },
    {
      name: `contrast-${tier}, dark`,
      tier,
      theme: '.dark',
      blocks: [`html.${className}.dark`, `html.${className}`],
    },
  ];
});

type Cell = (typeof CELLS)[number];

/** The floor text sits at in a cell: AAA everywhere the tier is not the softened one. */
function textFloor(cell: Cell): number {
  return cell.tier === SOFTENED_TIER ? AA : AAA;
}

/** A declared percentage as the fraction `color-mix` weights its partner by. */
function percentageOf(stepToken: string, declared: string): number {
  const percentage = /^(\d+(?:\.\d+)?)%$/.exec(declared);
  if (percentage === null) throw new Error(`${stepToken} is not a percentage: ${declared}`);
  return Number(percentage[1]) / 100;
}

/** What a token resolves to in a cell: the tier's own value, else the theme's. */
function resolveToken(cell: Cell, variable: string): string {
  for (const block of cell.blocks) {
    const override = declaredValue(contrastCss, block, variable);
    if (override !== null) return override;
  }
  const themed = declaredValue(themeCss, cell.theme, variable);
  if (themed === null)
    throw new Error(`${variable} is declared in neither ${cell.name} nor a tier`);
  return themed;
}

/** A step, as the fraction `color-mix` weights the partner by: the tier's, else the rule's. */
function resolveStep(cell: Cell, stepToken: string): number {
  const declared =
    cell.blocks
      .map((block) => declaredValue(contrastCss, block, stepToken))
      .find((value) => value !== null) ?? declaredValue(contrastCss, SURFACE_RULE, stepToken);
  if (declared === null)
    throw new Error(`${stepToken} is declared by neither the tier nor the rule`);
  return percentageOf(stepToken, declared);
}

/** The step the rule declares for every tier that does not override it. */
function sharedStep(stepToken: string): number {
  const declared = declaredValue(contrastCss, SURFACE_RULE, stepToken);
  if (declared === null) throw new Error(`${stepToken} is not declared by the surface rule`);
  return percentageOf(stepToken, declared);
}

/** A derived surface as it renders in one cell, mixed the way `color-mix(in srgb, …)` mixes. */
function surfaceIn(cell: Cell, variable: string, step?: number): string {
  const { partnerToken, partnerLiteral, stepToken, bottomToken } = derivedSurface(variable);
  const partner = partnerLiteral ?? resolveToken(cell, partnerToken!);
  return mixSrgb(partner, resolveToken(cell, bottomToken), step ?? resolveStep(cell, stepToken));
}

const ratio = (a: string, b: string): number => contrastRatio(parseCssColor(a), parseCssColor(b));

/**
 * The minimum every tier owes each surface, and the neighbour it is owed against. Body and
 * muted text carry the sustained-reading floor; semantic text carries the small-text floor
 * wherever it lands; the brand ring on a well carries the non-text floor, which the base
 * theme already holds it to and no accessibility setting may drop below. The fills carry
 * their own text partner only — muted text on a fill is below AA in the base theme too,
 * so demanding it of a tier would be demanding what the default look never offered.
 */
const REQUIREMENTS = [
  { surface: '--background-paper', ink: '--foreground', floor: 'text' },
  { surface: '--background-paper', ink: '--foreground-muted', floor: 'text' },
  { surface: '--background-paper', ink: '--error', floor: AA },
  { surface: '--background-paper', ink: '--warning', floor: AA },
  { surface: '--background-paper', ink: '--success', floor: AA },
  { surface: '--background-subtle', ink: '--foreground-muted', floor: 'text' },
  { surface: '--background-subtle', ink: '--error', floor: AA },
  { surface: '--background-subtle', ink: '--warning', floor: AA },
  { surface: '--background-subtle', ink: '--success', floor: AA },
  { surface: '--background-subtle', ink: '--brand-red', floor: NON_TEXT },
  { surface: '--secondary', ink: '--secondary-foreground', floor: AA },
  { surface: '--accent', ink: '--accent-foreground', floor: AA },
  { surface: '--sidebar', ink: '--sidebar-foreground', floor: 'text' },
  { surface: '--sidebar', ink: '--foreground-muted', floor: 'text' },
  { surface: '--sidebar-border', ink: '--sidebar-foreground', floor: AA },
  { surface: '--sidebar-border', ink: '--foreground-muted', floor: AA },
  { surface: '--background-paper', ink: '--border-control', floor: NON_TEXT },
  { surface: '--background-subtle', ink: '--border-control', floor: NON_TEXT },
  { surface: '--sidebar', ink: '--border-control', floor: NON_TEXT },
] as const;

const floorCases = CELLS.flatMap((cell) =>
  REQUIREMENTS.map((requirement) => ({
    name: cell.name,
    ink: requirement.ink,
    surface: requirement.surface,
    floor: requirement.floor === 'text' ? textFloor(cell) : requirement.floor,
    inkValue: resolveToken(cell, requirement.ink),
    surfaceValue: surfaceIn(cell, requirement.surface),
  }))
);

describe('every tier keeps its text legible on the surfaces it derives', () => {
  it.each(floorCases)('$name: $ink on $surface', ({ inkValue, surfaceValue, floor }) => {
    expect(ratio(inkValue, surfaceValue)).toBeGreaterThanOrEqual(floor);
  });
});

/**
 * A control's boundary is what tells a field from the page around it, so SC 1.4.11 holds it
 * to 3:1 under every contrast setting; the canvas is not a derived surface, so it is measured
 * here rather than in the requirements above.
 */
describe('every tier keeps a control’s boundary visible on its canvas', () => {
  it.each(CELLS)('$name: --border-control on --background', (cell) => {
    expect(
      ratio(resolveToken(cell, '--border-control'), resolveToken(cell, '--background'))
    ).toBeGreaterThanOrEqual(NON_TEXT);
  });
});

const layerCases = CELLS.map((cell) => ({
  name: cell.name,
  tier: cell.tier,
  canvas: resolveToken(cell, '--background'),
  paper: surfaceIn(cell, '--background-paper'),
  subtle: surfaceIn(cell, '--background-subtle'),
  fill: surfaceIn(cell, '--secondary'),
  hover: surfaceIn(cell, '--accent'),
  sidebar: surfaceIn(cell, '--sidebar'),
  railFill: surfaceIn(cell, '--sidebar-border'),
}));

/**
 * The floors above pass just as well for six surfaces that all collapsed onto the canvas,
 * or for a card darker than the well it sits beside. This is the layering itself: each
 * reading surface stands off the canvas, and they stack in the order the base theme
 * stacks them.
 */
describe('every tier keeps the layering the base theme reads by', () => {
  it.each(layerCases)('$name: card, well and fill stack away from the canvas', (cell) => {
    expect(ratio(cell.paper, cell.canvas)).toBeLessThan(ratio(cell.subtle, cell.canvas));
    expect(ratio(cell.subtle, cell.canvas)).toBeLessThanOrEqual(ratio(cell.fill, cell.canvas));
  });

  it.each(layerCases)('$name: every surface the ink washes is visible on the canvas', (cell) => {
    for (const surface of [cell.paper, cell.subtle, cell.fill, cell.hover, cell.railFill]) {
      expect(ratio(surface, cell.canvas)).toBeGreaterThanOrEqual(1.02);
    }
  });

  // The rail is the one surface that sits under its canvas rather than over it, in both
  // themes; that is the whole reason its partner is black and not the tier's ink.
  it.each(layerCases)('$name: the rail sits no higher than the canvas', (cell) => {
    expect(relativeLuminance(parseCssColor(cell.sidebar))).toBeLessThanOrEqual(
      relativeLuminance(parseCssColor(cell.canvas))
    );
  });
});

/**
 * `--sidebar-border` is both the rail's edge and the fill behind a hovered or active item,
 * so it owes two different things: text on it stays legible, and it stays visible against
 * the rail it is drawn on.
 */
describe('the rail fill stays visible, except where legibility takes precedence', () => {
  const firm = layerCases.filter((cell) => cell.tier !== SOFTENED_TIER);

  it.each(firm)('$name: the fill stands off the rail', (cell) => {
    expect(ratio(cell.railFill, cell.sidebar)).toBeGreaterThanOrEqual(1.3);
  });

  /**
   * The softened tier cannot have both: at every step where its fill stands 1.3 off the
   * rail, muted text on that fill is below AA. Legibility wins — ruled, not inferred — so
   * this tier alone takes its own rail step, the largest whole percentage that keeps muted
   * text on the fill at AA in both halves, and its fill is allowed to sit closer to the
   * rail than any other tier's. What separates a hovered or active item there is therefore
   * a weaker wash than elsewhere, which is a known cost of the ruling and not a drift.
   */
  const softened = CELLS.filter((cell) => cell.tier === SOFTENED_TIER);

  it.each(softened)('$name: the softened tier declares its own rail step', (cell) => {
    const own = declaredValue(
      contrastCss,
      `html.a11y-contrast-${SOFTENED_TIER}`,
      '--surface-step-rail'
    );
    expect(own).not.toBeNull();
    expect(resolveStep(cell, '--surface-step-rail')).toBeLessThan(
      sharedStep('--surface-step-rail')
    );
  });

  it('the softened tier’s rail step is the largest one muted text survives', () => {
    const mutedOnFill = (cell: Cell, step: number): number =>
      ratio(resolveToken(cell, '--foreground-muted'), surfaceIn(cell, '--sidebar-border', step));
    const step = resolveStep(softened[0]!, '--surface-step-rail');
    const wholePoint = 0.01;
    for (const cell of softened) expect(mutedOnFill(cell, step)).toBeGreaterThanOrEqual(AA);
    expect(Math.min(...softened.map((cell) => mutedOnFill(cell, step + wholePoint)))).toBeLessThan(
      AA
    );
  });
});

/**
 * The anchors every surface above is mixed out of. A tier declares them as literal hex and
 * nothing else: the document sandbox's appearance bridge and the cipher-wall reader both
 * take a rendered token as `#rrggbb`, and the arithmetic here parses the same source text
 * the browser resolves — an anchor holding an expression would reach both as an expression.
 */
describe('the anchors the surfaces are mixed out of stay literal hex', () => {
  const LITERAL_HEX = /^#[0-9a-f]{6}$/;
  const blocks = CELLS.map((cell) => ({ name: cell.name, block: cell.blocks[0]! }));

  it.each(blocks)('$name declares its ink as a literal', ({ block }) => {
    expect(declaredValue(contrastCss, block, '--foreground')).toMatch(LITERAL_HEX);
  });

  it.each(blocks)('$name declares any canvas of its own as a literal', ({ block }) => {
    const canvas = declaredValue(contrastCss, block, '--background');
    if (canvas !== null) expect(canvas).toMatch(LITERAL_HEX);
  });
});

/**
 * The `:root` block of the shared theme, comments stripped so prose about a token cannot
 * pass for a declaration of one.
 */
const themeRootBlock = (() => {
  const match = /^:root \{([\S\s]*?)^\}/m.exec(themeCss);
  if (match === null) throw new Error('the shared theme declares no :root block');
  return match[1]!.replaceAll(/\/\*[\S\s]*?\*\//g, '');
})();

/** Colour notations and keywords, wider than what the arithmetic here can parse on purpose:
 * a token added in a notation this file cannot measure still has to be ruled on. */
const COLOUR_VALUE =
  /^(?:#|rgba?\(|hsla?\(|oklch\(|oklab\(|color-mix\(|transparent\b|currentColor\b)/i;

const themeColourTokens = [...themeRootBlock.matchAll(/(--[\w-]+):\s*([^;]+);/g)]
  .filter((declaration) => COLOUR_VALUE.test(declaration[2]!.trim()))
  .map((declaration) => declaration[1]!);

/** The tokens each tier restates for itself; every surface above is mixed out of one of them. */
const TIER_ANCHORS = [
  '--background',
  '--foreground',
  '--border',
  '--foreground-muted',
  '--prediction',
  '--border-control',
] as const;

/**
 * Colours a contrast tier deliberately leaves alone, each set with the reason it is left.
 * A colour that is neither derived nor restated by the tiers belongs here with a reason, so
 * a token added to the theme is a decision someone makes rather than a surface a tier
 * silently forgot.
 */
const TIER_INVARIANT = [
  {
    reason:
      'identity and status: recolouring them would change what the colour means, and each is held to its floor per theme in the shared theme’s own contrast test',
    tokens: [
      '--brand-red',
      '--brand-red-hover',
      '--error',
      '--warning',
      '--info',
      '--success',
      '--success-text',
      '--warning-text',
      '--error-text',
      '--info-text',
    ],
  },
  {
    reason:
      'a disabled control’s ink: WCAG sets no floor for an inactive control, and a tier moving it toward its own ink would make a disabled control read as an enabled one',
    tokens: ['--disabled-ink'],
  },
  {
    reason:
      'the text partner of a fill, which follows its fill rather than the tier; pointing them at the tier’s ink is a change to the base theme, reaching every reader, not a tier override',
    tokens: [
      '--secondary-foreground',
      '--accent-foreground',
      '--sidebar-foreground',
      '--seq-foreground',
    ],
  },
  {
    reason:
      'content coding: a chart series, a model swatch and a syntax token are told apart by hue, so mixing them toward the canvas would erase the distinction they exist to carry',
    tokens: [
      '--model-1',
      '--model-2',
      '--model-3',
      '--model-4',
      '--model-5',
      '--model-6',
      '--model-7',
      '--model-8',
      '--chart-1',
      '--chart-2',
      '--chart-3',
      '--chart-4',
      '--chart-5',
      '--code-changed',
      '--code-comment',
      '--code-constant',
      '--code-deleted',
      '--code-function',
      '--code-inserted',
      '--code-keyword',
      '--code-link',
      '--code-parameter',
      '--code-punctuation',
      '--code-string',
      '--code-string-expression',
    ],
  },
  {
    reason:
      'a magnitude scale rather than a layer of the canvas: its steps carry meaning by standing apart from each other, and a tier mixing each of them toward the canvas would pull them together and compress the ranking the ramp exists to express; the body ink is instead held to the small-text floor on every step, per theme, in the shared theme’s own ramp test',
    tokens: ['--seq-1', '--seq-2', '--seq-3', '--seq-4', '--seq-5'],
  },
  {
    reason:
      'a mark rather than a layer of the canvas: one fills the reader’s own turn, the other is a heavier rule weight, and neither is a surface the layering derives',
    tokens: ['--message-user', '--border-strong'],
  },
  {
    reason:
      'a mark rather than a layer of the canvas: the track a gauge fills along, whose fill rather than the track carries the reading',
    tokens: ['--meter-track'],
  },
  {
    reason:
      'not a surface at all: a translucent tint that washes whatever it lands on, and a turn left unfilled by design',
    tokens: ['--brand-red-subtle', '--message-assistant'],
  },
] as const;

const invariantTokens = TIER_INVARIANT.flatMap((group) => group.tokens);
const accountedFor: readonly string[] = [...DERIVED_SURFACES, ...TIER_ANCHORS, ...invariantTokens];

describe('every colour the theme declares is derived, restated, or invariant by decision', () => {
  it.each(TIER_ANCHORS)('%s is restated by a tier, so no rule needs to derive it', (anchor) => {
    const restating = CELLS.filter(
      (cell) => declaredValue(contrastCss, cell.blocks[0]!, anchor) !== null
    );
    expect(restating.length).toBeGreaterThan(0);
  });

  it('no colour is both derived and left invariant', () => {
    expect(accountedFor).toHaveLength(new Set(accountedFor).size);
  });

  it('every colour in the theme falls into one of the three', () => {
    expect(themeColourTokens.filter((token) => !accountedFor.includes(token))).toStrictEqual([]);
  });

  it('every colour named here is one the theme declares', () => {
    expect(accountedFor.filter((token) => !themeColourTokens.includes(token))).toStrictEqual([]);
  });
});
