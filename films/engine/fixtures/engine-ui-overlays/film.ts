import { defineFilm } from '../../film/spec.js';
import { GRID, PHASES } from './timeline.js';

import type { FilmDefinition } from '../../film/spec.js';

/** Each stretch's cue: a tick, or a silence where the stretch hides the UI and leaves a blank field. */
const CUES = PHASES.map(({ placement }, beat) => ({
  id: `beat-${String(beat)}`,
  beat,
  kind: placement === 'hidden' ? ('silence' as const) : ('tick' as const),
  anchor: 'start' as const,
}));

/** A click on every tick cue. */
const CLICKS = CUES.filter(({ kind }) => kind === 'tick').map(({ id }) => ({
  at: { cue: id },
  params: { decay: 0.1 },
}));

/**
 * The UI layer's overlays: a real popover and dropdown menu opened on the
 * layer, shown live, hidden, and handed to the look as a texture it moves,
 * with a click on every stretch but the hidden one. The CLI loads this module
 * by path, so no module imports it.
 * @toolContract
 */
export const definition: FilmDefinition = {
  spec: defineFilm({
    id: 'engine-ui-overlays',
    title: 'Engine UI layer overlays',
    seed: 'engine-ui-overlays',
    grid: GRID,
    beats: PHASES.length,
    shots: PHASES.map(({ id }, beat) => ({ id, fromBeat: beat, toBeat: beat + 1, reads: [] })),
    text: [],
    cues: CUES,
  }),
  score: {
    tracks: [{ id: 'click', instrument: 'tick', bus: 'clicks', gainDb: 0, events: CLICKS }],
    buses: [{ id: 'clicks', role: 'sfx', effects: [] }],
  },
};
