import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ALL_FEE_CATEGORIES, FEE_BUCKET_BY_ID, FEE_CATEGORIES, TEST_IDS } from '@hushbox/shared';
import { costCategoryShares } from './cost-category-shares';
import { CostPieChart } from './cost-pie-chart';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../');
const THEME_CSS = path.join(repoRoot, 'packages/config/tailwind/index.css');

/**
 * The custom properties one block of the theme stylesheet declares, read from
 * their source of truth rather than restated here: the gap below is only
 * correct relative to the real token values, and a mirrored copy would drift.
 */
function declarationsIn(blockHeader: string): Map<string, string> {
  const source = readFileSync(THEME_CSS, 'utf8');
  const start = source.indexOf(blockHeader);
  if (start === -1) {
    throw new Error(`no ${blockHeader} block in ${THEME_CSS}`);
  }
  const body = source.slice(start + blockHeader.length);
  const tokens = new Map<string, string>();
  for (const [, name, value] of body
    .slice(0, body.indexOf('\n}'))
    .matchAll(/--([\w-]+):\s*([^;]+);/g)) {
    if (name !== undefined && value !== undefined) {
      tokens.set(name, value.trim());
    }
  }
  return tokens;
}

const LIGHT_TOKENS: ReadonlyMap<string, string> = new Map([
  ...declarationsIn(':root {'),
  ...declarationsIn('@theme inline {'),
]);

