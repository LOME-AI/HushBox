import { describe, expect, it } from 'vitest';

import { rand } from '../../rand/rand.js';
import { SAMPLE_RATE } from '../../time/grid.js';
import { createStereo, sine, whiteNoise } from '../dsp/index.js';
import { bandPower, goertzelPower, nextAfter } from '../dsp/dsp-test-support.js';

import { STUTTER_FADE, applyEffect } from './effects.js';

import type { StereoBuffer } from '../dsp/index.js';
import type { ResolvedEffect } from './define-score.js';

function stereo(channel: Float32Array): StereoBuffer {
  return { left: channel, right: Float32Array.from(channel) };
}

function impulse(samples: number, at = 0): StereoBuffer {
  const buffer = createStereo(samples);
  buffer.left[at] = 1;
  buffer.right[at] = 1;
  return buffer;
}

function tone(frequency: number, samples = SAMPLE_RATE / 10): StereoBuffer {
  return stereo(sine({ frequency, samples }).map((sample) => sample * 0.5));
}

/** A ramp, so every sample differs from its neighbours and a copy can be told from its source. */
function ramp(samples: number): StereoBuffer {
  return stereo(Float32Array.from({ length: samples }, (_, index) => (index + 1) / samples));
}

function isAllFinite(buffer: StereoBuffer): boolean {
  return [buffer.left, buffer.right].every((channel) =>
    channel.every((sample) => Number.isFinite(sample))
  );
}

function energy(channel: Float32Array): number {
  let sum = 0;
  for (const sample of channel) {
    sum += sample * sample;
  }
  return sum;
}

function peak(channel: Float32Array): number {
  let largest = 0;
  for (const sample of channel) {
    largest = Math.max(largest, Math.abs(sample));
  }
  return largest;
}

function risingCrossings(channel: Float32Array): number {
  let count = 0;
  for (let index = 1; index < channel.length; index++) {
    if ((channel[index - 1] ?? 0) < 0 && (channel[index] ?? 0) >= 0) {
      count++;
    }
  }
  return count;
}

describe('applyEffect: reverb', () => {
  it('leaves the signal as it was at a mix of 0', () => {
    const input = tone(440);
    const output = applyEffect(input, { kind: 'reverb', rt60: 2, damping: 6000, mix: 0 });
    expect([...output.left]).toEqual([...input.left]);
  });

  it('keeps the dry signal and adds a tail after it', () => {
    const output = applyEffect(impulse(SAMPLE_RATE), {
      kind: 'reverb',
      rt60: 1,
      damping: 8000,
      mix: 1,
    });
    expect(output.left[0]).toBe(1);
    expect(energy(output.left.subarray(SAMPLE_RATE / 10))).toBeGreaterThan(0);
  });

  it.each([
    { rt60: Number.MIN_VALUE, damping: 0, mix: 1 },
    { rt60: 1, damping: nextAfter(SAMPLE_RATE / 2, -1), mix: 1 },
  ])('renders finite at the edge of its settings: %j', (settings) => {
    expect(isAllFinite(applyEffect(impulse(4800), { kind: 'reverb', ...settings }))).toBe(true);
  });
});

describe('applyEffect: delay', () => {
  const effect: ResolvedEffect = { kind: 'delay', samples: 1000, feedback: 0.5, mix: 0.4 };

  it('keeps the dry signal', () => {
    expect(applyEffect(impulse(4000), effect).left[0]).toBe(1);
  });

  it('repeats the signal one delay later at the mix level', () => {
    expect(applyEffect(impulse(4000), effect).right[1000]).toBeCloseTo(0.4, 6);
  });

  it('repeats the repeat one delay later again, scaled by the feedback', () => {
    expect(applyEffect(impulse(4000), effect).left[2000]).toBeCloseTo(0.2, 6);
  });

  it.each([nextAfter(1, -1), nextAfter(-1, 1)])(
    'renders finite at a feedback of %s',
    (feedback) => {
      expect(isAllFinite(applyEffect(impulse(4000), { ...effect, feedback }))).toBe(true);
    }
  );

  it('renders a one-sample delay', () => {
    expect(applyEffect(impulse(8), { ...effect, samples: 1 }).left[1]).toBeCloseTo(0.4, 6);
  });
});

