import { describe, expect, it } from 'vitest';
import {
  CHOROPLETH_STEP_CLASSES,
  COHORT_STEP_CLASSES,
  choroplethStep,
  choroplethFillClass,
  cohortShadeClass,
} from './choropleth-scale.js';

describe('choroplethStep', () => {
  it('places a region nothing was counted for outside the scale', () => {
    expect(choroplethStep(undefined, 100)).toBeNull();
  });

  it('gives the largest value the top step', () => {
    expect(choroplethStep(100, 100)).toBe(5);
  });

  it('gives the smallest non-zero value the bottom step', () => {
    expect(choroplethStep(1, 100)).toBe(1);
  });

  it('puts a mid value in a middle step', () => {
    expect(choroplethStep(50, 100)).toBe(3);
  });

  it('keeps a counted zero on the scale rather than treating it as no data', () => {
    expect(choroplethStep(0, 100)).toBe(1);
  });

  it('gives every counted region the top step when they are all equal', () => {
    expect(choroplethStep(7, 7)).toBe(5);
  });

  it('does not divide by zero when nothing was counted anywhere', () => {
    expect(choroplethStep(0, 0)).toBe(1);
  });
});

describe('choroplethFillClass', () => {
  it('offers one class per step of the scale', () => {
    expect(CHOROPLETH_STEP_CLASSES).toHaveLength(5);
  });

  it('shades a region with a step of the shared sequential ramp', () => {
    for (const [index, className] of CHOROPLETH_STEP_CLASSES.entries()) {
      expect(className).toBe(`fill-seq-${String(index + 1)}`);
    }
  });

  it('shades a region by its step', () => {
    expect(choroplethFillClass(5)).toBe(CHOROPLETH_STEP_CLASSES[4]);
  });

  it('gives a region with no data its own unshaded fill', () => {
    expect(choroplethFillClass(null)).not.toBe(CHOROPLETH_STEP_CLASSES[0]);
  });
});

describe('cohortShadeClass', () => {
  it('offers one background class per step of the scale', () => {
    expect(COHORT_STEP_CLASSES).toHaveLength(5);
  });

  it('shades a cell by its step', () => {
    expect(cohortShadeClass(5)).toBe(COHORT_STEP_CLASSES[4]);
  });

  it('leaves a cell with no share unshaded', () => {
    expect(cohortShadeClass(null)).toBe('');
  });

  it('names classes a stylesheet build can see, never ones assembled at runtime', () => {
    for (const [index, className] of COHORT_STEP_CLASSES.entries()) {
      expect(className).toBe(`bg-seq-${String(index + 1)}`);
    }
  });
});

/**
 * The map and the grid read the same magnitudes, so a step means the same thing on
 * both: the two families are one ramp in two utilities, not two scales that happen
 * to have five entries each.
 */
describe('both scales are the one sequential ramp', () => {
  it('puts the same ramp step at the same position in both', () => {
    expect(COHORT_STEP_CLASSES.map((className) => className.replace('bg-', ''))).toStrictEqual(
      CHOROPLETH_STEP_CLASSES.map((className) => className.replace('fill-', ''))
    );
  });

  // An opacity utility fades an element's own text along with its fill, which is
  // what erased the figure a cohort cell prints inside its shading.
  it('shades with the fill alone, never by fading the element', () => {
    for (const className of [...CHOROPLETH_STEP_CLASSES, ...COHORT_STEP_CLASSES]) {
      expect(className).not.toContain('opacity-');
    }
  });
});

describe('scale bounds', () => {
  it('gives a region beyond the top step the unshaded fill rather than an undefined class', () => {
    expect(choroplethFillClass(99)).toBe('fill-muted');
  });

  it('gives a cell beyond the top step no shade rather than an undefined class', () => {
    expect(cohortShadeClass(99)).toBe('');
  });
});
