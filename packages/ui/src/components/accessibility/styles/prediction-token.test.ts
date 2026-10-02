import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { contrastRatio, parseCssColor } from '@hushbox/shared/color/contrast';

import { COLORBLIND_MATRICES } from '../lib/colorblind-matrices';
import { declaredValue } from './css-declarations';
import { mixSrgb } from './mix-srgb';

/**
 * --prediction marks words the local completion model is offering but the user has not
 * typed. Its whole reason to exist is that muted text cannot carry that meaning: the
 * contrast tiers below deliberately pull --foreground-muted toward --foreground, so a
 * prediction drawn as muted text becomes indistinguishable from typed text at exactly the
 * setting a low-vision reader picks. The token therefore carries its own value in every
 * tier, and this file is where those values are held to the floors that make the mark
 * readable (text contrast against the surface it sits on) and separable from typed ink,
 * including with no colour vision. The dotted underline that keeps the mark off colour
 * alone (WCAG 1.4.1) is drawn at the call site and carries no token of its own.
 */

const stylesDir = path.dirname(fileURLToPath(import.meta.url));
const contrastCss = readFileSync(path.join(stylesDir, 'contrast.css'), 'utf8');
const themeCss = readFileSync(
  path.join(stylesDir, '../../../../../config/tailwind/index.css'),
  'utf8'
);
const textareaCss = readFileSync(path.join(stylesDir, '../../primitives/textarea.tsx'), 'utf8');

/**
 * Applies a 4x5 feColorMatrix to an opaque colour. `space` is the working space the filter
 * runs in: SVG filters interpolate in linearRGB by default, so a matrix read straight off a
 * <feColorMatrix> is not the same transform as the same matrix applied to sRGB channels.
 */
function applyColorMatrix(values: string, color: string, space: 'srgb' | 'linear-rgb'): number[] {
  const matrix = values.trim().split(/\s+/).map(Number);
  const toWorking = (channel: number): number => {
    if (space === 'srgb') return channel;
    const normalized = channel / 255;
    return (
      (normalized <= 0.040_45 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4) * 255
    );
  };
  const fromWorking = (channel: number): number => {
    if (space === 'srgb') return channel;
    const normalized = channel / 255;
    return (
      (normalized <= 0.003_130_8 ? normalized * 12.92 : 1.055 * normalized ** (1 / 2.4) - 0.055) *
      255
    );
  };
  const [red, green, blue] = parseCssColor(color).map((channel) => toWorking(channel)) as [
    number,
    number,
    number,
  ];
  // Row-major, five columns per row: the three colour weights, then the alpha column
  // (opaque, so 255) and the constant offset column (in 0-1 units, so also scaled by 255).
  return [0, 1, 2].map((row) => {
    const offset = row * 5;
    return fromWorking(
      matrix[offset]! * red +
        matrix[offset + 1]! * green +
        matrix[offset + 2]! * blue +
        matrix[offset + 3]! * 255 +
        matrix[offset + 4]! * 255
    );
  });
}

const LIGHT = ':root';
const DARK = '.dark';

/**
 * The composer's field is not transparent in dark mode: the textarea primitive washes it
 * with a fraction of `--input` over the page background, so predicted words drawn above the
 * field sit on that composite and not on `--background`. Both halves are read out of source
 * — the fraction from the primitive's own class, the token from the theme's alias — because
 * a hand-copied backdrop is exactly how a dark ratio comes to be measured against a surface
 * the reader never sees.
 */
const darkFieldWash = (() => {
  const fraction = /dark:bg-input\/(\d+)/.exec(textareaCss);
  if (fraction === null) throw new Error('the textarea primitive declares no dark-mode wash');
  const token = /--color-input:\s*var\((--[\w-]+)\)/.exec(themeCss);
  if (token === null) throw new Error('--color-input is aliased to no theme token');
  return { fraction: Number(fraction[1]) / 100, token: token[1]! };
})();

/**
 * Every theme-and-tier combination a reader can put the composer into. `tier` is null for
 * the two untiered defaults; where a tier declares no override for a token, the theme's
 * own value is what renders, which is what `resolve` reproduces.
 */
const COMBINATIONS = [
  { name: 'light, no tier', theme: LIGHT, tier: null },
  { name: 'dark, no tier', theme: DARK, tier: null },
  { name: 'light, contrast-high', theme: LIGHT, tier: 'html.a11y-contrast-high' },
  { name: 'dark, contrast-high', theme: DARK, tier: 'html.a11y-contrast-high.dark' },
  { name: 'light, contrast-increased', theme: LIGHT, tier: 'html.a11y-contrast-increased' },
  { name: 'dark, contrast-increased', theme: DARK, tier: 'html.a11y-contrast-increased.dark' },
  { name: 'light, contrast-low', theme: LIGHT, tier: 'html.a11y-contrast-low' },
  { name: 'dark, contrast-low', theme: DARK, tier: 'html.a11y-contrast-low.dark' },
] as const;

