import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { TEST_IDS } from '@hushbox/shared';
import { COST_CATEGORY_COLORS } from './cost-category-colors';
import { CostPieChart } from './cost-pie-chart';
import { FeeBreakdown } from './fee-breakdown';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../');
const themeSource = readFileSync(path.join(repoRoot, 'packages/config/tailwind/index.css'), 'utf8');

/**
 * The custom properties declared by one block of the theme stylesheet, read from
 * the stylesheet itself rather than restated here: these assertions are only
 * correct relative to the real token values, and a mirrored copy would drift.
 */
function declarationsIn(blockHeader: string): ReadonlyMap<string, string> {
  const start = themeSource.indexOf(blockHeader);
  if (start === -1) {
    throw new Error(`no ${blockHeader} block in the theme stylesheet`);
  }
  const body = themeSource.slice(start + blockHeader.length);
  const end = body.indexOf('\n}');
  if (end === -1) {
    throw new Error(`unterminated ${blockHeader} block in the theme stylesheet`);
  }
  const declarations = new Map<string, string>();
  for (const [, name, value] of body.slice(0, end).matchAll(/--([\w-]+):\s*([^;]+);/g)) {
    if (name !== undefined && value !== undefined) {
      declarations.set(name, value.trim());
    }
  }
  return declarations;
}

/**
 * Both themes, each as the full set a colour reference resolves through: the
 * `@theme inline` aliases that Tailwind utilities name, over the theme block
 * that gives each alias its value.
 */
const THEMES: readonly (readonly [string, ReadonlyMap<string, string>])[] = [
  ['light', new Map([...declarationsIn(':root {'), ...declarationsIn('@theme inline {')])],
  ['dark', new Map([...declarationsIn('.dark {'), ...declarationsIn('@theme inline {')])],
];

/** A colour reference resolved to the literal the browser would paint. */
function resolve(value: string, tokens: ReadonlyMap<string, string>): string {
  let resolved = value;
  // One substitution per alias hop; the theme's deepest chain is a utility
  // alias onto a theme token, and the bound stops a cyclic stylesheet here
  // rather than hanging the suite.
  for (let hop = 0; hop < 10 && resolved.includes('var('); hop += 1) {
    resolved = resolved.replaceAll(/var\(--([\w-]+)\)/g, (_match, name: string) => {
      const next = tokens.get(name);
      if (next === undefined) {
        throw new Error(`unknown theme token --${name}`);
      }
      return next;
    });
  }
  return resolved;
}

/**
 * The property a colour utility paints with. Tailwind resolves `text-<name>` and
 * `bg-<name>` through the `@theme` colour namespace, so the class a label or a
 * swatch carries and the value a slice fills with meet at this property or
 * nowhere.
 */
function utilityColorReference(utility: string): string {
  return `var(--color-${utility.replace(/^(?:text|bg)-/, '')})`;
}

describe('cost category colors', () => {
  it('gives every category a label class, a swatch class and a fill', () => {
    expect(Object.keys(COST_CATEGORY_COLORS).length).toBeGreaterThan(0);
    for (const { colorClass, swatchClass, fill } of Object.values(COST_CATEGORY_COLORS)) {
      expect(colorClass).toMatch(/^text-/);
      expect(swatchClass).toMatch(/^bg-/);
      expect(fill).toMatch(/^var\(--color-/);
    }
  });

  it('writes the Transaction Costs label in the warning ink', () => {
    expect(COST_CATEGORY_COLORS.transactionCosts.colorClass).toBe('text-warning');
  });

  it.each(THEMES)(
    'writes the Service Value and Platform Fee labels in their slice colour in the %s theme',
    (_name, tokens) => {
      for (const { colorClass, fill } of [
        COST_CATEGORY_COLORS.serviceValue,
        COST_CATEGORY_COLORS.platformFee,
      ]) {
        expect(resolve(utilityColorReference(colorClass), tokens)).toBe(resolve(fill, tokens));
      }
    }
  );

  for (const [category, { colorClass, swatchClass, fill }] of Object.entries(
    COST_CATEGORY_COLORS
  )) {
    describe(category, () => {
      it('renders its breakdown label in the category label colour', () => {
        render(<FeeBreakdown depositAmount={100} />);
        const labelled = screen
          .getByTestId(TEST_IDS.feeBreakdown)
          .querySelectorAll(`[class~="${colorClass}"]`);
        expect(labelled.length).toBe(1);
      });

      it('marks its breakdown label with a swatch in the category colour', () => {
        render(<FeeBreakdown depositAmount={100} />);
        const swatches = screen
          .getByTestId(TEST_IDS.feeBreakdown)
          .querySelectorAll(`[class~="${swatchClass}"]`);
        expect(swatches.length).toBe(1);
      });

      it('fills its ring slice from the category colour', () => {
        render(<CostPieChart depositAmount={100} />);
        const filled = screen
          .getByTestId(TEST_IDS.costPieChart)
          .querySelectorAll(`path[fill="${fill}"]`);
        expect(filled.length).toBe(1);
      });

      it.each(THEMES)(
        'resolves swatch and slice to one colour in the %s theme',
        (_name, tokens) => {
          const swatchColor = resolve(utilityColorReference(swatchClass), tokens);
          expect(swatchColor).toMatch(/^#[0-9a-f]{6}$/i);
          expect(resolve(fill, tokens)).toBe(swatchColor);
        }
      );

      it.each(THEMES)(
        'resolves its label colour to a theme colour in the %s theme',
        (_name, tokens) => {
          expect(resolve(utilityColorReference(colorClass), tokens)).toMatch(/^#[0-9a-f]{6}$/i);
        }
      );
    });
  }
});
