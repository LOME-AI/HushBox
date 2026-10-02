import { requireSampleCount } from './bounds.js';

/** Uniform noise in [−1, 1), one generator value per sample. */
export function whiteNoise(samples: number, next: () => number): Float32Array {
  requireSampleCount('samples', samples);
  const output = new Float32Array(samples);
  for (let index = 0; index < samples; index++) {
    output[index] = 2 * next() - 1;
  }
  return output;
}

/**
 * Pole and input weight of each first-order section in Paul Kellet's refined
 * pink-noise filter; their sum approximates a −3 dB per octave slope.
 */
const PINK_SECTIONS = [
  { pole: 0.998_86, weight: 0.055_517_9 },
  { pole: 0.993_32, weight: 0.075_075_9 },
  { pole: 0.969, weight: 0.153_852 },
  { pole: 0.8665, weight: 0.310_485_6 },
  { pole: 0.55, weight: 0.532_952_2 },
  { pole: -0.7616, weight: -0.016_898 },
] as const;
/** The filter's direct path, and the one-sample-delayed path it adds after the sections. */
const PINK_DIRECT = 0.5362;
const PINK_DELAYED = 0.115_926;
/** Kellet's output gain. */
const PINK_SCALE = 0.11;

/** Noise falling 3 dB per octave: white noise from the generator through Kellet's filter. */
export function pinkNoise(samples: number, next: () => number): Float32Array {
  requireSampleCount('samples', samples);
  const output = new Float32Array(samples);
  const sections = PINK_SECTIONS.map(({ pole, weight }) => ({ pole, weight, state: 0 }));
  let delayed = 0;
  for (let index = 0; index < samples; index++) {
    const white = 2 * next() - 1;
    let sum = delayed + white * PINK_DIRECT;
    for (const section of sections) {
      section.state = section.pole * section.state + white * section.weight;
      sum += section.state;
    }
    delayed = white * PINK_DELAYED;
    output[index] = sum * PINK_SCALE;
  }
  return output;
}
