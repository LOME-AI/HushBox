import { defineFilm } from '../../../film/spec.js';
import { GRID } from '../film.js';

import type { FilmDefinition } from '../../../film/spec.js';

/**
 * A 2D look with the post chain off, whose frames the probe matches byte for
 * byte against the pixels the look drew. The CLI loads this module by path, so
 * no module imports it.
 * @toolContract
 */
export const definition: FilmDefinition = {
  spec: defineFilm({
    id: 'engine-look-plain',
    title: 'Engine look, post chain off',
    seed: 'engine-look-plain',
    grid: GRID,
    beats: 4,
    shots: [{ id: 'field', fromBeat: 0, toBeat: 4, reads: [] }],
    text: [],
    cues: [],
  }),
};
