import { describe, it, expect } from 'vitest';
import { placeholderBytes } from './helpers';

describe('placeholderBytes', () => {
  it('returns a Uint8Array of the requested length', () => {
    const result = placeholderBytes(32);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result).toHaveLength(32);
  });

  it('returns different lengths for different inputs', () => {
    expect(placeholderBytes(16)).toHaveLength(16);
    expect(placeholderBytes(48)).toHaveLength(48);
    expect(placeholderBytes(64)).toHaveLength(64);
  });

  it('returns a zero-length array for length 0', () => {
    const result = placeholderBytes(0);
    expect(result).toHaveLength(0);
  });

  it('produces values in the 0-255 byte range', () => {
    const result = placeholderBytes(1000);
    for (const byte of result) {
      expect(byte).toBeGreaterThanOrEqual(0);
      expect(byte).toBeLessThanOrEqual(255);
    }
  });
});
