import { defineFilm } from '../../../film/spec.js';
import { BEATS, GRID } from '../film.js';

import type { FilmDefinition } from '../../../film/spec.js';

/**
 * The look host's WebGL2 fixture: a spinning cube drawn in the look's own
 * WebGL2 context, motion-blurred by the host, with no text and no score. The
 * CLI loads this module by path, so no module imports it.
 * @toolContract
 */
export const definition: FilmDefinition = {
  spec: defineFilm({
    id: 'engine-look-gl',
    title: 'Engine look, WebGL2',
    seed: 'engine-look-gl',
    grid: GRID,
    beats: BEATS,
    shots: [{ id: 'spin', fromBeat: 0, toBeat: BEATS, reads: [] }],
    text: [],
    cues: [],
  }),
};
