/**
 * The five shading steps, as classes rather than fills. A `fill` written into
 * the style attribute is a colour the accessibility widget's contrast overrides
 * cannot reach, so the scale is expressed as utility classes over the shared
 * sequential ramp (`--seq-1`…`--seq-5`) throughout.
 */
export const CHOROPLETH_STEP_CLASSES = [
  'fill-seq-1',
  'fill-seq-2',
  'fill-seq-3',
  'fill-seq-4',
  'fill-seq-5',
] as const;

/** A region no row was returned for: absent from the data, not a low count. */
const NO_DATA_CLASS = 'fill-muted';

const STEPS = CHOROPLETH_STEP_CLASSES.length;

/**
 * Which shading step a region's figure falls in, or null when there is no
 * figure for it at all. The two are kept apart deliberately: an unshaded region
 * means nothing was counted there, which the map must not draw as the palest
 * shade of "a few".
 */
export function choroplethStep(value: number | undefined, largest: number): number | null {
  if (value === undefined) return null;
  if (largest <= 0) return 1;
  return Math.max(1, Math.ceil((value / largest) * STEPS));
}

/** The class shading a region at the given step. */
export function choroplethFillClass(step: number | null): string {
  if (step === null) return NO_DATA_CLASS;
  return CHOROPLETH_STEP_CLASSES[step - 1] ?? NO_DATA_CLASS;
}

/**
 * The same five steps as background fills, for the cohort grid's cells. Written
 * out rather than derived from the fill classes above: a stylesheet build scans
 * source for literal class names, so a class assembled at runtime would name CSS
 * that was never generated.
 *
 * A cohort cell prints its count and its share inside the shading, which is why
 * the ramp carries the shade rather than an opacity utility on the cell: opacity
 * fades an element's text along with its background and so erases the figure the
 * shading is a second encoding of. The ramp's steps are held to that figure's
 * contrast floor in both themes
 * (`packages/ui/src/components/accessibility/styles/sequential-ramp.test.ts`), so
 * the scale runs to its full strength here as it does on the map.
 */
export const COHORT_STEP_CLASSES = [
  'bg-seq-1',
  'bg-seq-2',
  'bg-seq-3',
  'bg-seq-4',
  'bg-seq-5',
] as const;

/** The class shading a cohort cell at the given step; unshaded where there is no share. */
export function cohortShadeClass(step: number | null): string {
  if (step === null) return '';
  return COHORT_STEP_CLASSES[step - 1] ?? '';
}
