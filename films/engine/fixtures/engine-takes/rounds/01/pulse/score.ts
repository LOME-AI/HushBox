import { defineFilm } from '../../../../../film/spec.js';
import { BEATS, GRID } from '../../../film.js';

import type { FilmDefinition } from '../../../../../film/spec.js';

const DOWNBEATS = [0, 2];

/**
 * A take whose score kicks on beats one and three. The CLI loads this module
 * by path, so no module imports it.
 * @toolContract
 */
export const definition: FilmDefinition = {
  spec: defineFilm({
    id: 'pulse',
    title: 'Pulse',
    seed: 'pulse',
    grid: GRID,
    beats: BEATS,
    text: [],
    cues: DOWNBEATS.map((beat) => ({
      id: `kick-${String(beat)}`,
      beat,
      kind: 'hit' as const,
      anchor: 'start' as const,
    })),
  }),
  score: {
    tracks: [
      {
        id: 'kicks',
        instrument: 'kick',
        bus: 'drums',
        gainDb: -3,
        events: DOWNBEATS.map((beat) => ({ at: { cue: `kick-${String(beat)}` } })),
      },
    ],
    buses: [{ id: 'drums', role: 'music', effects: [] }],
  },
};
