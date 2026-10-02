import { dbToAmplitude, samplePeakDbfs } from '../analyze/index.js';
import { frameToSample } from '../time/grid.js';

import type { AnalysisCue } from '../analyze/index.js';
import type { StereoBuffer } from '../audio/dsp/index.js';

/** The sample peak the loudest stem is written at. */
export const STEM_PEAK_DBFS = -1;

/** The one gain every stem is written with, and the stem whose peak set it. */
export interface StemGain {
  gain: number;
  /** null when every stem is silent, which leaves the gain at unity. */
  loudest: string | null;
}

/**
 * The gain that brings the loudest stem's sample peak to `STEM_PEAK_DBFS`.
 * Stems are tracks before their bus, so they can pass full scale; one gain for
 * all of them keeps their levels against each other as the mix has them.
 */
export function stemGain(stems: Readonly<Record<string, StereoBuffer>>): StemGain {
  let loudest: StemGain['loudest'] = null;
  let peakDbfs = Number.NEGATIVE_INFINITY;
  for (const [track, stem] of Object.entries(stems)) {
    const stemPeakDbfs = samplePeakDbfs(stem);
    if (stemPeakDbfs > peakDbfs) {
      peakDbfs = stemPeakDbfs;
      loudest = track;
    }
  }
  return loudest === null
    ? { gain: 1, loudest }
    : { gain: dbToAmplitude(STEM_PEAK_DBFS - peakDbfs), loudest };
}

/** A copy of `buffer` with both channels multiplied by `gain`. */
export function scaleStereo(buffer: StereoBuffer, gain: number): StereoBuffer {
  return {
    left: buffer.left.map((sample) => sample * gain),
    right: buffer.right.map((sample) => sample * gain),
  };
}

/** A film's cues as the analysis tree marks them: each on its frame's first sample. */
export function analysisCues(cues: readonly { id: string; from: number }[]): AnalysisCue[] {
  return cues.map(({ id, from }) => ({ id, sample: frameToSample(from) }));
}