function resolveCssVariables(value: string, tokens: ReadonlyMap<string, string>): string {
  let resolved = value;
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

function expectedSliceCount(): number {
  // Service Value is always rendered. Transaction Costs and Platform Fee
  // are rendered only if they contain at least one non-zero fee category.
  let count = 1;
  if (FEE_CATEGORIES.some((c) => FEE_BUCKET_BY_ID[c.id] === 'transaction-costs')) {
    count += 1;
  }
  if (FEE_CATEGORIES.some((c) => FEE_BUCKET_BY_ID[c.id] === 'platform-fee')) {
    count += 1;
  }
  return count;
}

describe('CostPieChart', () => {
  describe('rendering', () => {
    it('renders with data-testid cost-pie-chart', () => {
      render(<CostPieChart depositAmount={100} />);
      expect(screen.getByTestId(TEST_IDS.costPieChart)).toBeInTheDocument();
    });

    it('refuses a zero deposit, which has no shares to draw', () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(() => render(<CostPieChart depositAmount={0} />)).toThrow(RangeError);
      consoleError.mockRestore();
    });

    it('centres the ring on both axes, so a taller grid cell cannot stretch it out of square', () => {
      render(<CostPieChart depositAmount={100} />);
      expect(screen.getByTestId(TEST_IDS.costPieChart)).toHaveClass(
        'flex',
        'items-center',
        'justify-center'
      );
    });

    it("lets its column shrink below the ring's default width", () => {
      render(<CostPieChart depositAmount={100} />);
      expect(screen.getByTestId(TEST_IDS.costPieChart)).toHaveClass('min-w-0');
    });

    it('renders an SVG element', () => {
      render(<CostPieChart depositAmount={100} />);
      const container = screen.getByTestId(TEST_IDS.costPieChart);
      expect(container.querySelector('svg')).toBeInTheDocument();
    });

    it('does NOT render legend text', () => {
      render(<CostPieChart depositAmount={100} />);
      expect(screen.queryByText('Model usage')).not.toBeInTheDocument();
      expect(screen.queryByText('Storage')).not.toBeInTheDocument();
      expect(screen.queryByText('HushBox profit')).not.toBeInTheDocument();
      expect(screen.queryByText('AI provider overhead')).not.toBeInTheDocument();
      expect(screen.queryByText('Credit card processing')).not.toBeInTheDocument();
    });

    it('writes the Service Value label in the centre of the ring', () => {
      render(<CostPieChart depositAmount={100} />);
      const texts = [...screen.getByTestId(TEST_IDS.costPieChart).querySelectorAll('svg text')];
      expect(texts.map((text) => text.textContent)).toEqual([
        costCategoryShares(100).serviceValue.approximateLabel,
        'Service Value',
      ]);
    });

    it('writes the centre text in the forced-colours text colour', () => {
      render(<CostPieChart depositAmount={100} />);
      const texts = screen.getByTestId(TEST_IDS.costPieChart).querySelectorAll('svg text');
      expect(texts.length).toBe(2);
      for (const text of texts) {
        expect(text).toHaveClass('forced-colors:fill-[CanvasText]');
      }
    });

    it('does NOT render a dollar amount', () => {
      render(<CostPieChart depositAmount={100} />);
      expect(screen.getByTestId(TEST_IDS.costPieChart)).not.toHaveTextContent(/\$/);
    });

    it('is one image named by every category and its rounded share', () => {
      render(<CostPieChart depositAmount={10} />);
      expect(
        screen.getByRole('img', {
          name: 'Service Value about 85%, Transaction Costs about 10%, Platform Fee about 5%',
        })
      ).toBeInTheDocument();
    });

    it('names each category with the rounded share the breakdown prints', () => {
      render(<CostPieChart depositAmount={100} />);
      const expected = costCategoryShares(100)
        .categories.map(
          (category) => `${category.name} about ${String(category.roundedPercentage)}%`
        )
        .join(', ');
      expect(screen.getByRole('img', { name: expected })).toBeInTheDocument();
    });
  });

  describe('pie slices', () => {
    it('renders one path per non-empty category group', () => {
      render(<CostPieChart depositAmount={100} />);
      const container = screen.getByTestId(TEST_IDS.costPieChart);
      const paths = container.querySelectorAll('path');
      expect(paths.length).toBe(expectedSliceCount());
    });

    it('renders the Service Value slice (blue) at all rate values', () => {
      render(<CostPieChart depositAmount={100} />);
      const container = screen.getByTestId(TEST_IDS.costPieChart);
      const slice = container.querySelector(`[data-testid="${TEST_IDS.sliceServiceValue}"]`);
      expect(slice).toBeInTheDocument();
      expect(slice).toHaveAttribute('fill', 'var(--color-chart-2)');
    });

    it('renders the Transaction Costs slice (amber) iff at least one transaction fee has rate > 0', () => {
      render(<CostPieChart depositAmount={100} />);
      const container = screen.getByTestId(TEST_IDS.costPieChart);
      const slice = container.querySelector(`[data-testid="${TEST_IDS.sliceTransactionCosts}"]`);
      const hasTransactionCosts = FEE_CATEGORIES.some(
        (c) => FEE_BUCKET_BY_ID[c.id] === 'transaction-costs'
      );
      if (hasTransactionCosts) {
        expect(slice).toBeInTheDocument();
        expect(slice).toHaveAttribute('fill', 'var(--color-chart-4)');
      } else {
        expect(slice).not.toBeInTheDocument();
      }
    });

    it('renders the Platform Fee slice (brand red) iff the hushbox fee has rate > 0', () => {
      render(<CostPieChart depositAmount={100} />);
      const container = screen.getByTestId(TEST_IDS.costPieChart);
      const slice = container.querySelector(`[data-testid="${TEST_IDS.slicePlatformFee}"]`);
      const hasPlatformFee = FEE_CATEGORIES.some((c) => FEE_BUCKET_BY_ID[c.id] === 'platform-fee');
      if (hasPlatformFee) {
        expect(slice).toBeInTheDocument();
        expect(slice).toHaveAttribute('fill', 'var(--color-brand-red)');
      } else {
        expect(slice).not.toBeInTheDocument();
      }
    });

    it('does not render a slice for any zero-rate fee category bucket', () => {
      render(<CostPieChart depositAmount={100} />);
      const container = screen.getByTestId(TEST_IDS.costPieChart);
      const allTransactionRatesZero = ALL_FEE_CATEGORIES.filter(
        (c) => FEE_BUCKET_BY_ID[c.id] === 'transaction-costs'
      ).every((c) => c.rate === 0);
      const allPlatformRatesZero = ALL_FEE_CATEGORIES.filter(
        (c) => FEE_BUCKET_BY_ID[c.id] === 'platform-fee'
      ).every((c) => c.rate === 0);
      if (allTransactionRatesZero) {
        expect(
          container.querySelector(`[data-testid="${TEST_IDS.sliceTransactionCosts}"]`)
        ).not.toBeInTheDocument();
      }
      if (allPlatformRatesZero) {
        expect(
          container.querySelector(`[data-testid="${TEST_IDS.slicePlatformFee}"]`)
        ).not.toBeInTheDocument();
      }
    });
  });

  describe('annulus paths', () => {
    /**
     * The `d` of every rendered slice, as the whitespace-separated tokens the
     * ring joins: `M x y A R R 0 large 1 x y L x y A r r 0 large 0 x y Z`, the
     * outer arc's two ends, then the inner arc's.
     */
    function sliceCommands(): string[][] {
      const container = screen.getByTestId(TEST_IDS.costPieChart);
      const paths = [...container.querySelectorAll('path')];
      expect(paths.length).toBe(expectedSliceCount());
      return paths.map((path) => (path.getAttribute('d') ?? '').split(' '));
    }

    /** The ring's centre, the middle of the SVG's own viewBox. */
    function ringCentre(): readonly [number, number] {
      const viewBox = screen
        .getByTestId(TEST_IDS.costPieChart)
        .querySelector('svg')
        ?.getAttribute('viewBox')
        ?.split(' ')
        .map(Number);
      const [minX = Number.NaN, minY = Number.NaN, width = Number.NaN, height = Number.NaN] =
        viewBox ?? [];
      return [minX + width / 2, minY + height / 2];
    }

    const COMMANDS = new Set(['M', 'L', 'A', 'Z']);

    it('draws each slice as an outer arc joined to an inner arc', () => {
      render(<CostPieChart depositAmount={100} />);
      for (const tokens of sliceCommands()) {
        expect(tokens.filter((token) => COMMANDS.has(token))).toEqual(['M', 'A', 'L', 'A', 'Z']);
        const outerRadius = Number(tokens[4]);
        const innerRadius = Number(tokens[15]);
        expect(innerRadius).toBeGreaterThan(0);
        expect(innerRadius).toBeLessThan(outerRadius);
      }
    });

    it('sweeps the whole ring across its slices', () => {
      render(<CostPieChart depositAmount={100} />);
      const [cx, cy] = ringCentre();
      const angleOf = (x: number, y: number): number =>
        (Math.atan2(y - cy, x - cx) * 180) / Math.PI;
      let swept = 0;
      for (const tokens of sliceCommands()) {
        const at = (index: number): number => Number(tokens[index]);
        const start = angleOf(at(1), at(2));
        const end = angleOf(at(9), at(10));
        swept += (((end - start) % 360) + 360) % 360;
      }
      expect(swept).toBeCloseTo(360, 4);
    });

    it('carries no coordinate with more than six decimal places', () => {
      // Six places is the agreement margin: the coordinate space is 200 units
      // wide rendered at 240 pixels, so a sixth-place difference is under a
      // millionth of a pixel, while the last-place disagreement between
      // engines' Math.cos sits far below that and must not reach the attribute.
      for (const deposit of [10, 100, 0.37]) {
        const view = render(<CostPieChart depositAmount={deposit} />);
        for (const tokens of sliceCommands()) {
          for (const token of tokens.filter((t) => !COMMANDS.has(t))) {
            expect(token, `deposit ${String(deposit)}: ${tokens.join(' ')}`).toMatch(
              /^-?\d+(?:\.\d{1,6})?$/
            );
          }
        }
        view.unmount();
      }
    });

    it('keeps every arc endpoint on the radius its own arc declares', () => {
      render(<CostPieChart depositAmount={10} />);
      const [cx, cy] = ringCentre();
      for (const tokens of sliceCommands()) {
        // A token that is not where the path shape above expects it reads as
        // NaN and fails the assertion.
        const at = (index: number): number => Number(tokens[index]);
        const outerRadius = at(4);
        const innerRadius = at(15);
        const endpoints: readonly (readonly [number, number, number])[] = [
          [at(1), at(2), outerRadius],
          [at(9), at(10), outerRadius],
          [at(12), at(13), innerRadius],
          [at(20), at(21), innerRadius],
        ];
        for (const [x, y, radius] of endpoints) {
          // Rounding each axis to six places moves a point by at most 5e-7 per
          // axis, so the radius by at most sqrt(2) times that — inside this
          // tolerance with room to spare, while a coarser rounding is not.
          expect(Math.hypot(x - cx, y - cy)).toBeCloseTo(radius, 5);
        }
      }
    });
  });

  describe('slice gaps', () => {
    it('paints the gap between slices from the inherited --cost-ring-gap', () => {
      render(<CostPieChart depositAmount={100} />);
      const strokes = [...screen.getByTestId(TEST_IDS.costPieChart).querySelectorAll('path')].map(
        (path) => path.getAttribute('stroke')
      );
      expect(strokes.length).toBe(expectedSliceCount());
      for (const stroke of strokes) {
        expect(stroke).toMatch(/^var\(--cost-ring-gap,/);
      }
    });

    it('paints the gaps in the forced-colours canvas', () => {
      render(<CostPieChart depositAmount={100} />);
      for (const path of screen.getByTestId(TEST_IDS.costPieChart).querySelectorAll('path')) {
        expect(path).toHaveClass('forced-colors:stroke-[Canvas]');
      }
    });

    it('falls back to the card surface when no ancestor sets --cost-ring-gap', () => {
      render(<CostPieChart depositAmount={100} />);
      for (const path of screen.getByTestId(TEST_IDS.costPieChart).querySelectorAll('path')) {
        const fallback = /^var\(--cost-ring-gap, (.+)\)$/.exec(
          path.getAttribute('stroke') ?? ''
        )?.[1];
        expect(resolveCssVariables(fallback ?? '', LIGHT_TOKENS)).toBe(
          LIGHT_TOKENS.get('background-paper')
        );
      }
    });
  });

  describe('storage', () => {
    it('keeps the Service Value slice when storage alone exceeds the deposit', () => {
      // Storage is inside Service Value, so a storage cost larger than the
      // deposit drives model usage negative without emptying the slice.
      render(<CostPieChart depositAmount={1} estimatedCharacters={10_000_000} />);
      const container = screen.getByTestId(TEST_IDS.costPieChart);
      expect(
        container.querySelector(`[data-testid="${TEST_IDS.sliceServiceValue}"]`)
      ).toBeInTheDocument();
    });
  });
});
