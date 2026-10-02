import { cos, sin } from '../dmath/dmath.js';

import { sampleAt } from './signal.js';

interface Twiddles {
  readonly cos: Float64Array;
  readonly sin: Float64Array;
}

/** Twiddle tables by transform size; each is a pure function of its size, so caching changes no result. */
const twiddleTables = new Map<number, Twiddles>();

/** cos and sin of 2πk/size for k below size / 2, through the portable sine and cosine. */
function twiddles(size: number): Twiddles {
  const cached = twiddleTables.get(size);
  if (cached !== undefined) {
    return cached;
  }
  const half = size / 2;
  const table: Twiddles = {
    cos: Float64Array.from({ length: half }, (_, k) => cos((2 * Math.PI * k) / size)),
    sin: Float64Array.from({ length: half }, (_, k) => sin((2 * Math.PI * k) / size)),
  };
  twiddleTables.set(size, table);
  return table;
}

function isPowerOfTwo(size: number): boolean {
  let remaining = size;
  while (remaining > 1 && remaining % 2 === 0) {
    remaining /= 2;
  }
  return remaining === 1;
}

function swap(values: Float64Array, a: number, b: number): void {
  const held = sampleAt(values, a);
  values[a] = sampleAt(values, b);
  values[b] = held;
}

/** Reorders both parts into bit-reversed index order, in place. */
function bitReverse(real: Float64Array, imag: Float64Array): void {
  const size = real.length;
  let reversed = 0;
  for (let index = 1; index < size; index += 1) {
    let bit = size / 2;
    while (reversed >= bit) {
      reversed -= bit;
      bit /= 2;
    }
    reversed += bit;
    if (index < reversed) {
      swap(real, index, reversed);
      swap(imag, index, reversed);
    }
  }
}

/** A complex signal as its real and imaginary parts. */
interface Parts {
  readonly real: Float64Array;
  readonly imag: Float64Array;
}

/** One radix-2 butterfly between points a and a + span, with the twiddle (cos θ, sin θ) for e^(−iθ). */
function butterfly(
  parts: Parts,
  a: number,
  span: number,
  twiddle: readonly [number, number]
): void {
  const { real, imag } = parts;
  const [c, s] = twiddle;
  const b = a + span;
  const bReal = sampleAt(real, b) * c + sampleAt(imag, b) * s;
  const bImag = sampleAt(imag, b) * c - sampleAt(real, b) * s;
  const aReal = sampleAt(real, a);
  const aImag = sampleAt(imag, a);
  real[b] = aReal - bReal;
  imag[b] = aImag - bImag;
  real[a] = aReal + bReal;
  imag[a] = aImag + bImag;
}

/** The forward discrete Fourier transform, in place, for a power-of-two length. */
export function fft(real: Float64Array, imag: Float64Array): void {
  const size = real.length;
  if (imag.length !== size) {
    throw new RangeError(
      `FFT parts differ in length: real ${String(size)}, imaginary ${String(imag.length)}`
    );
  }
  if (!isPowerOfTwo(size)) {
    throw new RangeError(`FFT length ${String(size)} is not a power of two`);
  }
  bitReverse(real, imag);
  const table = twiddles(size);
  for (let span = 1; span < size; span *= 2) {
    const stride = size / (2 * span);
    for (let start = 0; start < size; start += 2 * span) {
      for (let k = 0; k < span; k += 1) {
        const twiddle = [sampleAt(table.cos, k * stride), sampleAt(table.sin, k * stride)] as const;
        butterfly({ real, imag }, start + k, span, twiddle);
      }
    }
  }
}

/** The periodic Hann window of `size` points. */
export function hann(size: number): Float64Array {
  return Float64Array.from(
    { length: size },
    (_, index) => 0.5 - 0.5 * cos((2 * Math.PI * index) / size)
  );
}

/** Magnitudes of bins 0 through N/2 of a real frame of power-of-two length N. */
export function magnitudeSpectrum(frame: Float64Array): Float64Array {
  const real = Float64Array.from(frame);
  const imag = new Float64Array(frame.length);
  fft(real, imag);
  return Float64Array.from({ length: frame.length / 2 + 1 }, (_, bin) => {
    const re = sampleAt(real, bin);
    const im = sampleAt(imag, bin);
    const power = re * re + im * im;
    return Math.sqrt(power);
  });
}
