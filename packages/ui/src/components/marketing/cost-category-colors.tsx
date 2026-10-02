import type { CostCategoryId } from './cost-category-shares';

/**
 * The colour each cost category carries. The breakdown's swatches and the
 * ring's slices read it here so they cannot disagree: the swatch class and the
 * fill are two spellings of one theme token, held to the same resolved value by
 * the colocated test. A label is written in its slice colour, except where that
 * colour is too light for text: Transaction Costs' amber reads in the warning ink.
 *
 * The module is `.tsx` though it renders nothing. Tailwind's source globs for
 * `packages/ui/src` match only `.tsx`, so a class name written in a `.ts` file
 * here reaches no stylesheet and the label loses its colour.
 */
export interface CostCategoryColor {
  /** The utility the breakdown's category label carries. */
  readonly colorClass: string;
  /** The utility the square beside the label carries. */
  readonly swatchClass: string;
  /** The paint the ring's slice fills with. */
  readonly fill: string;
}

export const COST_CATEGORY_COLORS = {
  serviceValue: {
    colorClass: 'text-chart-2',
    swatchClass: 'bg-chart-2',
    fill: 'var(--color-chart-2)',
  },
  transactionCosts: {
    colorClass: 'text-warning',
    swatchClass: 'bg-chart-4',
    fill: 'var(--color-chart-4)',
  },
  platformFee: {
    colorClass: 'text-brand-red',
    swatchClass: 'bg-brand-red',
    fill: 'var(--color-brand-red)',
  },
} as const satisfies Record<CostCategoryId, CostCategoryColor>;