describe('applyEffect: saturation', () => {
  it('leaves a quiet signal at its level', () => {
    const input = stereo(sine({ frequency: 440, samples: 4800 }).map((sample) => sample * 0.001));
    const output = applyEffect(input, { kind: 'saturation', drive: 4 });
    expect(
      peak(output.left.subarray(256, 4544)) / peak(input.left.subarray(256, 4544))
    ).toBeCloseTo(1, 3);
  });

  it('rounds a loud signal off towards 1 / drive', () => {
    const output = applyEffect(tone(440), { kind: 'saturation', drive: 8 });
    expect(peak(output.left.subarray(256, 4544))).toBeCloseTo(Math.tanh(4) / 8, 2);
  });

  it.each([0.5, 8])('renders finite at a drive of %s', (drive) => {
    expect(isAllFinite(applyEffect(tone(440), { kind: 'saturation', drive }))).toBe(true);
  });
});

describe('applyEffect: filter', () => {
  const window = { from: 2400, length: 2400 };

  it('low-passes: 10 kHz falls more than 20 dB under a 1 kHz corner', () => {
    const input = tone(10_000);
    const output = applyEffect(input, {
      kind: 'filter',
      mode: 'lowpass',
      cutoff: 1000,
      resonance: 0,
    });
    const ratio =
      goertzelPower(output.left, 10_000, window) / goertzelPower(input.left, 10_000, window);
    expect(10 * Math.log10(ratio)).toBeLessThan(-20);
  });

  it('high-passes: 10 kHz passes a 1 kHz corner within 0.1 dB', () => {
    const input = tone(10_000);
    const output = applyEffect(input, {
      kind: 'filter',
      mode: 'highpass',
      cutoff: 1000,
      resonance: 0,
    });
    const ratio =
      goertzelPower(output.right, 10_000, window) / goertzelPower(input.right, 10_000, window);
    expect(Math.abs(10 * Math.log10(ratio))).toBeLessThan(0.1);
  });

  it.each([
    { cutoff: 0, resonance: 0 },
    { cutoff: nextAfter(SAMPLE_RATE / 2, -1), resonance: nextAfter(1, -1) },
  ])('renders finite at the edge of its settings: %j', (settings) => {
    expect(
      isAllFinite(applyEffect(tone(440), { kind: 'filter', mode: 'bandpass', ...settings }))
    ).toBe(true);
  });
});

describe('applyEffect: stutter', () => {
  const from = 1000;
  const sliceSamples = 400;
  const effect: ResolvedEffect = { kind: 'stutter', from, sliceSamples, repeats: 3 };
  const end = from + 3 * sliceSamples;

  it('leaves everything before the cue as it was', () => {
    const input = ramp(4000);
    expect([...applyEffect(input, effect).left.subarray(0, from)]).toEqual([
      ...input.left.subarray(0, from),
    ]);
  });

  it('keeps the slice’s own onset: the first sample of the slice is untouched', () => {
    const input = ramp(4000);
    expect(applyEffect(input, effect).left[from]).toBe(input.left[from]);
  });

  it('repeats the slice after itself, the middle of every repeat a copy of the slice', () => {
    const input = ramp(4000);
    const output = applyEffect(input, effect);
    for (const repeat of [1, 2]) {
      const middle = from + repeat * sliceSamples + sliceSamples / 2;
      expect(output.right[middle]).toBe(input.right[from + sliceSamples / 2]);
    }
  });

  it('fades each repeat in from silence', () => {
    expect(applyEffect(ramp(4000), effect).left[from + sliceSamples]).toBe(0);
  });

  it('resumes the signal where the repeats end, faded in', () => {
    const input = ramp(4000);
    const output = applyEffect(input, effect);
    expect(output.left[end]).toBe(0);
    expect(output.left[end + STUTTER_FADE]).toBe(input.left[end + STUTTER_FADE]);
  });

  it('stutters a slice of one sample', () => {
    const output = applyEffect(ramp(100), {
      kind: 'stutter',
      from: 10,
      sliceSamples: 1,
      repeats: 4,
    });
    expect(isAllFinite(output)).toBe(true);
  });

  it('keeps a stutter that ends with the signal inside it', () => {
    const output = applyEffect(ramp(2200), effect);
    expect(output.left).toHaveLength(2200);
    expect(isAllFinite(output)).toBe(true);
  });
});

