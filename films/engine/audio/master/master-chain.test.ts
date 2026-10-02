import { describe, expect, it } from 'vitest';

import { measureLoudness, truePeakDbtp } from '../../analyze/index.js';
import { rand } from '../../rand/rand.js';
import { SAMPLE_RATE } from '../../time/grid.js';
import { createStereo, exponentialDecay, pinkNoise, sine } from '../dsp/index.js';
import { goertzelPower } from '../dsp/dsp-test-support.js';

import {
  DEFAULT_CEILING_DBTP,
  DEFAULT_TARGET_LUFS,
  masterChain,
  subsonicHighPass,
} from './master-chain.js';

import type { StereoBuffer } from '../dsp/index.js';

/**
 * Four seconds of a groove's worth of dynamics: a decaying 55 Hz thump every
 * half second over a quiet 440 Hz tone and pink noise, the channels differing
 * only in their noise.
 */
function groove(): StereoBuffer {
  const samples = 4 * SAMPLE_RATE;
  const beat = SAMPLE_RATE / 2;
  const decay = exponentialDecay({ samples: beat, t60: 0.4 });
  const thump = sine({ frequency: 55, samples: beat }).map(
    (sample, index) => sample * (decay[index] ?? 0)
  );
  const tone = sine({ frequency: 440, samples });
  const channel = (key: string): Float32Array => {
    const noise = pinkNoise(samples, rand(key));
    return tone.map(
      (sample, index) =>
        0.05 * sample + 0.3 * (noise[index] ?? 0) + 0.4 * (thump[index % beat] ?? 0)
    );
  };
  return { left: channel('left'), right: channel('right') };
}

function scaled(buffer: StereoBuffer, gain: number): StereoBuffer {
  return {
    left: buffer.left.map((sample) => sample * gain),
    right: buffer.right.map((sample) => sample * gain),
  };
}

const DEFAULTS = { targetLufs: DEFAULT_TARGET_LUFS, ceilingDbtp: DEFAULT_CEILING_DBTP };

let grooveMaster: StereoBuffer | undefined;

/** The groove through the chain at the delivery targets, rendered once and shared. */
function masteredGroove(): StereoBuffer {
  grooveMaster ??= masterChain(groove(), DEFAULTS);
  return grooveMaster;
}

