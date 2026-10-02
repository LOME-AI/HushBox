import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { hashKey, range } from './rand.js';
import { firstOutputs } from './rand-test-support.js';

describe('hashKey', () => {
  it('returns an unsigned 32-bit integer for any key', () => {
    // Generator: `fc.string` with full-unicode units.
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme' }), (key) => {
        const hash = hashKey(key);
        expect(Number.isInteger(hash) && hash >= 0 && hash <= 0xff_ff_ff_ff).toBe(true);
      })
    );
  });
});

describe('rand', () => {
  it('returns values in [0, 1) for any key', () => {
    // Generators: `fc.string` for the key, `fc.integer` for how many values to draw.
    fc.assert(
      fc.property(fc.string(), fc.integer({ min: 1, max: 64 }), (key, count) => {
        for (const value of firstOutputs(key, count)) {
          expect(value >= 0 && value < 1).toBe(true);
        }
      })
    );
  });
});

describe('range', () => {
  it('stays inside [min, max) for any key', () => {
    // Generators: `fc.string` for the key, `fc.integer` for the bounds.
    fc.assert(
      fc.property(
        fc.string(),
        fc.integer({ min: -1000, max: 1000 }),
        fc.integer({ min: 1, max: 1000 }),
        (key, min, span) => {
          const value = range(key, min, min + span);
          expect(value >= min && value < min + span).toBe(true);
        }
      )
    );
  });
});
