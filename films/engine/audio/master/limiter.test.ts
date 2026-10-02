import { describe, expect, it } from 'vitest';

import { truePeakDbtp } from '../../analyze/index.js';
import { SAMPLE_RATE } from '../../time/grid.js';
import { createStereo, sine } from '../dsp/index.js';

import {
  LIMITER_LOOKAHEAD,
  LIMITER_RELEASE,
  forwardMinimum,
  limit,
  truePeakKey,
} from './limiter.js';

import type { StereoBuffer } from '../dsp/index.js';

/** A full-scale 12 kHz sine at 45°: every sample sits at ±0.7071 while the wave between them reaches ±1. */
function sine12kAt45Degrees(samples: number): StereoBuffer {
  const period = SAMPLE_RATE / 12_000;
  const channel = Float32Array.from({ length: samples }, (_, index) =>
    Math.sin((2 * Math.PI * (index % period)) / period + Math.PI / 4)
  );
  return { left: channel, right: Float32Array.from(channel) };
}

function mono(channel: Float32Array): StereoBuffer {
  return { left: channel, right: Float32Array.from(channel) };
}

function samplePeak(buffer: StereoBuffer): number {
  let peak = 0;
  for (const channel of [buffer.left, buffer.right]) {
    for (const sample of channel) {
      peak = Math.max(peak, Math.abs(sample));
    }
  }
  return peak;
}

function indexOfPeak(channel: Float32Array): number {
  let best = 0;
  for (const [index, sample] of channel.entries()) {
    if (Math.abs(sample) > Math.abs(channel[best] ?? 0)) {
      best = index;
    }
  }
  return best;
}

describe('forwardMinimum', () => {
  it('takes each value’s minimum over the window that starts at it', () => {
    expect([...forwardMinimum(Float64Array.of(5, 3, 4, 1, 2, 6), 2)]).toEqual([3, 3, 1, 1, 2, 6]);
  });

  it('shortens the windows that run past the end to the values that remain', () => {
    expect([...forwardMinimum(Float64Array.of(4, 2, 7, 9), 3)]).toEqual([2, 2, 7, 9]);
  });

  it('returns the values themselves for a window of one', () => {
    expect([...forwardMinimum(Float64Array.of(3, 1, 2), 1)]).toEqual([3, 1, 2]);
  });
});

describe('truePeakKey', () => {
  it('reads an isolated sample at its own level on its own sample', () => {
    const left = new Float32Array(64);
    left[32] = 0.5;
    expect(truePeakKey({ left, right: new Float32Array(64) })[32]).toBe(0.5);
  });

  it('finds the peak between samples that the samples themselves miss', () => {
    const key = truePeakKey(sine12kAt45Degrees(SAMPLE_RATE / 100));
    const middle = key.subarray(100, 300);
    expect(Math.max(...middle)).toBeGreaterThan(0.98);
    expect(Math.max(...middle)).toBeLessThanOrEqual(1.01);
  });

  it('follows the louder channel', () => {
    const right = new Float32Array(64);
    right[10] = -0.25;
    expect(truePeakKey({ left: new Float32Array(64), right })[10]).toBe(0.25);
  });

  it('holds one value per input sample', () => {
    expect(truePeakKey(createStereo(17))).toHaveLength(17);
  });
});

describe('limit', () => {
  it('only scales a signal that never needs limiting', () => {
    const tone = sine({ frequency: 440, samples: 4800 }).map((sample) => sample * 0.1);
    const input = mono(tone);
    const output = limit(input, truePeakKey(input), { gain: 2, ceiling: 0.9 });
    expect([...output.left]).toEqual([...tone.map((sample) => sample * 2)]);
  });

  it('holds every sample at or below the ceiling', () => {
    const input = mono(sine({ frequency: 97, samples: SAMPLE_RATE / 2 }));
    const output = limit(input, truePeakKey(input), { gain: 4, ceiling: 0.8 });
    expect(samplePeak(output)).toBeLessThanOrEqual(Math.fround(0.8));
    expect(samplePeak(output)).toBeGreaterThan(0.79);
  });

  it('holds the peaks between samples near the ceiling too', () => {
    const input = sine12kAt45Degrees(SAMPLE_RATE / 10);
    const output = limit(input, truePeakKey(input), { gain: 1, ceiling: 0.5 });
    expect(truePeakDbtp(output)).toBeLessThanOrEqual(20 * Math.log10(0.5) + 0.1);
  });

  it('covers a peak on the very first sample, before any ramp could start', () => {
    const channel = new Float32Array(480).fill(0.1);
    channel[0] = 1;
    const input = mono(channel);
    const output = limit(input, truePeakKey(input), { gain: 1, ceiling: 0.5 });
    expect(Math.abs(output.left[0] ?? Number.NaN)).toBeLessThanOrEqual(0.5);
  });

  it('limits an empty signal to an empty signal', () => {
    const output = limit(createStereo(0), new Float64Array(0), { gain: 1, ceiling: 0.5 });
    expect(output.left).toHaveLength(0);
  });

  it('adds no latency: a lone loud sample stays the loudest on its own index', () => {
    const channel = sine({ frequency: 200, samples: 4800 }).map((sample) => sample * 0.05);
    channel[2400] = 1;
    const input = mono(channel);
    const output = limit(input, truePeakKey(input), { gain: 1, ceiling: 0.5 });
    expect(indexOfPeak(output.left)).toBe(2400);
  });

  it('starts turning down no earlier than one lookahead before a peak', () => {
    const channel = new Float32Array(4800).fill(0.1);
    channel[2400] = 1;
    const input = mono(channel);
    const output = limit(input, truePeakKey(input), { gain: 1, ceiling: 0.5 });
    // The key widens a sample by one on each side, so the earliest reduction is one sample sooner.
    const untouched = 2400 - 1 - LIMITER_LOOKAHEAD;
    expect(output.left[untouched]).toBe(Math.fround(0.1));
    expect(output.left[untouched + 1]).toBeLessThan(Math.fround(0.1));
  });

  it('recovers to within 1% of unity gain ten release times after the peak', () => {
    const channel = new Float32Array(SAMPLE_RATE).fill(0.1);
    channel[1000] = 1;
    const input = mono(channel);
    const output = limit(input, truePeakKey(input), { gain: 1, ceiling: 0.5 });
    const after = 1000 + LIMITER_LOOKAHEAD + 10 * LIMITER_RELEASE * SAMPLE_RATE;
    expect((output.left[after] ?? Number.NaN) / 0.1).toBeGreaterThan(0.99);
  });
});
