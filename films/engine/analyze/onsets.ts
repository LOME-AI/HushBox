import { SAMPLE_RATE } from '../time/grid.js';
import { log } from '../dmath/dmath.js';

import { dbToAmplitude } from './decibels.js';
import { hann, magnitudeSpectrum } from './fft.js';
import { requireStereo, sampleAt } from './signal.js';

import type { StereoBuffer } from '../audio/dsp/index.js';

/** Spectral-flux analysis frame, in samples; each frame is centred on its hop position. */
const ONSET_FRAME = 1024;

/** Samples between consecutive analysis frames: the onset list's time resolution. */
export const ONSET_HOP = 256;

function framesFor(seconds: number): number {
  return Math.round((seconds * SAMPLE_RATE) / ONSET_HOP);
}

/** An onset is the largest flux within this many frames on either side. */
const LOCAL_MAX_FRAMES = framesFor(0.015);
/** The mean an onset must clear is taken over this many frames on either side, the onset excluded. */
const AVERAGE_FRAMES = framesFor(0.1);
/** Consecutive onsets are at least this many frames apart. */
const MIN_GAP_FRAMES = framesFor(0.03);
/** How far above that mean an onset's flux must rise, as a fraction of the largest flux. */
const THRESHOLD = 0.1;

/**
 * Half-wave-rectified log-magnitude spectral flux of the mono mix, one value per
 * frame whose window ends at or before the signal's end. The signal is silent before
 * its start, so a sound on the first sample has an onset.
 */
function spectralFlux(signal: StereoBuffer, length: number): Float64Array {
  const mono = signal.left.map((left, index) => (left + sampleAt(signal.right, index)) / 2);
  const half = ONSET_FRAME / 2;
  const count = length < half ? 0 : Math.floor((length - half) / ONSET_HOP) + 1;
  const window = hann(ONSET_FRAME);
  const flux = new Float64Array(count);
  let previous = new Float64Array(half + 1);
  for (const frame of flux.keys()) {
    const start = frame * ONSET_HOP - half;
    const windowed = window.map((weight, index) => weight * sampleAt(mono, start + index));
    const current = magnitudeSpectrum(windowed).map((magnitude) => log(1 + magnitude));
    let rise = 0;
    for (const [bin, value] of current.entries()) {
      rise += Math.max(0, value - sampleAt(previous, bin));
    }
    flux[frame] = rise;
    previous = current;
  }
  return flux;
}

function isLocalMax(flux: Float64Array, frame: number): boolean {
  const value = sampleAt(flux, frame);
  for (let other = frame - LOCAL_MAX_FRAMES; other <= frame + LOCAL_MAX_FRAMES; other += 1) {
    if (sampleAt(flux, other) > value) {
      return false;
    }
  }
  return true;
}

function neighbourMean(flux: Float64Array, frame: number): number {
  const first = Math.max(0, frame - AVERAGE_FRAMES);
  const last = Math.min(flux.length - 1, frame + AVERAGE_FRAMES);
  let sum = 0;
  for (let other = first; other <= last; other += 1) {
    sum += other === frame ? 0 : sampleAt(flux, other);
  }
  const neighbours = last - first;
  return neighbours === 0 ? 0 : sum / neighbours;
}

/**
 * The frames of a flux curve that hold onsets: a local maximum, at least
 * THRESHOLD (of the curve's largest value) above the mean of its neighbours,
 * and at least MIN_GAP_FRAMES after the previous onset.
 */
export function pickPeaks(flux: Float64Array): number[] {
  let largest = 0;
  for (const value of flux) {
    largest = Math.max(largest, value);
  }
  if (largest === 0) {
    return [];
  }
  const normalised = flux.map((value) => value / largest);
  const onsets: number[] = [];
  let previous = Number.NEGATIVE_INFINITY;
  for (const [frame, value] of normalised.entries()) {
    if (
      frame - previous >= MIN_GAP_FRAMES &&
      isLocalMax(normalised, frame) &&
      value >= neighbourMean(normalised, frame) + THRESHOLD
    ) {
      onsets.push(frame);
      previous = frame;
    }
  }
  return onsets;
}

/** Sample positions of spectral-flux onsets, to a resolution of ONSET_HOP samples. */
export function spectralFluxOnsets(signal: StereoBuffer): number[] {
  const length = requireStereo(signal);
  return pickPeaks(spectralFlux(signal, length)).map((frame) => frame * ONSET_HOP);
}

/** The first sample at which either channel's magnitude reaches the threshold; null if none does. */
export function firstOnsetSample(signal: StereoBuffer, thresholdDbfs: number): number | null {
  requireStereo(signal);
  if (!Number.isFinite(thresholdDbfs)) {
    throw new RangeError(`onset threshold ${String(thresholdDbfs)} dBFS is not a finite level`);
  }
  const threshold = dbToAmplitude(thresholdDbfs);
  for (const [index, left] of signal.left.entries()) {
    if (Math.max(Math.abs(left), Math.abs(sampleAt(signal.right, index))) >= threshold) {
      return index;
    }
  }
  return null;
}
