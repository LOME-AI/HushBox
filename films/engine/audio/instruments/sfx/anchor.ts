import { anchoredAtStart } from '../voice.js';

import type { StereoBuffer } from '../../dsp/index.js';
import type { Rendered } from '../instrument.js';

/** The buffer played backwards, into new storage. */
export function reversed(buffer: StereoBuffer): StereoBuffer {
  return { left: buffer.left.toReversed(), right: buffer.right.toReversed() };
}

/**
 * A sound whose cue lands on `anchorOffset`, a whole sample from its first to
 * one past its last, scaled to full scale as every instrument is.
 */
export function anchoredAt(buffer: StereoBuffer, anchorOffset: number): Rendered {
  const samples = buffer.left.length;
  if (!(Number.isSafeInteger(anchorOffset) && anchorOffset >= 0 && anchorOffset <= samples)) {
    throw new RangeError(
      `anchor must be a whole sample from 0 to ${String(samples)}, got ${String(anchorOffset)}`
    );
  }
  return { buffer: anchoredAtStart(buffer).buffer, anchorOffset };
}

/** A sound whose cue lands one past its last sample, so it finishes exactly on the cue. */
export function anchoredAtEnd(buffer: StereoBuffer): Rendered {
  return anchoredAt(buffer, buffer.left.length);
}
