import { describe, it, expect } from 'vitest';
import { buttonVariants, type ButtonSize, type DrawnVariant } from './button-classes';
import { buttonLabelsRowClass, buttonRowClass, buttonStackClass } from './button-group-classes';

const BOXED: readonly Exclude<DrawnVariant, 'link'>[] = [
  'default',
  'secondary',
  'outline',
  'ghost',
  'destructive',
];

function classesOf(variant: DrawnVariant, size: ButtonSize = 'default'): string[] {
  return buttonVariants({ variant, size }).split(' ');
}

describe('a block button, or a button in a row that wraps its labels, whose label does not fit its space', () => {
  it.each([...BOXED, 'link'] as const)('lets the label of a %s block button wrap', (variant) => {
    expect(classesOf(variant)).toContain(
      '[&:is([data-block],[data-wrap-labels]_*)]:whitespace-normal'
    );
  });

  it.each([...BOXED, 'link'] as const)(
    'centres the wrapped lines of a %s block button',
    (variant) => {
      expect(classesOf(variant)).toContain('[&:is([data-block],[data-wrap-labels]_*)]:text-center');
    }
  );

  it.each([...BOXED, 'link'] as const)(
    'breaks a word no line of a %s block button can hold',
    (variant) => {
      expect(classesOf(variant)).toContain(
        '[&:is([data-block],[data-wrap-labels]_*)]:wrap-anywhere'
      );
    }
  );

  it('keeps the label of a button that is not a block on one line', () => {
    const classes = classesOf('default');

    expect(classes).toContain('whitespace-nowrap');
    expect(classes).not.toContain('whitespace-normal');
  });
});

describe('the height of a block button, or of a button in a row that wraps its labels', () => {
  it.each([
    ['sm', '[&:is([data-block],[data-wrap-labels]_*)]:min-h-8'],
    ['default', '[&:is([data-block],[data-wrap-labels]_*)]:min-h-9'],
    ['lg', '[&:is([data-block],[data-wrap-labels]_*)]:min-h-10'],
    ['xl', '[&:is([data-block],[data-wrap-labels]_*)]:min-h-14'],
  ] as const)('holds a %s block button to its size height as a floor', (size, floor) => {
    for (const variant of BOXED) {
      expect(classesOf(variant, size)).toEqual(
        expect.arrayContaining(['[&:is([data-block],[data-wrap-labels]_*)]:h-auto', floor])
      );
    }
  });

  it.each([
    ['sm', '[&:is([data-block],[data-wrap-labels]_*)]:py-1'],
    ['default', '[&:is([data-block],[data-wrap-labels]_*)]:py-1.5'],
    ['lg', '[&:is([data-block],[data-wrap-labels]_*)]:py-2'],
    ['xl', '[&:is([data-block],[data-wrap-labels]_*)]:py-3'],
  ] as const)(
    'pads a %s block button no more than a one-line label leaves inside its floor',
    (size, padding) => {
      expect(classesOf('default', size)).toContain(padding);
    }
  );

  it.each(['sm', 'default', 'lg'] as const)(
    'keeps the touch floor of a %s block button on a coarse pointer',
    (size) => {
      expect(classesOf('default', size)).toContain(
        '[&:is([data-block],[data-wrap-labels]_*)]:pointer-coarse:min-h-11'
      );
    }
  );

  it('leaves an xl block button its own floor on a coarse pointer, which is above the touch floor', () => {
    expect(classesOf('default', 'xl')).not.toContain(
      '[&:is([data-block],[data-wrap-labels]_*)]:pointer-coarse:min-h-11'
    );
  });

  it.each(['sm', 'default', 'lg', 'xl'] as const)(
    'leaves a %s link block button the height of its text',
    (size) => {
      const blockHeight = classesOf('link', size).filter((token) =>
        /^\[&:is\(\[data-block\],\[data-wrap-labels\]_\*\)\]:(?:pointer-coarse:)?(?:h|min-h|py)-/.test(
          token
        )
      );

      expect(blockHeight).toEqual([]);
    }
  );
});

describe('the width of a block button', () => {
  it("takes no width rule from the mark that wraps a group's labels", () => {
    const width = classesOf('default').filter((token) =>
      /(?:^|:)(?:w|max-w|min-w|mx)-/.test(token)
    );

    expect(width.filter((token) => token.includes('[data-wrap-labels]_*'))).toEqual([]);
  });

  it('keeps every block width rule on the block mark', () => {
    const width = classesOf('default').filter(
      (token) => /(?:^|:)(?:w|max-w|min-w|mx)-/.test(token) && token.includes('data-block')
    );

    expect(width.every((token) => token.startsWith('data-block:'))).toBe(true);
  });
});

