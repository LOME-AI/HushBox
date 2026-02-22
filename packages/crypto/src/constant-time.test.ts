import { describe, it, expect } from 'vitest';
import { constantTimeCompare } from './constant-time.js';

describe('constantTimeCompare', () => {
  it('returns true for equal arrays', () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([1, 2, 3, 4]);
    expect(constantTimeCompare(a, b)).toBe(true);
  });

  it('returns false for different arrays', () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([1, 2, 3, 5]);
    expect(constantTimeCompare(a, b)).toBe(false);
  });

  it('returns false for different lengths', () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 3, 4]);
    expect(constantTimeCompare(a, b)).toBe(false);
  });

  it('returns true for empty arrays', () => {
    const a = new Uint8Array([]);
    const b = new Uint8Array([]);
    expect(constantTimeCompare(a, b)).toBe(true);
  });

  it('returns false when first byte differs', () => {
    const a = new Uint8Array([0, 2, 3, 4]);
    const b = new Uint8Array([1, 2, 3, 4]);
    expect(constantTimeCompare(a, b)).toBe(false);
  });

  it('returns false when last byte differs', () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([1, 2, 3, 0]);
    expect(constantTimeCompare(a, b)).toBe(false);
  });

  it('returns false when middle byte differs', () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([1, 0, 3, 4]);
    expect(constantTimeCompare(a, b)).toBe(false);
  });
});
