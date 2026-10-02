import * as React from 'react';
import { TEST_IDS } from '@hushbox/shared';

import { COST_CATEGORY_COLORS } from './cost-category-colors';
import { costCategoryShares, type CostCategoryId } from './cost-category-shares';

interface CostPieChartProps {
  /** The deposit amount in USD */
  depositAmount: number;
  /** Estimated characters used (for storage fee calculation) */
  estimatedCharacters?: number | undefined;
}

const SLICE_TEST_IDS: Record<CostCategoryId, string> = {
  serviceValue: TEST_IDS.sliceServiceValue,
  transactionCosts: TEST_IDS.sliceTransactionCosts,
  platformFee: TEST_IDS.slicePlatformFee,
};

const CENTRE = 100;
const OUTER_RADIUS = 88;
const INNER_RADIUS = 56;

/**
 * The paint between slices. A surface sets `--cost-ring-gap` to its own
 * background so the gaps read as cuts through the ring; with none set they take
 * the card surface the ring usually sits on.
 */
const GAP_STROKE = 'var(--cost-ring-gap, var(--color-background-paper))';

/**
 * `Math.cos` and `Math.sin` are not required to be correctly rounded, so their
 * results differ by a last-place unit between Node — which renders this page's
 * markup — and some browser engines, which is enough for hydration to report
 * the arc attribute as a mismatch. Rounding lands both sides on the same
 * double: multiplication, division and `Math.round` are each exactly specified,
 * so every engine agrees on the result. Six places is free — the chart's
 * coordinate space is 200 units wide rendered at 240 pixels, so this displaces
 * a point by under a millionth of a pixel.
 */
function agreedCoordinate(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** The point at `radius` from the centre, `angleInDegrees` clockwise from the top. */
function polarPoint(radius: number, angleInDegrees: number): readonly [number, number] {
  const angleInRadians = ((angleInDegrees - 90) * Math.PI) / 180;
  return [
    agreedCoordinate(CENTRE + radius * Math.cos(angleInRadians)),
    agreedCoordinate(CENTRE + radius * Math.sin(angleInRadians)),
  ];
}

/** One slice of the ring: clockwise along the outer edge, back along the inner. */
function annulusSlice(startAngle: number, endAngle: number): string {
  const largeArcFlag = endAngle - startAngle > 180 ? 1 : 0;
  return [
    'M',
    ...polarPoint(OUTER_RADIUS, startAngle),
    'A',
    OUTER_RADIUS,
    OUTER_RADIUS,
    0,
    largeArcFlag,
    1,
    ...polarPoint(OUTER_RADIUS, endAngle),
    'L',
    ...polarPoint(INNER_RADIUS, endAngle),
    'A',
    INNER_RADIUS,
    INNER_RADIUS,
    0,
    largeArcFlag,
    0,
    ...polarPoint(INNER_RADIUS, startAngle),
    'Z',
  ].join(' ');
}

export function CostPieChart({
  depositAmount,
  estimatedCharacters,
}: Readonly<CostPieChartProps>): React.JSX.Element {
  const { serviceValue, categories } = costCategoryShares(depositAmount, estimatedCharacters);
  const total = categories.reduce((sum, category) => sum + category.percentage, 0);
  const name = categories
    .map((category) => `${category.name} about ${String(category.roundedPercentage)}%`)
    .join(', ');

  const slices = categories.map((category, index) => {
    const before = categories.slice(0, index).reduce((sum, c) => sum + c.percentage, 0);
    return {
      category,
      startAngle: (before / total) * 360,
      endAngle: ((before + category.percentage) / total) * 360,
    };
  });

  return (
    <div data-testid={TEST_IDS.costPieChart} className="flex min-w-0 items-center justify-center">
      <svg
        viewBox="0 0 200 200"
        role="img"
        aria-label={name}
        className="aspect-square w-60 max-w-full"
      >
        {slices.map(({ category, startAngle, endAngle }) => (
          <path
            key={category.id}
            data-testid={SLICE_TEST_IDS[category.id]}
            d={annulusSlice(startAngle, endAngle)}
            fill={COST_CATEGORY_COLORS[category.id].fill}
            stroke={GAP_STROKE}
            strokeWidth="3"
            strokeLinejoin="round"
            className="forced-colors:stroke-[Canvas]"
          />
        ))}
        <text
          x={CENTRE}
          y="104"
          textAnchor="middle"
          fill={COST_CATEGORY_COLORS.serviceValue.fill}
          className="font-serif text-[26px] font-bold forced-colors:fill-[CanvasText]"
        >
          {serviceValue.approximateLabel}
        </text>
        <text
          x={CENTRE}
          y="124"
          textAnchor="middle"
          className="fill-muted-foreground text-[11px] font-medium forced-colors:fill-[CanvasText]"
        >
          {serviceValue.name}
        </text>
      </svg>
    </div>
  );
}
