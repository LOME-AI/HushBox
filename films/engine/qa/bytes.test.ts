import { describe, expect, it } from 'vitest';

import { sameBytes } from './bytes.js';

describe('sameBytes', () => {
  it('is true for equal bytes', () => {
    expect(sameBytes(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 3))).toBe(true);
  });

  it('is false for one byte different', () => {
    expect(sameBytes(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 4))).toBe(false);
  });

  it('is false for a prefix', () => {
    expect(sameBytes(Uint8Array.of(1, 2), Uint8Array.of(1, 2, 3))).toBe(false);
  });
});
