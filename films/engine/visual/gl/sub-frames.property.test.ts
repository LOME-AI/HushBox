import fc from 'fast-check';
import { expect, it } from 'vitest';

import { SHUTTER_DEGREES, subFrameOffsets } from './sub-frames.js';

const SHUTTER_FRAMES = SHUTTER_DEGREES / 360;

it('subFrameOffsets keeps every sample strictly inside the shutter, ascending and centred on the frame', () => {
  // Generator: sample counts from one to 256.
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 256 }), (samples) => {
      const offsets = subFrameOffsets(samples);
      expect(offsets).toHaveLength(samples);
      expect(offsets.every((offset) => Math.abs(offset) < SHUTTER_FRAMES / 2)).toBe(true);
      expect(offsets.toSorted((a, b) => a - b)).toEqual(offsets);
      expect(offsets.reduce((sum, offset) => sum + offset, 0)).toBeCloseTo(0, 12);
    })
  );
});
