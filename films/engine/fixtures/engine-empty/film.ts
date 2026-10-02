import { defineFilm } from '../../film/spec.js';

import type { FilmDefinition } from '../../film/spec.js';
import type { Grid } from '../../time/grid.js';

const GRID: Grid = { framesPerBeat: 24, beatsPerBar: 4 };

/**
 * One bar of a single solid colour: the smallest film the registry and the
 * renderer accept. The CLI loads this module by path, so no module imports it.
 * @toolContract
 */
export const definition: FilmDefinition = {
  spec: defineFilm({
    id: 'engine-empty',
    title: 'Engine empty',
    seed: 'engine-empty',
    grid: GRID,
    beats: GRID.beatsPerBar,
    shots: [{ id: 'fill', fromBeat: 0, toBeat: GRID.beatsPerBar, reads: [] }],
    text: [],
    cues: [],
  }),
};
