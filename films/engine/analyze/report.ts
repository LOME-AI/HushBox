import { SAMPLE_RATE } from '../time/grid.js';

import { lowBandCorrelation, stereoCorrelation } from './correlation.js';
import { kWeightStereo } from './k-weighting.js';
import { clipCount, dcOffset, samplePeakDbfs } from './levels.js';
import { MOMENTARY_WINDOW, measureLoudness, momentaryLufsAt } from './loudness.js';
import { octaveBandBalance } from './octave-bands.js';
import { spectralFluxOnsets } from './onsets.js';
import { requireCueSample, requireStereo } from './signal.js';
import { truePeakDbtp } from './true-peak.js';

import type { StereoBuffer } from '../audio/dsp/index.js';
import type { WeightedStereo } from './k-weighting.js';
import type { ChannelMeans } from './levels.js';
import type { AnalysisCue } from './signal.js';

/** A cue with the onset nearest it and the momentary loudness of the 400 ms on either side of it. */
export interface CueReport {
  readonly id: string;
  readonly sample: number;
  /** null when the signal has no onsets. */
  readonly nearestOnsetSample: number | null;
  /** null when the cue is less than 400 ms from the signal's start, or the window is silent. */
  readonly momentaryBeforeLufs: number | null;
  /** null when the cue is less than 400 ms from the signal's end, or the window is silent. */
  readonly momentaryAfterLufs: number | null;
}

/**
 * Every measurement of a signal as plain JSON. A level of silence, which the
 * measurements read as −Infinity, is written null, as is an undefined correlation.
 */
export interface AudioReport {
  readonly samples: number;
  readonly seconds: number;
  readonly loudness: {
    readonly integratedLufs: number | null;
    readonly maxMomentaryLufs: number | null;
    readonly maxShortTermLufs: number | null;
  };
  readonly truePeakDbtp: number | null;
  readonly samplePeakDbfs: number | null;
  readonly clipCount: number;
  readonly dcOffset: ChannelMeans;
  readonly stereoCorrelation: number | null;
  readonly lowBandCorrelation: number | null;
  readonly octaveBands: readonly { readonly centerHz: number; readonly levelDb: number | null }[];
  readonly onsetSamples: readonly number[];
  readonly cues: readonly CueReport[];
}

/** A level as JSON can hold it: −Infinity (silence) becomes null. */
function level(value: number): number | null {
  return value === Number.NEGATIVE_INFINITY ? null : value;
}

function nearest(onsets: readonly number[], sample: number): number | null {
  let best: number | null = null;
  for (const onset of onsets) {
    if (best === null || Math.abs(onset - sample) < Math.abs(best - sample)) {
      best = onset;
    }
  }
  return best;
}

function cueReport(
  cue: AnalysisCue,
  weighted: WeightedStereo,
  onsets: readonly number[]
): CueReport {
  const before = cue.sample - MOMENTARY_WINDOW;
  const after = cue.sample + MOMENTARY_WINDOW <= weighted.left.length;
  return {
    id: cue.id,
    sample: cue.sample,
    nearestOnsetSample: nearest(onsets, cue.sample),
    momentaryBeforeLufs: before >= 0 ? level(momentaryLufsAt(weighted, before)) : null,
    momentaryAfterLufs: after ? level(momentaryLufsAt(weighted, cue.sample)) : null,
  };
}

/** Every measurement this module makes, of one signal and its cues, in one JSON-serialisable object. */
export function audioReport(signal: StereoBuffer, cues: readonly AnalysisCue[]): AudioReport {
  const length = requireStereo(signal);
  for (const cue of cues) {
    requireCueSample(cue, length);
  }
  const loudness = measureLoudness(signal);
  const onsets = spectralFluxOnsets(signal);
  const weighted = kWeightStereo(signal);
  return {
    samples: length,
    seconds: length / SAMPLE_RATE,
    loudness: {
      integratedLufs: level(loudness.integratedLufs),
      maxMomentaryLufs: level(loudness.maxMomentaryLufs),
      maxShortTermLufs: level(loudness.maxShortTermLufs),
    },
    truePeakDbtp: level(truePeakDbtp(signal)),
    samplePeakDbfs: level(samplePeakDbfs(signal)),
    clipCount: clipCount(signal),
    dcOffset: dcOffset(signal),
    stereoCorrelation: stereoCorrelation(signal),
    lowBandCorrelation: lowBandCorrelation(signal),
    octaveBands: octaveBandBalance(signal).map(({ centerHz, levelDb }) => ({
      centerHz,
      levelDb: level(levelDb),
    })),
    onsetSamples: onsets,
    cues: cues.map((cue) => cueReport(cue, weighted, onsets)),
  };
}
