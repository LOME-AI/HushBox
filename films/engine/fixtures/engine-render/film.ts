import { defineFilm } from '../../film/spec.js';

import type { FilmDefinition } from '../../film/spec.js';
import type { Grid } from '../../time/grid.js';

const GRID: Grid = { framesPerBeat: 24, beatsPerBar: 4 };
const BARS = 4;
const BEATS = BARS * GRID.beatsPerBar;

/** Every beat of the film, counted from 0. */
const BEAT_NUMBERS = Array.from({ length: BEATS }, (_, beat) => beat);

/**
 * Four bars, one shot per bar, with a click and a white flash on every beat: the
 * fixture the render pipeline is proved on, where each onset in the delivered
 * audio has a flash frame it must land on. The CLI loads this module by path,
 * so no module imports it.
 * @toolContract
 */
export const definition: FilmDefinition = {
  spec: defineFilm({
    id: 'engine-render',
    title: 'Engine render',
    seed: 'engine-render',
    grid: GRID,
    beats: BEATS,
    shots: Array.from({ length: BARS }, (_, bar) => ({
      id: `bar-${String(bar)}`,
      fromBeat: bar * GRID.beatsPerBar,
      toBeat: (bar + 1) * GRID.beatsPerBar,
      reads: [],
    })),
    text: [],
    cues: BEAT_NUMBERS.map((beat) => ({
      id: `beat-${String(beat)}`,
      beat,
      kind: 'flash' as const,
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
