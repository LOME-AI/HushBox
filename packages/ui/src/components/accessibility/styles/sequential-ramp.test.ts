import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { contrastRatio, parseCssColor, relativeLuminance } from '@hushbox/shared/color/contrast';

import { declaredValue } from './css-declarations';
import { readThemeColor } from '../../cipher-wall/use-cipher-wall';

/**
 * `--seq-1`…`--seq-5` are the repository's one continuous scale for magnitude: a
 * shade a reader ranks against its neighbours, where `--chart-1`…`--chart-5` are
 * hues a reader tells apart. The two are not interchangeable, which is what a
 * scale built out of opacity steps on a chart token loses — the step fades the
 * figure printed on it along with the fill behind it.
 *
 * The ramp is therefore held to what makes it readable as a ranking: a strict
 * luminance order running away from the card, so a heavier figure never reads
 * lighter than a smaller one, and the body ink clearing the small-text floor on
 * every step, because a cohort cell prints its count inside its own shading.
 * Every ratio here is computed from the value the stylesheet declares rather than
 * compared against a remembered number, so a retuned ramp is measured instead of
 * re-approved.
 */

const stylesDir = path.dirname(fileURLToPath(import.meta.url));
const themeCss = readFileSync(
  path.join(stylesDir, '../../../../../config/tailwind/index.css'),
  'utf8'
);

/**
 * The step tokens as literals rather than assembled from an index: they stand in
 * the reader's own token union below, which only a literal is checked against.
 */
const STEP_TOKENS = ['--seq-1', '--seq-2', '--seq-3', '--seq-4', '--seq-5'] as const;

const LIGHT = ':root';
const DARK = '.dark';

/** The block whose declarations Tailwind turns into utility classes. */
const THEME_BLOCK = '@theme inline';

/** The two untiered themes; the card is the surface a panel's shading is drawn on. */
const THEMES = [
  { name: 'light', selector: LIGHT },
  { name: 'dark', selector: DARK },
] as const;

/** A token's declared value in a theme, or a failure naming the token. */
function themeValue(selector: string, variable: string): string {
  const value = declaredValue(themeCss, selector, variable);
  if (value === null) throw new Error(`${variable} is not declared in ${selector}`);
  return value;
}

const LITERAL_HEX = /^#[0-9a-f]{6}$/;

const AA = 4.5;

const ratio = (a: string, b: string): number => contrastRatio(parseCssColor(a), parseCssColor(b));
const luminance = (color: string): number => relativeLuminance(parseCssColor(color));

describe('the sequential ramp is declared in both themes and reachable as utilities', () => {
  const declarations = THEMES.flatMap((theme) =>
    STEP_TOKENS.map((token) => ({ theme: theme.name, selector: theme.selector, token }))
  );

  it.each(declarations)('$theme declares $token as a literal', ({ selector, token }) => {
    expect(declaredValue(themeCss, selector, token)).toMatch(LITERAL_HEX);
  });

  // Without the @theme alias the custom property names no utility class, so the
  // ramp would be unreachable config no component could shade a cell with. The
  // read is scoped to that block: the same declaration anywhere else in the
  // stylesheet generates nothing, so a whole-file search would pass on a ramp no
  // utility reaches.
  it.each(STEP_TOKENS)('the theme block aliases a colour onto %s', (token) => {
    const alias = `--color-seq-${token.slice('--seq-'.length)}`;
    expect(declaredValue(themeCss, THEME_BLOCK, alias)).toBe(`var(${token})`);
  });
});

describe('the ramp reads as a ranking in both themes', () => {
  it.each(THEMES)('$name orders its steps strictly by luminance', ({ selector }) => {
    const luminances = STEP_TOKENS.map((token) => luminance(themeValue(selector, token)));
    const ascending = luminances.toSorted((a, b) => a - b);
    const monotonic =
      luminances.every((value, index) => value === ascending[index]) ||
      luminances.every((value, index) => value === ascending[luminances.length - 1 - index]);
    expect(new Set(luminances).size).toBe(STEP_TOKENS.length);
    expect(monotonic).toBe(true);
  });

  // Luminance order alone is satisfied by a ramp running the wrong way: the steps
  // have to move away from the card they are drawn on, so more of a thing is always
  // more ink on the page and never less.
  it.each(THEMES)('$name moves every step further off the card', ({ selector }) => {
    const card = themeValue(selector, '--background-paper');
    const distances = STEP_TOKENS.map((token) => ratio(themeValue(selector, token), card));
    for (const [index, distance] of distances.entries()) {
      if (index > 0) expect(distance).toBeGreaterThan(distances[index - 1]!);
    }
  });
});

/**
 * The ramp's own text partner, and why the ink printed inside a shaded cell is
 * not the page's body ink: a contrast tier restates `--foreground` and the ramp
 * joins no tier derivation, so under the softened tier the two would close on
 * each other at the deep steps. A fill's text partner follows its fill instead,
 * which is the reading of the accessibility floor the repository already applies
 * to `--secondary-foreground` and its siblings.
 */
const PARTNER_INK = '--seq-foreground';

describe('the ramp carries its own text partner', () => {
  it.each(THEMES)('$name declares the partner ink as a literal', ({ selector }) => {
    expect(declaredValue(themeCss, selector, PARTNER_INK)).toMatch(LITERAL_HEX);
  });

  // Without the alias the partner ink names no utility class, so the one surface
  // that prints a figure on the ramp could not set its text in it.
  it('the theme block aliases a colour onto the partner ink', () => {
    expect(declaredValue(themeCss, THEME_BLOCK, '--color-seq-foreground')).toBe(
      `var(${PARTNER_INK})`
    );
  });

  const partnerPairings = THEMES.flatMap((theme) =>
    STEP_TOKENS.map((token) => ({
      theme: theme.name,
      token,
      ink: themeValue(theme.selector, PARTNER_INK),
      step: themeValue(theme.selector, token),
    }))
  );

  it.each(partnerPairings)('$theme: the partner ink on $token', ({ ink, step }) => {
    expect(ratio(ink, step)).toBeGreaterThanOrEqual(AA);
  });
});

describe('the body ink clears the small-text floor on every step', () => {
  const pairings = THEMES.flatMap((theme) =>
    STEP_TOKENS.map((token) => ({
      theme: theme.name,
      token,
      ink: themeValue(theme.selector, '--foreground'),
      step: themeValue(theme.selector, token),
    }))
  );

  it.each(pairings)('$theme: --foreground on $token', ({ ink, step }) => {
    expect(ratio(ink, step)).toBeGreaterThanOrEqual(AA);
  });
});

/**
 * A canvas paints outside the cascade, so it takes the ramp through the one reader
 * of the theme rather than a second copy of the values.
 */
describe('the canvas reader resolves a ramp step', () => {
  it.each(STEP_TOKENS)('reads %s off the scope it is given', (token) => {
    const scope = document.createElement('div');
    scope.style.setProperty(token, '#123456');
    document.body.append(scope);
    expect(readThemeColor(token, scope)).toBe('#123456');
    scope.remove();
  });
});
