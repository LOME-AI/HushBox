import { defineFilm } from '../../../../../film/spec.js';
import { BEATS, GRID } from '../../../film.js';

import type { FilmDefinition } from '../../../../../film/spec.js';

/**
 * A take whose score ticks on the off-beats. The CLI loads this module by
 * path, so no module imports it.
 * @toolContract
 */
export const definition: FilmDefinition = {
  spec: defineFilm({
    id: 'drift',
    title: 'Drift',
    seed: 'drift',
    grid: GRID,
    beats: BEATS,
    text: [],
    cues: [
      { id: 'tick-a', beat: 1, kind: 'tick', anchor: 'start' },
      { id: 'tick-b', beat: 3, kind: 'tick', anchor: 'start' },
    ],
  }),
  score: {
    tracks: [
      {
        id: 'ticks',
        instrument: 'tick',
        bus: 'dry',
        gainDb: 0,
        events: [{ at: { cue: 'tick-a' } }, { at: { cue: 'tick-b' } }],
      },
    ],
    buses: [{ id: 'dry', role: 'sfx', effects: [] }],
  },
};
