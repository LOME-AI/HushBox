import { describe, it, expect } from 'vitest';
import { at } from './test-utilities.js';

describe('test-utils', () => {
  describe('at', () => {
    it('returns the element at the given index', () => {
      const array = ['a', 'b', 'c'];

      expect(at(array, 0)).toBe('a');
      expect(at(array, 1)).toBe('b');
      expect(at(array, 2)).toBe('c');
    });

    it('throws for out-of-bounds index', () => {
      const array = ['a', 'b'];

      expect(() => at(array, 2)).toThrow('Expected value at index 2');
      expect(() => at(array, -1)).toThrow('Expected value at index -1');
    });

    it('throws for empty array', () => {
      expect(() => at([], 0)).toThrow('Expected value at index 0');
    });

    it('preserves the element type', () => {
      const numbers = [1, 2, 3];
      const result: number = at(numbers, 0);

      expect(result).toBe(1);
    });

    it('works with object arrays', () => {
      const items = [{ name: 'first' }, { name: 'second' }];

      expect(at(items, 0).name).toBe('first');
      expect(at(items, 1).name).toBe('second');
    });
  });
});
