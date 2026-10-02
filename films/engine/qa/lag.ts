import { fft } from '../analyze/fft.js';

import { at } from './at.js';

import type { StereoBuffer } from '../audio/dsp/index.js';

/** The widest lag searched either way, in samples. */
export const LAG_SEARCH = 4096;
/** Lags either side of the transform's peak whose sums are taken exactly, so rounding cannot pick the neighbour. */
const EXACT_SPAN = 2;

function mono({ left, right }: StereoBuffer): Float64Array {
  return Float64Array.from(left, (sample, index) => sample + at(right, index));
}

function energy(signal: Float64Array): number {
  let sum = 0;
  for (const sample of signal) {
    sum += sample * sample;
  }
  return sum;
}

function powerOfTwoAtLeast(length: number): number {
  let size = 1;
  while (size < length) {
    size *= 2;
  }
  return size;
}

/** Σ a[n + lag]·b[n] at every lag, circularly indexed: lag L at index L, or size + L when negative. */
function correlation(a: Float64Array, b: Float64Array): Float64Array {
  const size = powerOfTwoAtLeast(a.length + b.length);
  const aReal = new Float64Array(size);
  const aImag = new Float64Array(size);
  const bReal = new Float64Array(size);
  const bImag = new Float64Array(size);
  aReal.set(a);
  bReal.set(b);
  fft(aReal, aImag);
  fft(bReal, bImag);
  // A·conj(B), conjugated so a forward transform inverts it; the real part survives the second conjugation.
  for (let bin = 0; bin < size; bin++) {
    const real = at(aReal, bin) * at(bReal, bin) + at(aImag, bin) * at(bImag, bin);
    const imag = at(aImag, bin) * at(bReal, bin) - at(aReal, bin) * at(bImag, bin);
    aReal[bin] = real;
    aImag[bin] = -imag;
  }
  fft(aReal, aImag);
  return aReal.map((value) => value / size);
}

/** The exact sum Σ a[n + lag]·b[n] over the samples both signals hold. */
function exactSum(a: Float64Array, b: Float64Array, lag: number): number {
  const first = Math.max(0, -lag);
  const last = Math.min(b.length, a.length - lag);
  let sum = 0;
  for (let index = first; index < last; index++) {
    sum += at(a, index + lag) * at(b, index);
  }
  return sum;
}

function bestOf(lags: Iterable<number>, score: (lag: number) => number): number {
  let best = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const lag of lags) {
    const value = score(lag);
    if (value > bestScore) {
      bestScore = value;
      best = lag;
    }
  }
  return best;
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

/**
 * The whole-signal lag of `signal` against `master`, in samples: the shift in
 * [−LAG_SEARCH, LAG_SEARCH] that maximises the cross-correlation of their mono
 * sums. Positive means the signal is late. The correlation is taken through the
 * FFT and its peak confirmed by exact sums at the lags beside it.
 */
export function signalLag(signal: StereoBuffer, master: StereoBuffer): number {
  const a = mono(signal);
  const b = mono(master);
  if (energy(a) === 0 || energy(b) === 0) {
    throw new RangeError('the signal or the master is silent: it has no lag');
  }
  const correlated = correlation(a, b);
  const size = correlated.length;
  const peak = bestOf(range(-LAG_SEARCH, LAG_SEARCH), (lag) =>
    at(correlated, lag < 0 ? size + lag : lag)
  );
  const near = range(
    Math.max(-LAG_SEARCH, peak - EXACT_SPAN),
    Math.min(LAG_SEARCH, peak + EXACT_SPAN)
  );
  return bestOf(near, (lag) => exactSum(a, b, lag));
}
