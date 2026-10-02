import { describe, expect, it } from 'vitest';

import { hashKey } from '../rand/rand.js';
import {
  FBM_OCTAVES,
  HASH_MIX,
  HASH_STEP,
  NOISE_GLSL,
  fbm,
  hash3,
  latticeValue,
  noiseSeed,
  valueNoise,
} from './noise.js';

const UINT32 = 2n ** 32n;

function wrap(value: bigint): bigint {
  return ((value % UINT32) + UINT32) % UINT32;
}

/** The hash as GLSL's `uint` computes it: every product and sum wrapped to 32 bits. */
function referenceHash(x: number, y: number, z: number): number {
  const [stepX, stepY, stepZ] = HASH_STEP.map(BigInt);
  const [mixA, mixB] = HASH_MIX.map(BigInt);
  let h = wrap(
    wrap(BigInt(x)) * (stepX ?? 0n) +
      wrap(BigInt(y)) * (stepY ?? 0n) +
      wrap(BigInt(z)) * (stepZ ?? 0n)
  );
  h ^= h >> 16n;
  h = wrap(h * (mixA ?? 0n));
  h ^= h >> 15n;
  h = wrap(h * (mixB ?? 0n));
  h ^= h >> 16n;
  return Number(h);
}

describe('hash3', () => {
  it.each([
    [0, 0, 0],
    [1, 2, 3],
    [-1, -7, 12],
    [2_000_000, -3_000_000, 4_000_000_000],
    [-2_147_483_648, 2_147_483_647, 4_294_967_295],
  ])('matches 32-bit unsigned wrap-around arithmetic at (%d, %d, %d)', (x, y, z) => {
    expect(hash3(x, y, z)).toBe(referenceHash(x, y, z));
  });

  it('gives neighbouring cells different values', () => {
    expect(new Set([hash3(0, 0, 0), hash3(1, 0, 0), hash3(0, 1, 0), hash3(0, 0, 1)]).size).toBe(4);
  });
});

describe('latticeValue', () => {
  it('is the top 24 bits of the hash as a share of 2^24', () => {
    expect(latticeValue(5, -3, 9)).toBe(Math.floor(hash3(5, -3, 9) / 256) / 16_777_216);
  });
});

describe('valueNoise', () => {
  it('takes the lattice value on a whole-numbered point', () => {
    expect(valueNoise(4, -2, 11)).toBe(latticeValue(4, -2, 11));
  });

  it('is continuous across a cell boundary', () => {
    expect(valueNoise(3 - 1e-9, 0.4, 7)).toBeCloseTo(valueNoise(3, 0.4, 7), 6);
  });

  it('eases into each lattice point with a flat tangent', () => {
    const at = latticeValue(2, 5, 1);
    expect(Math.abs(valueNoise(2 + 1e-4, 5, 1) - at)).toBeLessThan(1e-9);
  });

  it('draws a different field for a different seed', () => {
    expect(valueNoise(0.5, 0.5, 1)).not.toBe(valueNoise(0.5, 0.5, 2));
  });

  it.each([
    ['x', Number.NaN, 0, 1],
    ['x', Number.POSITIVE_INFINITY, 0, 1],
    ['y', 0, Number.NaN, 1],
    ['y', 0, Number.NEGATIVE_INFINITY, 1],
    ['seed', 0, 0, Number.NaN],
    ['seed', 0, 0, Number.POSITIVE_INFINITY],
  ])('refuses a %s that is not finite (%s, %s, %s), naming it', (input, x, y, seed) => {
    expect(() => valueNoise(x, y, seed)).toThrow(new RegExp(`valueNoise: ${input} `));
  });

  it('draws at the largest finite coordinate it is given', () => {
    expect(Number.isFinite(valueNoise(Number.MAX_SAFE_INTEGER, -1e9, 0xff_ff_ff_ff))).toBe(true);
  });
});

describe('fbm', () => {
  it('sums octaves of halving weight, each at twice the frequency and its own seed', () => {
    const [x, y, seed] = [1.3, -0.7, 21];
    let sum = 0;
    let total = 0;
    for (let octave = 0; octave < FBM_OCTAVES; octave += 1) {
      const scale = 2 ** octave;
      const weight = 0.5 / scale;
      sum += weight * valueNoise(x * scale, y * scale, seed + octave);
      total += weight;
    }
    expect(fbm(x, y, seed)).toBeCloseTo(sum / total, 12);
  });

  it('wraps its octave seeds past 2^32 as GLSL does', () => {
    expect(fbm(0.25, 0.75, 4_294_967_295)).toBeCloseTo(
      (0.5 * valueNoise(0.25, 0.75, 4_294_967_295) +
        0.25 * valueNoise(0.5, 1.5, 0) +
        0.125 * valueNoise(1, 3, 1) +
        0.0625 * valueNoise(2, 6, 2)) /
        0.9375,
      12
    );
  });
});

describe('noiseSeed', () => {
  it('is the key hashed to an unsigned 32-bit integer', () => {
    expect(noiseSeed('candle')).toBe(hashKey('candle'));
  });
});

describe('NOISE_GLSL', () => {
  it.each([...HASH_STEP, ...HASH_MIX].map((constant) => [constant.toString(16)]))(
    'carries the hash constant 0x%s the CPU mirror uses',
    (hex) => {
      expect(NOISE_GLSL).toContain(`0x${hex}u`);
    }
  );

  it('sums the same number of octaves as the CPU mirror', () => {
    expect(NOISE_GLSL).toContain(`const int FBM_OCTAVES = ${String(FBM_OCTAVES)};`);
  });
});
