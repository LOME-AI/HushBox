import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { SAMPLES_PER_FRAME, beatToFrame, frameToSample } from './grid.js';

import type { Grid } from './grid.js';

describe('beat to sample conversion', () => {
  it('lands every integer beat on an exact sample', () => {
    // Generators: `fc.integer` over framesPerBeat, beatsPerBar and beat.
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 240 }),
        fc.integer({ min: 1, max: 16 }),
        fc.integer({ min: 0, max: 100_000 }),
        (framesPerBeat, beatsPerBar, beat) => {
          const grid: Grid = { framesPerBeat, beatsPerBar };
          expect(frameToSample(beatToFrame(grid, beat))).toBe(
            beat * grid.framesPerBeat * SAMPLES_PER_FRAME
          );
        }
      )
    );
  });
});
