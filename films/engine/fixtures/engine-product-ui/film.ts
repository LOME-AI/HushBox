import { defineFilm } from '../../film/spec.js';

import type { FilmDefinition } from '../../film/spec.js';
import type { Grid } from '../../time/grid.js';

const GRID: Grid = { framesPerBeat: 30, beatsPerBar: 4 };

/**
 * One bar that puts real `packages/ui` components on screen through
 * `ProductFrame`, styled by the app's own stylesheet, pushing in slowly.
 */
export const definition: FilmDefinition = {
  spec: defineFilm({
    id: 'engine-product-ui',
    title: 'Engine product UI',
    seed: 'engine-product-ui',
    grid: GRID,
    beats: GRID.beatsPerBar,
    shots: [{ id: 'product', fromBeat: 0, toBeat: GRID.beatsPerBar, reads: [] }],
    text: [],
    cues: [],
  }),
};
