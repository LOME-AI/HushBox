import { defineFilm } from '../../film/spec.js';
import { BEATS, GRID } from './timeline.js';

import type { FilmDefinition } from '../../film/spec.js';

/**
 * The hidden beat is a declared silence: its frame is a flat field on
 * purpose, and every other beat opens on a click.
 */
function cueOf(beat: number): string {
  return `beat-${String(beat)}`;
}

const HEARD = BEATS.flatMap(({ placement }, beat) => (placement === 'hidden' ? [] : [beat]));

/**
 * The app's composites on the UI layer with no container passed: its Menu, a
 * dialog through its Overlay router and a sheet, each shown live, hidden, and
 * handed to the look as a texture it moves. The CLI loads this module by path,
 * so no module imports it.
 * @toolContract
 */
export const definition: FilmDefinition = {
  spec: defineFilm({
    id: 'engine-ui-composites',
    title: 'Engine UI layer composites',
    seed: 'engine-ui-composites',
    grid: GRID,
    beats: BEATS.length,
    shots: BEATS.map(({ id }, beat) => ({ id, fromBeat: beat, toBeat: beat + 1, reads: [] })),
    text: [],
    cues: BEATS.map(({ placement }, beat) => ({
      id: cueOf(beat),
      beat,
      kind: placement === 'hidden' ? ('silence' as const) : ('tick' as const),
      anchor: 'start' as const,
    })),
  }),
  score: {
    buses: [{ id: 'sfx', role: 'sfx', effects: [] }],
    tracks: [
      {
        id: 'tick',
        instrument: 'tick',
        bus: 'sfx',
        gainDb: 0,
        events: HEARD.map((beat) => ({ at: { cue: cueOf(beat) }, params: { decay: 0.1 } })),
      },
    ],
  },
};
