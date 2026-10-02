import { describe, expect, it } from 'vitest';

import { SAMPLE_RATE } from '../time/grid.js';
import { dbToAmplitude } from './decibels.js';
import { ONSET_HOP, firstOnsetSample, pickPeaks, spectralFluxOnsets } from './onsets.js';

import type { StereoBuffer } from '../audio/dsp/index.js';

/** A quiet 220 Hz bed with a click at each of `clicks`. */
function clicksOverBed(clicks: readonly number[], seconds: number): StereoBuffer {
  const channel = Float32Array.from(
    { length: seconds * SAMPLE_RATE },
    (_, index) => 0.05 * Math.sin((2 * Math.PI * 220 * index) / SAMPLE_RATE)
  );
  for (const click of clicks) {
    channel[click] = (channel[click] ?? 0) + 0.8;
  }
  return { left: channel, right: Float32Array.from(channel) };
}

/** A flux curve that is zero except for the given frame values. */
function flux(length: number, peaks: Readonly<Record<number, number>>): Float64Array {
  const curve = new Float64Array(length);
  for (const [frame, value] of Object.entries(peaks)) {
    curve[Number(frame)] = value;
  }
  return curve;
}

/** The next double below a positive finite value. */
function nextDown(value: number): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  view.setBigUint64(0, view.getBigUint64(0) - 1n);
  return view.getFloat64(0);
}

/** The single-precision values just below and at-or-above `value`. */
function float32Bracket(value: number): readonly [below: number, atOrAbove: number] {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value);
  const nearest = view.getFloat32(0);
  const bits = view.getUint32(0);
  if (nearest >= value) {
    view.setUint32(0, bits - 1);
    return [view.getFloat32(0), nearest];
  }
  view.setUint32(0, bits + 1);
  return [nearest, view.getFloat32(0)];
}

describe('spectralFluxOnsets', () => {
  it('finds each click within two hops before it', () => {
    const clicks = [30_000, 60_011, 90_123, 120_500];
    const onsets = spectralFluxOnsets(clicksOverBed(clicks, 3));
    expect(onsets).toHaveLength(clicks.length);
    for (const [index, onset] of onsets.entries()) {
      const click = clicks[index] ?? Number.NaN;
      expect(onset).toBeGreaterThan(click - 2 * ONSET_HOP);
      expect(onset).toBeLessThanOrEqual(click + ONSET_HOP);
    }
  });

  it('finds a sound that starts on the first sample', () => {
    const channel = Float32Array.from({ length: SAMPLE_RATE }, (_, index) =>
      Math.sin((2 * Math.PI * 1000 * index) / SAMPLE_RATE)
    );
    expect(spectralFluxOnsets({ left: channel, right: Float32Array.from(channel) })[0]).toBe(0);
  });

  it('finds nothing in digital silence', () => {
    expect(
      spectralFluxOnsets({
        left: new Float32Array(SAMPLE_RATE),
        right: new Float32Array(SAMPLE_RATE),
      })
    ).toEqual([]);
  });

  it('finds nothing in a signal shorter than half an analysis frame', () => {
    expect(spectralFluxOnsets(clicksOverBed([10], 0.001))).toEqual([]);
  });
});

describe('pickPeaks', () => {
  it('keeps a peak exactly 0.1 above the mean of its neighbours', () => {
    expect(pickPeaks(flux(200, { 0: 1, 100: 0.1 }))).toEqual([0, 100]);
  });

  it('drops a peak one ulp short of 0.1 above the mean of its neighbours', () => {
    expect(pickPeaks(flux(200, { 0: 1, 100: nextDown(0.1) }))).toEqual([0]);
  });

  it('keeps two peaks six frames apart', () => {
    expect(pickPeaks(flux(200, { 50: 1, 56: 1 }))).toEqual([50, 56]);
  });

  it('drops the second of two peaks five frames apart', () => {
    expect(pickPeaks(flux(200, { 50: 1, 55: 1 }))).toEqual([50]);
  });

  it('drops a peak with a larger value three frames after it', () => {
    expect(pickPeaks(flux(200, { 50: 0.5, 53: 1 }))).toEqual([53]);
  });

  it('keeps a peak whose larger neighbour is four frames after it', () => {
    expect(pickPeaks(flux(200, { 50: 0.5, 54: 1 }))).toEqual([50]);
  });

  it('scales the threshold to the largest flux', () => {
    expect(pickPeaks(flux(200, { 0: 4, 100: 0.4 }))).toEqual([0, 100]);
  });

  it('keeps the only frame of a one-frame curve', () => {
    expect(pickPeaks(Float64Array.of(0.5))).toEqual([0]);
  });

  it('finds nothing in a flat curve of zeros', () => {
    expect(pickPeaks(new Float64Array(50))).toEqual([]);
  });
});

describe('firstOnsetSample', () => {
  it('finds a unit impulse at its exact index', () => {
    const left = new Float32Array(SAMPLE_RATE);
    left[12_345] = 1;
    expect(firstOnsetSample({ left, right: new Float32Array(SAMPLE_RATE) }, -60)).toBe(12_345);
  });

  it('reads the right channel as well as the left', () => {
    const right = new Float32Array(100);
    right[7] = -0.5;
    expect(firstOnsetSample({ left: new Float32Array(100), right }, -60)).toBe(7);
  });

  it('counts the smallest sample at or above the threshold', () => {
    const [, atOrAbove] = float32Bracket(dbToAmplitude(-60));
    const left = new Float32Array(10);
    left[4] = atOrAbove;
    expect(firstOnsetSample({ left, right: new Float32Array(10) }, -60)).toBe(4);
  });

  it('does not count the largest sample below the threshold', () => {
    const [below] = float32Bracket(dbToAmplitude(-60));
    const left = new Float32Array(10);
    left[4] = below;
    expect(firstOnsetSample({ left, right: new Float32Array(10) }, -60)).toBeNull();
  });

  it('refuses a threshold that is not a finite level', () => {
    expect(() =>
      firstOnsetSample({ left: new Float32Array(1), right: new Float32Array(1) }, Number.NaN)
    ).toThrow(/NaN/);
  });
});
