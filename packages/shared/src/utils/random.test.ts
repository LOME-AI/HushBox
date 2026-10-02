import { describe, expect, it, vi } from 'vitest';
import { getSecureRandomIndex, getSecureRandomElement } from './random';

/** The number of distinct values one 32-bit draw can take. */
const UINT32_RANGE = 2 ** 32;

/**
 * Runs one call with `firstDraw` as the first 32-bit draw and 0 for every redraw,
 * reporting the index and how many draws the call consumed.
 */
function callWithFirstDraw(
  firstDraw: number,
  arrayLength: number
): { index: number; draws: number } {
  let draws = 0;
  vi.stubGlobal('crypto', {
    getRandomValues: (buffer: Uint32Array): Uint32Array => {
      draws += 1;
      buffer[0] = draws === 1 ? firstDraw : 0;
      return buffer;
    },
  });
  try {
    return { index: getSecureRandomIndex(arrayLength), draws };
  } finally {
    vi.unstubAllGlobals();
  }
}

/**
 * The smallest draw the function refuses, which is the size of the draw space it
 * accepts. Found by bisection rather than by recomputing the implementation's own
 * threshold, so the assertions below rest on observed behavior.
 */
function acceptedDrawSpace(arrayLength: number): number {
  let accepted = 0;
  let refused = UINT32_RANGE;
  while (refused - accepted > 1) {
    const probe = Math.floor((accepted + refused) / 2);
    if (callWithFirstDraw(probe, arrayLength).draws === 1) {
      accepted = probe;
    } else {
      refused = probe;
    }
  }
  return refused;
}

describe('random utilities', () => {
  describe('getSecureRandomIndex', () => {
    it('returns an index within valid range', () => {
      const arrayLength = 10;
      for (let iteration = 0; iteration < 100; iteration++) {
        const index = getSecureRandomIndex(arrayLength);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(arrayLength);
      }
    });

    it('returns 0 for array of length 1', () => {
      expect(getSecureRandomIndex(1)).toBe(0);
    });

    it('throws for array length of 0', () => {
      expect(() => getSecureRandomIndex(0)).toThrow('Array length must be positive');
    });

    it('throws for negative array length', () => {
      expect(() => getSecureRandomIndex(-1)).toThrow('Array length must be positive');
    });

    it('throws when the array length exceeds the draw space', () => {
      expect(() => getSecureRandomIndex(UINT32_RANGE + 1)).toThrow(
        'Array length must not exceed the random draw space'
      );
    });

    it('handles large array lengths', () => {
      const largeLength = 1_000_000;
      const index = getSecureRandomIndex(largeLength);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(largeLength);
    });
  });

  describe('getSecureRandomIndex uniformity', () => {
    // 2^32 is not a multiple of 3, so a plain modulus would favour some indices.
    const arrayLength = 3;

    it('accepts a draw space that is an exact multiple of the range', () => {
      expect(UINT32_RANGE % arrayLength).not.toBe(0);
      expect(acceptedDrawSpace(arrayLength) % arrayLength).toBe(0);
    });

    it('discards less than one range worth of the draw space', () => {
      expect(UINT32_RANGE - acceptedDrawSpace(arrayLength)).toBeLessThan(arrayLength);
    });

    it('accepts the largest draw inside the accepted space', () => {
      expect(callWithFirstDraw(acceptedDrawSpace(arrayLength) - 1, arrayLength).draws).toBe(1);
    });

    it('redraws when the draw falls outside the accepted space', () => {
      expect(callWithFirstDraw(acceptedDrawSpace(arrayLength), arrayLength)).toEqual({
        index: 0,
        draws: 2,
      });
    });

    it('discards nothing when the range divides the draw space evenly', () => {
      expect(acceptedDrawSpace(4)).toBe(UINT32_RANGE);
    });

    it('maps the lowest draws onto every index in turn', () => {
      for (let draw = 0; draw < arrayLength; draw++) {
        expect(callWithFirstDraw(draw, arrayLength).index).toBe(draw);
      }
    });
  });

  describe('getSecureRandomElement', () => {
    it('returns an element from the array', () => {
      const array = ['a', 'b', 'c', 'd', 'e'];
      for (let iteration = 0; iteration < 50; iteration++) {
        const element = getSecureRandomElement(array);
        expect(array).toContain(element);
      }
    });

    it('returns the only element for single-element array', () => {
      expect(getSecureRandomElement(['only'])).toBe('only');
    });

    it('throws for empty array', () => {
      expect(() => getSecureRandomElement([])).toThrow(
        'Cannot get random element from empty array'
      );
    });

    it('works with readonly arrays', () => {
      const readonlyArray = ['x', 'y', 'z'] as const;
      const element = getSecureRandomElement(readonlyArray);
      expect(['x', 'y', 'z']).toContain(element);
    });

    it('works with arrays of numbers', () => {
      const numbers = [1, 2, 3, 4, 5];
      const element = getSecureRandomElement(numbers);
      expect(numbers).toContain(element);
    });

    it('works with arrays of objects', () => {
      const objects = [{ id: 1 }, { id: 2 }, { id: 3 }];
      const element = getSecureRandomElement(objects);
      expect(objects).toContain(element);
    });
  });
});
