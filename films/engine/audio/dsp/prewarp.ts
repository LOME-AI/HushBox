import { cos, sin } from '../../dmath/dmath.js';
import { SAMPLE_RATE } from '../../time/grid.js';

/**
 * tan(π·cutoff / SAMPLE_RATE), composed from dmath's `sin` and `cos`: the
 * bilinear transform's prewarped gain, which puts a digital filter's corner
 * exactly on `cutoff`. A cutoff in [0, SAMPLE_RATE / 2) keeps the angle in [0, π/2).
 */
export function prewarp(cutoff: number): number {
  const angle = (Math.PI * cutoff) / SAMPLE_RATE;
  return sin(angle) / cos(angle);
}