describe('masterChain', () => {
  it('brings the mix to the target loudness within 0.05 LU', () => {
    const master = masteredGroove();
    expect(
      Math.abs(measureLoudness(master).integratedLufs - DEFAULT_TARGET_LUFS)
    ).toBeLessThanOrEqual(0.05);
  });

  it('holds the true peak under the ceiling', () => {
    expect(truePeakDbtp(masteredGroove())).toBeLessThanOrEqual(DEFAULT_CEILING_DBTP);
  });

  it('holds the true peak under the ceiling where the limiter’s own estimate reads it low', () => {
    // Near Nyquist the limiter's short interpolator reads peaks lowest; the meter corrects it.
    const mix = groove();
    const hiss = sine({ frequency: 22_000, samples: mix.left.length });
    const bright = {
      left: mix.left.map((sample, index) => sample + 0.3 * (hiss[index] ?? 0)),
      right: mix.right.map((sample, index) => sample + 0.3 * (hiss[index] ?? 0)),
    };
    const master = masterChain(bright, DEFAULTS);
    expect(truePeakDbtp(master)).toBeLessThanOrEqual(DEFAULT_CEILING_DBTP);
    expect(
      Math.abs(measureLoudness(master).integratedLufs - DEFAULT_TARGET_LUFS)
    ).toBeLessThanOrEqual(0.05);
  });

  it('reaches another target under another ceiling', () => {
    const master = masterChain(groove(), { targetLufs: -20, ceilingDbtp: -3 });
    expect(Math.abs(measureLoudness(master).integratedLufs + 20)).toBeLessThanOrEqual(0.05);
    expect(truePeakDbtp(master)).toBeLessThanOrEqual(-3);
  });

  it('lands a target that takes heavy limiting, where a dB of gain buys a tenth of a dB of loudness', () => {
    const beat = SAMPLE_RATE / 2;
    const decay = exponentialDecay({ samples: beat, t60: 0.4 });
    const thump = sine({ frequency: 55, samples: beat }).map(
      (sample, index) => 0.4 * sample * (decay[index] ?? 0)
    );
    const channel = Float32Array.from(
      { length: 4 * SAMPLE_RATE },
      (_, index) => thump[index % beat] ?? 0
    );
    const master = masterChain(
      { left: channel, right: Float32Array.from(channel) },
      { targetLufs: -6, ceilingDbtp: -1 }
    );
    expect(Math.abs(measureLoudness(master).integratedLufs + 6)).toBeLessThanOrEqual(0.05);
    expect(truePeakDbtp(master)).toBeLessThanOrEqual(-1);
  });

  it('lands on the same master whatever the mix’s own level', () => {
    const quiet = masterChain(scaled(groove(), 0.01), DEFAULTS);
    const loud = masterChain(scaled(groove(), 4), DEFAULTS);
    expect(
      Math.abs(measureLoudness(quiet).integratedLufs - measureLoudness(loud).integratedLufs)
    ).toBeLessThanOrEqual(0.1);
  });

  it('keeps the mix’s length', () => {
    expect(masteredGroove().left).toHaveLength(4 * SAMPLE_RATE);
  });

  it('renders the same bits from the same mix', () => {
    const first = masteredGroove();
    const second = masterChain(groove(), DEFAULTS);
    expect([...first.left]).toEqual([...second.left]);
    expect([...first.right]).toEqual([...second.right]);
  });

  it('refuses a target it cannot reach under the ceiling, naming what it reached', () => {
    expect(() => masterChain(groove(), { targetLufs: -3, ceilingDbtp: -6 })).toThrow(
      /reached -?\d+(\.\d+)? LUFS at -?\d+(\.\d+)? dBTP .* cannot hold -3 LUFS ±0\.05 under -6 dBTP/
    );
  });

  it('refuses a silent mix', () => {
    expect(() => masterChain(createStereo(SAMPLE_RATE), DEFAULTS)).toThrow(
      /no measurable loudness/
    );
  });

  it('refuses a mix shorter than one loudness block', () => {
    const short = groove();
    const cut = {
      left: short.left.slice(0, SAMPLE_RATE / 10),
      right: short.right.slice(0, SAMPLE_RATE / 10),
    };
    expect(() => masterChain(cut, DEFAULTS)).toThrow(/no measurable loudness/);
  });

  it.each([
    ['targetLufs', { targetLufs: Number.NaN, ceilingDbtp: DEFAULT_CEILING_DBTP }],
    ['targetLufs', { targetLufs: Number.NEGATIVE_INFINITY, ceilingDbtp: DEFAULT_CEILING_DBTP }],
    ['ceilingDbtp', { targetLufs: DEFAULT_TARGET_LUFS, ceilingDbtp: Number.NaN }],
    ['ceilingDbtp', { targetLufs: DEFAULT_TARGET_LUFS, ceilingDbtp: Number.POSITIVE_INFINITY }],
  ])('refuses a %s that is not a finite number', (name, options) => {
    expect(() => masterChain(groove(), options)).toThrow(
      new RegExp(`${name} must be a finite number`)
    );
  });
});

function both(channel: Float32Array): StereoBuffer {
  return { left: channel, right: Float32Array.from(channel) };
}

/** The power of one frequency over `length` samples from `from`, in dB relative to another's. */
function relativeDb(
  signal: Float32Array,
  [frequency, reference]: readonly [number, number],
  window: { from: number; length: number }
): number {
  return (
    10 *
    Math.log10(goertzelPower(signal, frequency, window) / goertzelPower(signal, reference, window))
  );
}

function peakBetween(signal: Float32Array, from: number, to: number): number {
  let peak = 0;
  for (const sample of signal.subarray(from, to)) {
    peak = Math.max(peak, Math.abs(sample));
  }
  return peak;
}