describe('applyEffect: tape stop', () => {
  const from = 4800;
  const samples = SAMPLE_RATE / 2;
  const effect: ResolvedEffect = { kind: 'tapeStop', from, samples };
  const input = (): StereoBuffer => tone(440, from + samples + 4800);

  it('leaves everything before and after it as it was', () => {
    const source = input();
    const output = applyEffect(source, effect);
    expect([...output.left.subarray(0, from)]).toEqual([...source.left.subarray(0, from)]);
    expect([...output.left.subarray(from + samples)]).toEqual([
      ...source.left.subarray(from + samples),
    ]);
  });

  it('starts at full speed where the cue falls', () => {
    const source = input();
    // Within 2% of the tone's level at its steepest: the low-pass lags a fraction of a sample at full speed.
    expect(
      Math.abs(
        (applyEffect(source, effect).left[from] ?? Number.NaN) - (source.left[from] ?? Number.NaN)
      )
    ).toBeLessThan(0.01);
  });

  it('meets the signal without a step where it starts', () => {
    // A quarter cycle of 440 Hz after the cue's frame, where the tone is near its crest.
    const crest = from + Math.round(SAMPLE_RATE / 440 / 4);
    const source = input();
    const output = applyEffect(source, { kind: 'tapeStop', from: crest, samples });
    expect(
      Math.abs((output.left[crest] ?? Number.NaN) - (source.left[crest] ?? Number.NaN))
    ).toBeLessThan(0.01);
  });

  it('darkens as it slows: its low-pass keeps the band above the slowed spectrum more than 55 dB under it', () => {
    const noise = whiteNoise(from + samples + 4800, rand('tape-stop')).map(
      (sample) => sample * 0.5
    );
    const slowed = applyEffect({ left: noise, right: Float32Array.from(noise) }, effect).left;
    const length = SAMPLE_RATE / 20;
    for (const progress of [0.3, 0.5]) {
      // Hann-windowed, so the low band's leakage does not stand in for the high band.
      const start = from + Math.round(progress * samples);
      const windowed = slowed
        .slice(start, start + length)
        .map((sample, index) => sample * (0.5 - 0.5 * Math.cos((2 * Math.PI * index) / length)));
      // The read runs at (1 − u)² of full speed, so the source's spectrum ends that far down.
      const edge = (SAMPLE_RATE / 2) * (1 - progress) ** 2;
      const window = { from: 0, length };
      const below = bandPower(windowed, { low: 0, high: edge / 2 }, window);
      const above = bandPower(windowed, { low: 1.5 * edge, high: 23_000 }, window);
      expect(10 * Math.log10(above / below)).toBeLessThan(-55);
    }
  });

  it('winds down to silence by its end', () => {
    expect(
      Math.abs(applyEffect(input(), effect).right[from + samples - 1] ?? Number.NaN)
    ).toBeLessThan(1e-4);
  });

  it('falls in pitch: the second half crosses zero far fewer times than the first', () => {
    const slowed = applyEffect(input(), effect).left.subarray(from, from + samples);
    const first = risingCrossings(slowed.subarray(0, samples / 2));
    const second = risingCrossings(slowed.subarray(samples / 2));
    expect(second).toBeLessThan(first / 2);
  });

  it('reads silence before the signal’s start when it stops from the first sample', () => {
    const output = applyEffect(input(), { kind: 'tapeStop', from: 0, samples: 4800 });
    expect(isAllFinite(output)).toBe(true);
    expect(output.left[0]).toBe(input().left[0]);
  });

  it('stops over a single sample', () => {
    expect(isAllFinite(applyEffect(input(), { kind: 'tapeStop', from, samples: 1 }))).toBe(true);
  });
});
