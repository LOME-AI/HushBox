import { defineFilm } from '../../film/spec.js';
import { BEATS, GRID, PHASES } from './timeline.js';

import type { FilmDefinition } from '../../film/spec.js';

const BEAT_NUMBERS = Array.from({ length: BEATS }, (_, beat) => beat);

/**
 * The UI layer's fixture: real `@hushbox/ui` components moved element by
 * element, typed into, stacked between two canvases and handed to a shader as
 * a texture, with a click on every beat. The CLI loads this module by path, so
 * no module imports it.
 * @toolContract
 */
export const definition: FilmDefinition = {
  spec: defineFilm({
    id: 'engine-ui',
    title: 'Engine UI layer',
    seed: 'engine-ui',
    grid: GRID,
    beats: BEATS,
    shots: PHASES.map(({ id, fromBeat, toBeat }) => ({ id, fromBeat, toBeat, reads: [] })),
    text: [],
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
