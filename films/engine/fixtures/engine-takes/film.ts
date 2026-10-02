import { defineFilm } from '../../film/spec.js';

import type { FilmDefinition } from '../../film/spec.js';
import type { Grid } from '../../time/grid.js';

/** The beat grid the fixture film and its takes share. */
export const GRID: Grid = { framesPerBeat: 24, beatsPerBar: 4 };

/** One bar of the grid. */
export const BEATS = 4;

/**
 * The fixture film the `take` verb's fixture takes belong to. Its spec
 * declares no shots, as a film's may until its look is ported. The CLI loads
 * this module by path, so no module imports it.
 * @toolContract
 */
export const definition: FilmDefinition = {
  spec: defineFilm({
    id: 'engine-takes',
    title: 'Engine takes',
    seed: 'engine-takes',
    grid: GRID,
    beats: BEATS,
    text: [],
    cues: [],
  }),
};
