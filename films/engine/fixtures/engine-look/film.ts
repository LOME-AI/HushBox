import { defineFilm } from '../../film/spec.js';

import type { FilmDefinition } from '../../film/spec.js';
import type { Grid } from '../../time/grid.js';

/** The fixture's beat grid, which its WebGL2 sibling shares. */
export const GRID: Grid = { framesPerBeat: 24, beatsPerBar: 4 };

/** Four bars of the grid. */
export const BEATS = 16;

const BEAT_NUMBERS = Array.from({ length: BEATS }, (_, beat) => beat);

/**
 * The look host's fixture: a 2D look of moving shapes and one line of text,
 * finished by the post chain, with a click on every beat that the shapes pulse
 * to. The CLI loads this module by path, so no module imports it.
 * @toolContract
 */
export const definition: FilmDefinition = {
  spec: defineFilm({
    id: 'engine-look',
    title: 'Engine look',
    seed: 'engine-look',
    grid: GRID,
    beats: BEATS,
    shots: [{ id: 'orbit', fromBeat: 0, toBeat: BEATS, reads: [] }],
    text: [
      {
        id: 'line',
        shotId: 'orbit',
        words: 'Drawn from code.',
        role: 'headline',
        inBeat: 0,
        outBeat: BEATS,
        basis: { kind: 'opinion' },
      },
    ],
    cues: BEAT_NUMBERS.map((beat) => ({
      id: `beat-${String(beat)}`,
      beat,
      kind: 'tick' as const,
      anchor: 'start' as const,
    })),
  }),
  score: {
    tracks: [
      {
        id: 'click',
        instrument: 'tick',
        bus: 'clicks',
        gainDb: 0,
        events: BEAT_NUMBERS.map((beat) => ({
          at: { cue: `beat-${String(beat)}` },
          params: { decay: 0.1 },
        })),
      },
    ],
    buses: [{ id: 'clicks', role: 'sfx', effects: [] }],
  },
};
