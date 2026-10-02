import { defineFilm } from '../../../../../film/spec.js';
import { GRID } from '../../../film.js';

import type { FilmDefinition } from '../../../../../film/spec.js';

/** Twenty-six beats, 10.4 s: long enough for one full 10 s turnover window and many 2 s travel spans. */
const BEATS = 26;

/** A tick on the first beat of every bar. */
const DOWNBEATS = Array.from(
  { length: Math.ceil(BEATS / GRID.beatsPerBar) },
  (_, bar) => bar * GRID.beatsPerBar
);

/**
 * A take long enough for the composition report to read both its numbers.
 * The CLI loads this module by path, so no module imports it.
 * @toolContract
 */
export const definition: FilmDefinition = {
  spec: defineFilm({
    id: 'glide',
    title: 'Glide',
    seed: 'glide',
    grid: GRID,
    beats: BEATS,
    text: [],
    cues: DOWNBEATS.map((beat) => ({
      id: `tick-${String(beat)}`,
      beat,
      kind: 'tick' as const,
      anchor: 'start' as const,
    })),
  }),
  score: {
    tracks: [
      {
        id: 'ticks',
        instrument: 'tick',
        bus: 'dry',
        gainDb: 0,
        events: DOWNBEATS.map((beat) => ({ at: { cue: `tick-${String(beat)}` } })),
      },
    ],
    buses: [{ id: 'dry', role: 'sfx', effects: [] }],
  },
};
