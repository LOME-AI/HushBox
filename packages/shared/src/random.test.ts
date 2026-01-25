import { describe, expect, it } from 'vitest';
import { getSecureRandomIndex, getSecureRandomElement } from './random';

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

    it('handles large array lengths', () => {
      const largeLength = 1_000_000;
      const index = getSecureRandomIndex(largeLength);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(largeLength);
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
