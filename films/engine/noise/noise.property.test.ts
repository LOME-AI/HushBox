import fc from 'fast-check';
import { expect, it } from 'vitest';

import { fbm, hash3, latticeValue, valueNoise } from './noise.js';

const COORDINATE = fc.double({ min: -1e4, max: 1e4, noNaN: true });
const SEED = fc.nat({ max: 0xff_ff_ff_ff });

it('hash3 is always an unsigned 32-bit integer', () => {
  // Generator: whole-numbered cells in the int32 range and 32-bit seeds.
  fc.assert(
    fc.property(fc.integer(), fc.integer(), SEED, (x, y, z) => {
      const h = hash3(x, y, z);
      expect(Number.isInteger(h) && h >= 0 && h < 2 ** 32).toBe(true);
    })
  );
});

it('valueNoise stays between the lowest and highest value of its cell corners', () => {
  // Generator: points anywhere in a wide square, and 32-bit seeds.
  fc.assert(
    fc.property(COORDINATE, COORDINATE, SEED, (x, y, seed) => {
      const [cx, cy] = [Math.floor(x), Math.floor(y)];
      const corners = [
        latticeValue(cx, cy, seed),
        latticeValue(cx + 1, cy, seed),
        latticeValue(cx, cy + 1, seed),
        latticeValue(cx + 1, cy + 1, seed),
      ];
      const value = valueNoise(x, y, seed);
      expect(value).toBeGreaterThanOrEqual(Math.min(...corners) - 1e-12);
      expect(value).toBeLessThanOrEqual(Math.max(...corners) + 1e-12);
    })
  );
});

it('fbm stays within [0, 1]', () => {
  // Generator: points anywhere in a wide square, and 32-bit seeds.
  fc.assert(
    fc.property(COORDINATE, COORDINATE, SEED, (x, y, seed) => {
      const value = fbm(x, y, seed);
      expect(value >= 0 && value <= 1).toBe(true);
    })
  );
});