describe('a button that shares a row with other labelled buttons', () => {
  const SHARED_FLOOR =
    '[[data-wrap-labels=shared]>&:not([data-slot=icon-button])]:min-w-[min(100%,max(12rem,var(--btn-eq,0px),100%_+_(40rem_-_100%)_*_1e4),max(var(--btn-eq,0px),(var(--btn-count,1)_*_var(--btn-eq,0px)_+_(var(--btn-count,1)_-_1)_*_0.5rem_-_100%)_*_1e4))]';
  const WIDE_STACK_MARGIN =
    '[[data-wrap-labels=shared]>&:not([data-slot=icon-button])]:mx-[max(0px,min((100%_-_max(12rem,var(--btn-eq,0px)))_/_2,(var(--btn-count,1)_*_var(--btn-eq,0px)_+_(var(--btn-count,1)_-_1)_*_0.5rem_-_100%)_*_1e4,(100%_-_40rem)_*_1e4))]';

  it.each([...BOXED, 'link'] as const)(
    "never narrows a %s button below its row's widest label, and stacks it once the labels crowd the row",
    (variant) => {
      expect(classesOf(variant)).toContain(SHARED_FLOOR);
    }
  );

  it.each([...BOXED, 'link'] as const)(
    'centres a %s button stacked in a crowded row wider than 40rem at its own width, alone on its line',
    (variant) => {
      expect(classesOf(variant)).toContain(WIDE_STACK_MARGIN);
    }
  );
});

/** Each value the shared-row floor copies from the group classes, as the classes spell it. */
const COPIED_VALUES = {
  memberFloor: [/max\(([\d.]+rem),var\(--btn-eq,0px\)/g],
  widthSwitch: [/\(([\d.]+rem)_-_100%\)/g, /\(100%_-_([\d.]+rem)\)/g],
  gap: [/\(var\(--btn-count,1\)_-_1\)_\*_([\d.]+rem)/g],
  factor: [/_\*_(1e\d+)/g],
} as const;

type CopiedValue = keyof typeof COPIED_VALUES;

function copiedValues(classes: string): Record<CopiedValue, string[]> {
  const read = (patterns: readonly RegExp[]): string[] =>
    [...new Set(patterns.flatMap((pattern) => [...classes.matchAll(pattern)].map((m) => m[1])))]
      .filter((value): value is string => value !== undefined)
      .toSorted((left, right) => left.localeCompare(right));
  return {
    memberFloor: read(COPIED_VALUES.memberFloor),
    widthSwitch: read(COPIED_VALUES.widthSwitch),
    gap: read(COPIED_VALUES.gap),
    factor: read(COPIED_VALUES.factor),
  };
}

/** Tailwind's spacing step, which a `gap-<n>` class multiplies. */
const SPACING_STEP_REM = 0.25;

/** The gap each `gap-<n>` class in a group draws, in rem. */
function drawnGaps(classes: string): string[] {
  return classes.split(' ').flatMap((token) => {
    const step = /^gap-([\d.]+)$/.exec(token)?.[1];
    return step === undefined ? [] : [`${String(Number(step) * SPACING_STEP_REM)}rem`];
  });
}

describe('the shared-row floor', () => {
  it("copies the group classes' member floor, width switch, gap and factor exactly", () => {
    const group = copiedValues(`${buttonRowClass} ${buttonLabelsRowClass}`);
    const floor = copiedValues(
      classesOf('default')
        .filter((token) => token.startsWith('[[data-wrap-labels=shared]'))
        .join(' ')
    );

    expect(Object.values(group).map((values) => values.length)).toEqual([1, 1, 1, 1]);
    expect(floor).toEqual(group);
  });

  it('assumes the gap every group class draws', () => {
    const { gap } = copiedValues(
      classesOf('default')
        .filter((token) => token.startsWith('[[data-wrap-labels=shared]'))
        .join(' ')
    );

    expect({
      row: drawnGaps(buttonRowClass),
      labelsRow: drawnGaps(buttonLabelsRowClass),
      stack: drawnGaps(buttonStackClass),
    }).toEqual({ row: gap, labelsRow: gap, stack: gap });
  });
});
