import { describe, expect, it } from 'vitest';

import { dbToAmplitude } from '../analyze/index.js';
import { createStereo } from '../audio/dsp/index.js';
import { frameToSample } from '../time/grid.js';

import { STEM_PEAK_DBFS, analysisCues, scaleStereo, stemGain } from './score-products.js';

import type { StereoBuffer } from '../audio/dsp/index.js';

/** A four-sample stereo buffer with one sample of `level` on the left channel. */
function peaking(level: number): StereoBuffer {
  const buffer = createStereo(4);
  buffer.left[1] = level;
  return buffer;
}

function peakOf(buffer: StereoBuffer): number {
  return Math.max(...[...buffer.left, ...buffer.right].map((sample) => Math.abs(sample)));
}

describe('stemGain', () => {
  it("brings the loudest stem's sample peak to the stem peak level", () => {
    const { gain } = stemGain({ kick: peaking(0.5), hat: peaking(0.25) });

    expect(peakOf(scaleStereo(peaking(0.5), gain))).toBeCloseTo(dbToAmplitude(STEM_PEAK_DBFS), 6);
  });

  it('peaks the stems at −1 dBFS', () => {
    expect(STEM_PEAK_DBFS).toBe(-1);
  });

  it('reads a negative sample as a peak', () => {
    expect(stemGain({ kick: peaking(-0.5) }).gain).toBeCloseTo(
      dbToAmplitude(STEM_PEAK_DBFS) / 0.5,
      12
    );
  });

  it('brings down a stem that passes full scale', () => {
    expect(stemGain({ kick: peaking(2) }).gain).toBeLessThan(1);
  });

  it('reads the right channel too', () => {
    const buffer = createStereo(4);
    buffer.right[2] = 0.5;

    expect(stemGain({ kick: buffer }).gain).toBeCloseTo(dbToAmplitude(STEM_PEAK_DBFS) / 0.5, 12);
  });

  it('names the loudest stem', () => {
    expect(stemGain({ kick: peaking(0.25), snare: peaking(0.5) }).loudest).toBe('snare');
  });

  it('leaves silent stems at unity gain', () => {
    expect(stemGain({ kick: createStereo(4) })).toEqual({ gain: 1, loudest: null });
  });

  it('is unity for a score with no stems', () => {
    expect(stemGain({})).toEqual({ gain: 1, loudest: null });
  });
});

describe('scaleStereo', () => {
  it('scales both channels by the gain', () => {
    const buffer = createStereo(2);
    buffer.left[0] = 0.5;
    buffer.right[1] = -0.25;

    const scaled = scaleStereo(buffer, 2);

    expect([...scaled.left, ...scaled.right]).toEqual([1, 0, 0, -0.5]);
  });

  it('leaves its input unchanged', () => {
    const buffer = peaking(0.5);
    scaleStereo(buffer, 2);

    expect(buffer.left[1]).toBe(0.5);
  });
});

describe('analysisCues', () => {
  it("puts each cue on its frame's first sample", () => {
    expect(
      analysisCues([
        { id: 'downbeat', from: 0 },
        { id: 'slam', from: 24 },
      ])
    ).toEqual([
      { id: 'downbeat', sample: 0 },
      { id: 'slam', sample: frameToSample(24) },
    ]);
  });
});
