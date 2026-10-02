import { describe, expect, it } from 'vitest';

import { at } from './at.js';

describe('at', () => {
  it('reads the value at an index', () => {
    expect(at(Uint8Array.of(4, 5, 6), 1)).toBe(5);
  });

  it('refuses an index past the end, naming it and the length', () => {
    expect(() => at(Uint8Array.of(4, 5, 6), 3)).toThrow(/index 3 .* 3 values/);
  });

  it('refuses a negative index', () => {
    expect(() => at([1], -1)).toThrow(/index -1/);
  });
});
