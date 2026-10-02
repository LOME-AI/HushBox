import { describe, expect, it } from 'vitest';

import { SAMPLE_RATE } from '../time/grid.js';
import { kWeightStereo } from './k-weighting.js';
import {
  ABSOLUTE_GATE_POWER,
  MOMENTARY_WINDOW,
  SHORT_TERM_WINDOW,
  blockLoudness,
  gatedLoudness,
  measureLoudness,
  momentaryLufsAt,
} from './loudness.js';

import type { StereoBuffer } from '../audio/dsp/index.js';

/** Samples in one cycle of the 1 kHz test tone. */
const TONE_PERIOD = SAMPLE_RATE / 1000;

/** A segment of an EBU Tech 3341 test signal: a sine level in dBFS held for a duration. */
type Segment = readonly [dbfs: number, seconds: number];

/** A 1 kHz stereo sine whose peak steps through the segments with a continuous phase. */
function steppedTone(segments: readonly Segment[]): StereoBuffer {
  const lengths = segments.map(([, seconds]) => Math.round(seconds * SAMPLE_RATE));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  const channel = new Float32Array(total);
  let index = 0;
  for (const [position, [dbfs]] of segments.entries()) {
    const amplitude = Math.pow(10, dbfs / 20);
    const end = index + (lengths[position] ?? 0);
    for (; index < end; index += 1) {
      channel[index] = amplitude * Math.sin((2 * Math.PI * (index % TONE_PERIOD)) / TONE_PERIOD);
    }
  }
  return { left: channel, right: Float32Array.from(channel) };
}

/** The next double above a positive finite value. */
function nextUp(value: number): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  view.setBigUint64(0, view.getBigUint64(0) + 1n);
  return view.getFloat64(0);
}

interface EbuCase {
  readonly name: string;
  readonly segments: readonly Segment[];
  readonly expectedLufs: number;
}

// EBU Tech 3341, Table 1, cases 1–5: 1 kHz stereo sines, peak level in dBFS.
const CASE_1: EbuCase = {
  name: 'case 1: −23 dBFS for 20 s',
  segments: [[-23, 20]],
  expectedLufs: -23,
};
const CASE_2: EbuCase = {
  name: 'case 2: −33 dBFS for 20 s',
  segments: [[-33, 20]],
  expectedLufs: -33,
};
const CASE_3: EbuCase = {
  name: 'case 3: −36/−23/−36 dBFS for 10/60/10 s',
  segments: [
    [-36, 10],
    [-23, 60],
    [-36, 10],
  ],
  expectedLufs: -23,
};
const CASE_4: EbuCase = {
  name: 'case 4: −72/−36/−23/−36/−72 dBFS for 10/10/60/10/10 s',
  segments: [
    [-72, 10],
    [-36, 10],
    [-23, 60],
    [-36, 10],
    [-72, 10],
  ],
  expectedLufs: -23,
};
const CASE_5: EbuCase = {
  name: 'case 5: −26/−20/−26 dBFS for 20/20.1/20 s',
  segments: [
    [-26, 20],
    [-20, 20.1],
    [-26, 20],
  ],
  expectedLufs: -23,
};

describe('measureLoudness on EBU Tech 3341 test signals', () => {
  it.each([CASE_1, CASE_2, CASE_3, CASE_4, CASE_5])(
    'measures $name within 0.1 LU of its expected integrated loudness',
    ({ segments, expectedLufs }) => {
      const { integratedLufs } = measureLoudness(steppedTone(segments));
      expect(Math.abs(integratedLufs - expectedLufs)).toBeLessThanOrEqual(0.1);
    }
  );
});

describe('measureLoudness maxima', () => {
  it('reads the maximum momentary loudness of the loudest 400 ms', () => {
    const { maxMomentaryLufs } = measureLoudness(steppedTone(CASE_5.segments));
    expect(maxMomentaryLufs).toBeCloseTo(-20, 1);
  });

  it('reads the maximum short-term loudness of the loudest 3 s', () => {
    const { maxShortTermLufs } = measureLoudness(steppedTone(CASE_5.segments));
    expect(maxShortTermLufs).toBeCloseTo(-20, 1);
  });

  it('reads −Infinity for every figure of digital silence', () => {
    const silent = {
      left: new Float32Array(SAMPLE_RATE * 4),
      right: new Float32Array(SAMPLE_RATE * 4),
    };
    expect(measureLoudness(silent)).toEqual({
      integratedLufs: Number.NEGATIVE_INFINITY,
      maxMomentaryLufs: Number.NEGATIVE_INFINITY,
      maxShortTermLufs: Number.NEGATIVE_INFINITY,
    });
  });
});

