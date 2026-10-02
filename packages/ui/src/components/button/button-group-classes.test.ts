import { describe, it, expect } from 'vitest';
import { buttonVariants, type ButtonSize } from './button-classes';
import { buttonLabelsRowClass, buttonRowClass, buttonStackClass } from './button-group-classes';

// Every size, held complete by the compiler: a new `ButtonSize` without an entry fails to build.
const SIZES = {
  sm: true,
  default: true,
  lg: true,
  xl: true,
} as const satisfies Record<ButtonSize, true>;

/** The accessibility widget's smallest text on a 16px root, where the border weighs most in rem. */
const SMALLEST_ROOT_PX = 14;
/** The drawn button's 1px border, on both sides. */
const BORDER_PX = 2;

/** Every member flex-basis floor the row classes set, in rem. */
function basisFloorsRem(classes: string): number[] {
  return [...classes.matchAll(/(?:flex-\[1_1_|basis-\[)max\(([\d.]+)rem,/g)].map((match) =>
    Number(match[1])
  );
}

/** A size's widest inline padding on both sides, in rem, whichever state sets it. */
function inlinePaddingRem(size: ButtonSize): number {
  const steps = buttonVariants({ size })
    .split(' ')
    .flatMap((token) => {
      const step = /^(?:.+:)?px-([\d.]+)$/.exec(token)?.[1];
      return step === undefined ? [] : [Number(step)];
    });
  return 2 * 0.25 * Math.max(0, ...steps);
}

describe('the button row classes', () => {
  it('floor every member basis at one value in both rows', () => {
    const floors = [...basisFloorsRem(buttonRowClass), ...basisFloorsRem(buttonLabelsRowClass)];

    expect(floors.length).toBeGreaterThanOrEqual(4);
    expect(new Set(floors).size).toBe(1);
  });

  it.each(Object.keys(SIZES) as ButtonSize[])(
    "floor the basis above a %s button's inline padding and border",
    (size) => {
      const [floor = 0] = basisFloorsRem(buttonRowClass);

      expect(floor * SMALLEST_ROOT_PX).toBeGreaterThan(
        inlinePaddingRem(size) * SMALLEST_ROOT_PX + BORDER_PX
      );
    }
  );
});

describe('the button group switches', () => {
  it('scale every threshold difference by one factor that keeps them within layout range', () => {
    const factors = [buttonRowClass, buttonLabelsRowClass, buttonStackClass].flatMap((classes) =>
      [...classes.matchAll(/_\*_(1e\d+)\)/g)].map((match) => match[1])
    );

    expect(factors.length).toBeGreaterThanOrEqual(6);
    expect(new Set(factors)).toEqual(new Set(['1e4']));
  });
});
