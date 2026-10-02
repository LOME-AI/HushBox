import { describe, expect, it } from 'vitest';
import { isVisibleAtFloor } from './epoch-visibility.js';

describe('isVisibleAtFloor', () => {
  it('admits a message written at the caller floor', () => {
    expect(isVisibleAtFloor(3, 3)).toBe(true);
  });

  it('admits a message written after the caller floor', () => {
    expect(isVisibleAtFloor(4, 3)).toBe(true);
  });

  it('refuses a message written before the caller floor', () => {
    expect(isVisibleAtFloor(2, 3)).toBe(false);
  });
});
