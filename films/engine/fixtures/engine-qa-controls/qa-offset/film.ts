import { controlSpec } from '../control-film.js';

import type { FilmDefinition } from '../../../film/spec.js';

/**
 * engine-render one frame ahead, with no score: the video whose frames are
 * offset by one from engine-render's master, which the stills-match control
 * compares against it. The controls driver loads this module by path, so no
 * module imports it.
 * @toolContract
 */
export const definition: FilmDefinition = { spec: controlSpec('qa-offset') };
