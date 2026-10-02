import { describe, expect, it } from 'vitest';

import { multiply } from './matrix.js';

import type { Mat4 } from './matrix.js';

// Column-major, as WebGL reads a matrix uniform: element (row, column) sits at column * 4 + row.
const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const TRANSLATE_1_2_3: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1];
const SCALE_2: Mat4 = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1];

describe('multiply', () => {
  it('leaves a matrix unchanged under the identity', () => {
    expect(multiply(IDENTITY, TRANSLATE_1_2_3)).toEqual(TRANSLATE_1_2_3);
  });

  it('applies the right-hand matrix first: a scale then a translation keeps the translation', () => {
    expect(multiply(TRANSLATE_1_2_3, SCALE_2)).toEqual([
      2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 1, 2, 3, 1,
    ]);
  });

  it('applies the left-hand matrix last: a translation then a scale scales the translation', () => {
    expect(multiply(SCALE_2, TRANSLATE_1_2_3)).toEqual([
      2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 2, 4, 6, 1,
    ]);
  });
});

describe('a malformed matrix', () => {
  it('is refused by multiply, which reads 16 numbers', () => {
    expect(() => multiply([1, 0, 0], IDENTITY)).toThrow(/16 numbers/);
  });
});