describe('masterChain: each stage, heard through the whole chain', () => {
  /**
   * Low enough that the limiter never engages, so a change in level between
   * two parts of the master is the high-pass's, the compressor's or the soft
   * clip's doing.
   */
  const QUIET = { targetLufs: -30, ceilingDbtp: DEFAULT_CEILING_DBTP };

  it('removes sub-audio energy: 10 Hz comes out more than 12 dB lower against 440 Hz than it went in', () => {
    const samples = 3 * SAMPLE_RATE;
    const low = sine({ frequency: 10, samples });
    const channel = sine({ frequency: 440, samples }).map(
      (sample, index) => 0.1 * sample + 0.3 * (low[index] ?? 0)
    );
    // One second: a whole number of cycles of both tones.
    const window = { from: SAMPLE_RATE, length: SAMPLE_RATE };
    const before = relativeDb(channel, [10, 440], window);
    const after = relativeDb(masterChain(both(channel), QUIET).left, [10, 440], window);
    expect(after - before).toBeLessThan(-12);
  });

  it('turns a loud passage down: a second 9 dB over the rest comes out at least 1.5 dB less than 9 dB over it', () => {
    const quietFor = 6 * SAMPLE_RATE;
    const loud = 10 ** (9 / 20);
    const channel = sine({ frequency: 440, samples: quietFor + SAMPLE_RATE }).map(
      (sample, index) => 0.05 * sample * (index < quietFor ? 1 : loud)
    );
    // 0.1 s windows hold whole cycles of 440 Hz; the loud one starts after the attack has settled.
    const length = SAMPLE_RATE / 10;
    const levelOf = (signal: Float32Array, from: number): number =>
      goertzelPower(signal, 440, { from, length });
    const rise = (signal: Float32Array): number =>
      10 * Math.log10(levelOf(signal, quietFor + SAMPLE_RATE / 2) / levelOf(signal, quietFor / 2));
    expect(rise(channel) - rise(masterChain(both(channel), QUIET).left)).toBeGreaterThan(1.5);
  });

  it('shapes a lone peak below where it was: one loud cycle comes out at least 0.5 dB lower against the tone', () => {
    const at = 2 * SAMPLE_RATE;
    const cycle = SAMPLE_RATE / 1000;
    const channel = sine({ frequency: 1000, samples: 3 * SAMPLE_RATE }).map(
      (sample, index) => sample * (index >= at && index < at + cycle ? 1 : 0.1)
    );
    const standOut = (signal: Float32Array): number =>
      20 *
      Math.log10(
        peakBetween(signal, at, at + cycle) /
          peakBetween(signal, SAMPLE_RATE, SAMPLE_RATE + SAMPLE_RATE / 10)
      );
    expect(standOut(channel) - standOut(masterChain(both(channel), QUIET).left)).toBeGreaterThan(
      0.5
    );
  });
});

describe('subsonicHighPass', () => {
  /** 1 s: a whole number of cycles of both tones. */
  const window = { from: SAMPLE_RATE, length: SAMPLE_RATE };

  function twoTones(): StereoBuffer {
    const low = sine({ frequency: 10, samples: 2 * SAMPLE_RATE });
    const high = sine({ frequency: 1000, samples: 2 * SAMPLE_RATE });
    const channel = low.map((sample, index) => 0.5 * sample + 0.5 * (high[index] ?? 0));
    return { left: channel, right: Float32Array.from(channel) };
  }

  it('takes more than 12 dB off 10 Hz', () => {
    const input = twoTones();
    const output = subsonicHighPass(input);
    const ratio = goertzelPower(output.left, 10, window) / goertzelPower(input.left, 10, window);
    expect(10 * Math.log10(ratio)).toBeLessThan(-12);
  });

  it('passes 1 kHz within 0.01 dB', () => {
    const input = twoTones();
    const output = subsonicHighPass(input);
    const ratio =
      goertzelPower(output.right, 1000, window) / goertzelPower(input.right, 1000, window);
    expect(Math.abs(10 * Math.log10(ratio))).toBeLessThan(0.01);
  });
});
