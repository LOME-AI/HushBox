import { defineFilm } from '../../film/spec.js';

import type { FilmDefinition } from '../../film/spec.js';
import type { Grid } from '../../time/grid.js';

const GRID: Grid = { framesPerBeat: 30, beatsPerBar: 4 };

const WHOLE_BAR = { shotId: 'controls', inBeat: 0, outBeat: GRID.beatsPerBar } as const;

/** Every beat of the bar, counted from 0. */
const BEAT_NUMBERS = Array.from({ length: GRID.beatsPerBar }, (_, beat) => beat);

/**
 * One bar of copy laid out inside the safe box, one line of imagery outside it
 * and a click on every beat: the claims gate's clean case, with a line of each
 * role at its size floor. The CLI loads this module by path, so no module
 * imports it.
 * @toolContract
 */
export const definition: FilmDefinition = {
  spec: defineFilm({
    id: 'engine-layout-controls',
    title: 'Engine layout controls',
    seed: 'engine-layout-controls',
    grid: GRID,
    beats: GRID.beatsPerBar,
    shots: [{ id: 'controls', fromBeat: 0, toBeat: GRID.beatsPerBar, reads: [] }],
    text: [
      {
        id: 'headline',
        words: 'In the box.',
        role: 'headline',
        basis: { kind: 'opinion' },
        ...WHOLE_BAR,
      },
      {
        id: 'support',
        words: 'Nothing collides.',
        role: 'support',
        basis: { kind: 'opinion' },
        ...WHOLE_BAR,
      },
      {
        id: 'cta',
        words: 'Every line fits.',
        role: 'cta',
        basis: { kind: 'opinion' },
        ...WHOLE_BAR,
      },
      { id: 'caption', words: 'imagery sits anywhere', role: 'imagery', ...WHOLE_BAR },
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