describe('measureLoudness window bounds', () => {
  it('spans 400 ms momentary and 3 s short-term windows', () => {
    expect([MOMENTARY_WINDOW, SHORT_TERM_WINDOW]).toEqual([19_200, 144_000]);
  });

  it('measures a momentary block in a signal exactly 400 ms long', () => {
    const tone = steppedTone([[-23, MOMENTARY_WINDOW / SAMPLE_RATE]]);
    expect(measureLoudness(tone).maxMomentaryLufs).toBeCloseTo(-23, 0);
  });

  it('measures no momentary block in a signal one sample shorter than 400 ms', () => {
    const tone = steppedTone([[-23, (MOMENTARY_WINDOW - 1) / SAMPLE_RATE]]);
    expect(measureLoudness(tone).maxMomentaryLufs).toBe(Number.NEGATIVE_INFINITY);
  });

  it('integrates nothing from a signal one sample shorter than 400 ms', () => {
    const tone = steppedTone([[-23, (MOMENTARY_WINDOW - 1) / SAMPLE_RATE]]);
    expect(measureLoudness(tone).integratedLufs).toBe(Number.NEGATIVE_INFINITY);
  });

  it('measures a short-term window in a signal exactly 3 s long', () => {
    const tone = steppedTone([[-23, SHORT_TERM_WINDOW / SAMPLE_RATE]]);
    expect(measureLoudness(tone).maxShortTermLufs).toBeCloseTo(-23, 0);
  });

  it('measures no short-term window in a signal one sample shorter than 3 s', () => {
    const tone = steppedTone([[-23, (SHORT_TERM_WINDOW - 1) / SAMPLE_RATE]]);
    expect(measureLoudness(tone).maxShortTermLufs).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe('gatedLoudness', () => {
  it('sets the absolute gate at −70 LKFS', () => {
    expect(blockLoudness(ABSOLUTE_GATE_POWER)).toBeCloseTo(-70, 12);
  });

  it('drops a block exactly at the absolute gate', () => {
    expect(gatedLoudness(Float64Array.of(ABSOLUTE_GATE_POWER))).toBe(Number.NEGATIVE_INFINITY);
  });

  it('keeps a block one ulp above the absolute gate', () => {
    const power = nextUp(ABSOLUTE_GATE_POWER);
    expect(gatedLoudness(Float64Array.of(power))).toBe(blockLoudness(power));
  });

  it('drops a block exactly 10 LU below the mean of the blocks the absolute gate kept', () => {
    // Mean (19 + 1)/2 · 2^−10, so the relative gate sits at exactly 2^−10.
    const quiet = 2 ** -10;
    const loud = 19 * quiet;
    expect(gatedLoudness(Float64Array.of(loud, quiet))).toBe(blockLoudness(loud));
  });

  it('keeps a block one ulp above the relative gate', () => {
    const quiet = nextUp(2 ** -10);
    const loud = 19 * 2 ** -10;
    expect(gatedLoudness(Float64Array.of(loud, quiet))).toBe(blockLoudness((loud + quiet) / 2));
  });

  it('reads −Infinity when no blocks are given', () => {
    expect(gatedLoudness(new Float64Array(0))).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe('momentaryLufsAt', () => {
  const tone = steppedTone([[-23, 1]]);
  const weighted = kWeightStereo(tone);

  it('measures the 400 ms window starting on the first sample', () => {
    expect(momentaryLufsAt(weighted, 0)).toBeCloseTo(-23, 0);
  });

  it('refuses a window starting one sample before the signal', () => {
    expect(() => momentaryLufsAt(weighted, -1)).toThrow(/-1/);
  });

  it('measures the 400 ms window ending on the last sample', () => {
    expect(momentaryLufsAt(weighted, SAMPLE_RATE - MOMENTARY_WINDOW)).toBeCloseTo(-23, 1);
  });

  it('refuses a window ending one sample past the signal', () => {
    expect(() => momentaryLufsAt(weighted, SAMPLE_RATE - MOMENTARY_WINDOW + 1)).toThrow(/28801/);
  });

  it('refuses a window starting between samples', () => {
    expect(() => momentaryLufsAt(weighted, 0.5)).toThrow(/0\.5/);
  });
});
