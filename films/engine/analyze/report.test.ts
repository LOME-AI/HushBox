import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { SAMPLE_RATE } from '../time/grid.js';
import { sin } from '../dmath/dmath.js';

import { MOMENTARY_WINDOW, measureLoudness } from './loudness.js';
import { ONSET_HOP } from './onsets.js';
import { audioReport } from './report.js';
import { truePeakDbtp } from './true-peak.js';

import type { StereoBuffer } from '../audio/dsp/index.js';
import type { CueReport } from './report.js';

const CUE_SAMPLE = 2 * SAMPLE_RATE;
/** 440 Hz completes exactly 11 cycles in 1/40 s, so wrapping the index there keeps the phase small. */
const TONE_WRAP = SAMPLE_RATE / 40;

/** A −40 dBFS 440 Hz bed for two seconds, then a −20 dBFS 440 Hz tone for two more, built with `dmath`. */
function bedThenTone(): StereoBuffer {
  const channel = Float32Array.from({ length: 4 * SAMPLE_RATE }, (_, index) => {
    const gain = index < CUE_SAMPLE ? 0.01 : 0.1;
    return gain * sin((2 * Math.PI * 440 * (index % TONE_WRAP)) / SAMPLE_RATE);
  });
  return { left: channel, right: Float32Array.from(channel) };
}

function silence(length: number): StereoBuffer {
  return { left: new Float32Array(length), right: new Float32Array(length) };
}

describe('audioReport', () => {
  const signal = bedThenTone();
  const report = audioReport(signal, [
    { id: 'start', sample: 0 },
    { id: 'swell', sample: CUE_SAMPLE },
  ]);
  const swell = report.cues.find(({ id }) => id === 'swell');

  it('survives a JSON round trip unchanged', () => {
    const json = JSON.stringify(report);
    expect(JSON.parse(json)).toEqual(report);
  });

  it('states the signal length in samples and seconds', () => {
    expect([report.samples, report.seconds]).toEqual([4 * SAMPLE_RATE, 4]);
  });

  it('carries the loudness meter figures', () => {
    expect(report.loudness).toEqual(measureLoudness(signal));
  });

  it('carries the true peak', () => {
    expect(report.truePeakDbtp).toBe(truePeakDbtp(signal));
  });

  it('carries the sample peak, clip count and DC offset', () => {
    expect(report.samplePeakDbfs).toBeCloseTo(-20, 2);
    expect(report.clipCount).toBe(0);
    expect(Math.abs(report.dcOffset.left)).toBeLessThan(1e-4);
  });

  it('carries both correlations', () => {
    expect(report.stereoCorrelation).toBeCloseTo(1, 12);
    expect(report.lowBandCorrelation).toBeCloseTo(1, 12);
  });

  it('carries one octave band per centre', () => {
    expect(report.octaveBands).toHaveLength(10);
  });

  it('finds the onset nearest a cue after an earlier onset', () => {
    expect(swell?.nearestOnsetSample).toBeGreaterThan(CUE_SAMPLE - 2 * ONSET_HOP);
    expect(swell?.nearestOnsetSample).toBeLessThanOrEqual(CUE_SAMPLE);
  });

  it('finds the onset nearest a cue before a later onset', () => {
    expect(report.cues[0]?.nearestOnsetSample).toBe(0);
  });

  it('reads the momentary loudness on each side of a cue', () => {
    expect(swell?.momentaryBeforeLufs).toBeCloseTo(-40.7, 0);
    expect(swell?.momentaryAfterLufs).toBeCloseTo(-20.7, 0);
  });

  it('matches the pinned digest of its JSON, bit for bit', () => {
    expect(createHash('sha256').update(JSON.stringify(report)).digest('hex')).toBe(
      '70f591af086945c25bdd20f4ccfbd5e49ff36583574f442d5817bcf4e26ca9c0'
    );
  });
});

describe('audioReport of digital silence', () => {
  const report = audioReport(silence(SAMPLE_RATE), []);

  it('writes every level of silence as null', () => {
    expect([
      report.loudness.integratedLufs,
      report.loudness.maxMomentaryLufs,
      report.loudness.maxShortTermLufs,
      report.truePeakDbtp,
      report.samplePeakDbfs,
      report.stereoCorrelation,
      report.lowBandCorrelation,
      ...report.octaveBands.map(({ levelDb }) => levelDb),
    ]).toEqual(Array.from({ length: 17 }, () => null));
  });

  it('survives a JSON round trip unchanged', () => {
    const json = JSON.stringify(report);
    expect(JSON.parse(json)).toEqual(report);
  });
});

describe('audioReport cue windows', () => {
  const signal = bedThenTone();
  const oneSecond = {
    left: signal.left.subarray(0, SAMPLE_RATE),
    right: signal.right.subarray(0, SAMPLE_RATE),
  };
  const length = SAMPLE_RATE;

  function cueAt(sample: number): CueReport | undefined {
    return audioReport(oneSecond, [{ id: 'cue', sample }]).cues[0];
  }

  it('measures the window before a cue that starts 400 ms in', () => {
    expect(cueAt(MOMENTARY_WINDOW)?.momentaryBeforeLufs).not.toBeNull();
  });

  it('has no window before a cue one sample earlier', () => {
    expect(cueAt(MOMENTARY_WINDOW - 1)?.momentaryBeforeLufs).toBeNull();
  });

  it('measures the window after a cue 400 ms before the end', () => {
    expect(cueAt(length - MOMENTARY_WINDOW)?.momentaryAfterLufs).not.toBeNull();
  });

  it('has no window after a cue one sample later', () => {
    expect(cueAt(length - MOMENTARY_WINDOW + 1)?.momentaryAfterLufs).toBeNull();
  });

  it('has no nearest onset when the signal has none', () => {
    expect(
      audioReport(silence(SAMPLE_RATE), [{ id: 'cue', sample: 0 }]).cues[0]?.nearestOnsetSample
    ).toBeNull();
  });

  it('refuses a cue one sample past the end', () => {
    expect(() => audioReport(oneSecond, [{ id: 'late', sample: length + 1 }])).toThrow(/late/);
  });
});
