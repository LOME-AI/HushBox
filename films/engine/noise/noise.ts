import { hashKey } from '../rand/rand.js';

// The engine's value noise, in GLSL and as its CPU mirror. The hash is integer
// arithmetic that wraps at 32 bits, which `Math.imul` and `>>> 0` compute exactly
// as GLSL's `uint` does, so a lattice value is the same bits on both sides; the
// smoothing between lattice points is float maths, where the GPU's single
// precision differs from the mirror only in the last places. The GLSL source is generated from the
// constants below, so the two cannot name different ones.

/** The multipliers that mix a cell's x, y and seed into one word. */
export const HASH_STEP = [0x8d_a6_b3_43, 0xd8_16_38_41, 0xcb_1a_b3_1f] as const;

/** The multipliers of the finishing avalanche, between xor-shifts of 16, 15 and 16 bits. */
export const HASH_MIX = [0x7f_eb_35_2d, 0x84_6c_a6_8b] as const;

/** Octaves an `fbm` sums, each at twice the frequency and half the weight of the last. */
export const FBM_OCTAVES = 4;

const UNIT = 16_777_216;

/** A cell and seed hashed to an unsigned 32-bit integer; any whole number wraps to 32 bits first. */
export function hash3(x: number, y: number, z: number): number {
  const [stepX, stepY, stepZ] = HASH_STEP;
  const [mixA, mixB] = HASH_MIX;
  let h = (Math.imul(x, stepX) + Math.imul(y, stepY) + Math.imul(z, stepZ)) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h, mixA) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  h = Math.imul(h, mixB) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** A lattice point's value in [0, 1): the hash's top 24 bits, which a float holds exactly. */
export function latticeValue(x: number, y: number, seed: number): number {
  return (hash3(x, y, seed) >>> 8) / UNIT;
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function assertFinite(input: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`valueNoise: ${input} ${String(value)} is not a finite number`);
  }
}

/**
 * Value noise in [0, 1]: the four lattice values of the point's cell, blended by a
 * quintic ease. A coordinate or seed that is not finite is refused, naming it.
 */
export function valueNoise(x: number, y: number, seed: number): number {
  assertFinite('x', x);
  assertFinite('y', y);
  assertFinite('seed', seed);
  const cellX = Math.floor(x);
  const cellY = Math.floor(y);
  const u = fade(x - cellX);
  const v = fade(y - cellY);
  const a = latticeValue(cellX, cellY, seed);
  const b = latticeValue(cellX + 1, cellY, seed);
  const c = latticeValue(cellX, cellY + 1, seed);
  const d = latticeValue(cellX + 1, cellY + 1, seed);
  const top = a + (b - a) * u;
  const bottom = c + (d - c) * u;
  return top + (bottom - top) * v;
}

/** Fractal noise in [0, 1]: {@link FBM_OCTAVES} octaves of value noise, each seeded on from the last. */
export function fbm(x: number, y: number, seed: number): number {
  let sum = 0;
  let total = 0;
  let weight = 0.5;
  let scale = 1;
  for (let octave = 0; octave < FBM_OCTAVES; octave += 1) {
    sum += weight * valueNoise(x * scale, y * scale, (seed + octave) >>> 0);
    total += weight;
    weight *= 0.5;
    scale *= 2;
  }
  return sum / total;
}

/** A seed key as the unsigned 32-bit integer the noise takes. */
export function noiseSeed(key: string): number {
  return hashKey(key);
}

function hex(value: number): string {
  return `0x${value.toString(16)}u`;
}

/** The GLSL of {@link hash3}, {@link latticeValue}, {@link valueNoise} and {@link fbm}. */
export const NOISE_GLSL = `
const int FBM_OCTAVES = ${String(FBM_OCTAVES)};

uint noiseHash(uvec3 p) {
  uint h = p.x * ${hex(HASH_STEP[0])} + p.y * ${hex(HASH_STEP[1])} + p.z * ${hex(HASH_STEP[2])};
  h ^= h >> 16;
  h *= ${hex(HASH_MIX[0])};
  h ^= h >> 15;
  h *= ${hex(HASH_MIX[1])};
  h ^= h >> 16;
  return h;
}

float latticeValue(ivec2 cell, uint seed) {
  return float(noiseHash(uvec3(uvec2(cell), seed)) >> 8) / ${UNIT.toFixed(1)};
}

float fade(float t) {
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

float valueNoise(vec2 p, uint seed) {
  vec2 base = floor(p);
  ivec2 cell = ivec2(base);
  vec2 f = p - base;
  float u = fade(f.x);
  float v = fade(f.y);
  float a = latticeValue(cell, seed);
  float b = latticeValue(cell + ivec2(1, 0), seed);
  float c = latticeValue(cell + ivec2(0, 1), seed);
  float d = latticeValue(cell + ivec2(1, 1), seed);
  return mix(mix(a, b, u), mix(c, d, u), v);
}

float fbm(vec2 p, uint seed) {
  float sum = 0.0;
  float total = 0.0;
  float weight = 0.5;
  for (int octave = 0; octave < FBM_OCTAVES; octave++) {
    sum += weight * valueNoise(p, seed + uint(octave));
    total += weight;
    weight *= 0.5;
    p *= 2.0;
  }
  return sum / total;
}
`;
