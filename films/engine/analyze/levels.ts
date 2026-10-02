import { amplitudeToDb } from './decibels.js';
import { requireStereo } from './signal.js';

import type { StereoBuffer } from '../audio/dsp/index.js';

/** Each channel's mean sample value. */
export interface ChannelMeans {
  readonly left: number;
  readonly right: number;
}

function peakMagnitude(samples: Float32Array): number {
  let peak = 0;
  for (const sample of samples) {
    peak = Math.max(peak, Math.abs(sample));
  }
  return peak;
}

/** The largest sample magnitude across both channels, in dBFS. */
export function samplePeakDbfs(signal: StereoBuffer): number {
  requireStereo(signal);
  return amplitudeToDb(Math.max(peakMagnitude(signal.left), peakMagnitude(signal.right)));
}

function clipsIn(samples: Float32Array): number {
  let clips = 0;
  for (const sample of samples) {
    if (Math.abs(sample) >= 1) {
      clips += 1;
    }
  }
  return clips;
}

/** Samples, across both channels, at or beyond full scale. */
export function clipCount(signal: StereoBuffer): number {
  requireStereo(signal);
  return clipsIn(signal.left) + clipsIn(signal.right);
}

function mean(samples: Float32Array): number {
  let sum = 0;
  for (const sample of samples) {
    sum += sample;
  }
  return sum / samples.length;
}

export function dcOffset(signal: StereoBuffer): ChannelMeans {
  requireStereo(signal);
  return { left: mean(signal.left), right: mean(signal.right) };
}