function resolve(theme: string, tier: string | null, variable: string): string {
  const override = tier === null ? null : declaredValue(contrastCss, tier, variable);
  const value = override ?? declaredValue(themeCss, theme, variable);
  if (value === null) throw new Error(`${variable} is declared in neither ${theme} nor its tier`);
  return value;
}

/** The backdrop the predicted words are painted over in a given theme and tier. */
function composerSurface(theme: string, tier: string | null): readonly [number, number, number] {
  const background = resolve(theme, tier, '--background');
  if (theme !== DARK) return parseCssColor(background);
  return parseCssColor(
    mixSrgb(resolve(theme, tier, darkFieldWash.token), background, darkFieldWash.fraction)
  );
}

const cases = COMBINATIONS.map((combination) => ({
  ...combination,
  prediction: resolve(combination.theme, combination.tier, '--prediction'),
  foreground: resolve(combination.theme, combination.tier, '--foreground'),
  composer: composerSurface(combination.theme, combination.tier),
}));

const ratio = (a: string, b: string): number => contrastRatio(parseCssColor(a), parseCssColor(b));

describe('the predicted-text token is declared, not inherited by accident', () => {
  it.each([LIGHT, DARK])('%s declares the token', (theme) => {
    expect(declaredValue(themeCss, theme, '--prediction')).not.toBeNull();
  });

  const tiers = COMBINATIONS.map((c) => c.tier).filter((tier) => tier !== null);

  it.each(tiers)('%s carries its own value for the token', (tier) => {
    expect(declaredValue(contrastCss, tier, '--prediction')).not.toBeNull();
  });

  // Without the @theme alias the custom property resolves to no utility class, so the
  // values above would be unreachable config that no component could name.
  it('the theme block aliases --color-prediction: var(--prediction)', () => {
    expect(themeCss).toContain('--color-prediction: var(--prediction)');
  });
});

/**
 * The untiered themes are the values the design system guarantees, so they carry the
 * AAA floor docs/DESIGN.md holds secondary text to — on all three page surfaces and on
 * the composer field the predicted words actually sit on.
 */
describe('predicted text clears 7:1 in the untiered themes', () => {
  const surfaces = ['--background', '--background-paper', '--background-subtle'] as const;
  const pairings = [LIGHT, DARK].flatMap((theme) => [
    ...surfaces.map((surface) => ({
      theme,
      surface,
      prediction: declaredValue(themeCss, theme, '--prediction')!,
      value: parseCssColor(declaredValue(themeCss, theme, surface)!),
    })),
    {
      theme,
      surface: 'the composer field',
      prediction: declaredValue(themeCss, theme, '--prediction')!,
      value: composerSurface(theme, null),
    },
  ]);

  it.each(pairings)('$theme --prediction on $surface', ({ prediction, value }) => {
    expect(contrastRatio(parseCssColor(prediction), value)).toBeGreaterThanOrEqual(7);
  });
});

/**
 * Predicted words are painted directly on the composer field, so that field is the surface
 * their legibility is decided on in every tier, low included. Predicted text is held to the
 * AA small-text floor there — the same floor the untiered rows already clear at 7:1.
 *
 * The low tier was previously the one accepted exception, signed off at a measured
 * 3.95:1-4.95:1 against a since-removed background wash — a band below AA. Measured against
 * the composer field itself, the low tier clears 4.5:1 with margin, so no exception is needed
 * any more: 4.5:1 is the floor every theme-and-tier combination shares.
 */
describe('predicted text clears 4.5:1 on the composer surface in every tier', () => {
  it.each(cases)('$name', ({ prediction, composer }) => {
    expect(contrastRatio(parseCssColor(prediction), composer)).toBeGreaterThanOrEqual(4.5);
  });
});

/**
 * The failure the pair exists to prevent: predicted text collapsing into typed text once a
 * contrast tier is active. 1.5:1 is the separation the theme already holds --foreground-muted
 * to against --foreground, so a prediction that keeps it reads as a second tier of text
 * rather than as a second primary.
 */
describe('predicted text stays separable from typed text in every tier', () => {
  it.each(cases)('$name', ({ prediction, foreground }) => {
    expect(ratio(prediction, foreground)).toBeGreaterThanOrEqual(1.5);
  });
});

/**
 * With the achromatopsia simulation on, hue carries nothing and the separation above has to
 * come from luminance alone. Both working spaces are checked because the filter's colour
 * space is a browser-side detail this repo does not pin: SVG defaults to linearRGB, and the
 * desaturation controls in the same widget run in sRGB.
 */
describe('the separation survives with no colour vision', () => {
  const spaces = ['srgb', 'linear-rgb'] as const;
  const pairings = cases.flatMap((entry) => spaces.map((space) => ({ ...entry, space })));

  it.each(pairings)('$name under achromatopsia in $space', ({ prediction, foreground, space }) => {
    const grey = (color: string): readonly [number, number, number] =>
      applyColorMatrix(COLORBLIND_MATRICES.achroma, color, space) as [number, number, number];
    expect(contrastRatio(grey(prediction), grey(foreground))).toBeGreaterThanOrEqual(1.5);
  });
});
