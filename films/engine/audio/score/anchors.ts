import { sampleAt } from '../dsp/index.js';

import type { StereoBuffer } from '../dsp/index.js';
import type { Anchor } from './schema.js';

/** A rendered sound: its buffer and the sample in it its instrument lands on the cue. */
interface Rendered {
  buffer: StereoBuffer;
  anchorOffset: number;
}

/** The first index at which either channel reaches its largest magnitude. */
function loudestIndex(buffer: StereoBuffer): number {
  let loudest = -1;
  let found = 0;
  for (const [index, left] of buffer.left.entries()) {
    const level = Math.max(Math.abs(left), Math.abs(sampleAt(buffer.right, index)));
    if (level > loudest) {
      loudest = level;
      found = index;
    }
  }
  return found;
}

/** The anchor an instrument's own offset stands for: its first sample, one past its last, or a sample inside. */
function anchorAt(offset: number, length: number): Anchor {
  if (offset === 0) {
    return 'start';
  }
  return offset === length ? 'end' : 'peak';
}

/**
 * Where inside a rendered sound the named anchor lies, as an offset from its
 * first sample: 0 for `start`, one past the last sample for `end`, the loudest
 * sample of either channel for `peak`. With no anchor named, the instrument's
 * own offset is used, and the anchor it stands for is named.
 */
export function anchorPoint(
  anchor: Anchor | null,
  rendered: Rendered
): { anchor: Anchor; offset: number } {
  const { buffer, anchorOffset } = rendered;
  switch (anchor) {
    case 'start': {
      return { anchor, offset: 0 };
    }
    case 'end': {
      return { anchor, offset: buffer.left.length };
    }
    case 'peak': {
      return { anchor, offset: loudestIndex(buffer) };
    }
    case null: {
      return { anchor: anchorAt(anchorOffset, buffer.left.length), offset: anchorOffset };
    }
  }
}
