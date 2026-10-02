import { CONTROL_SCORE, controlSpec } from '../control-film.js';

import type { FilmDefinition } from '../../../film/spec.js';

/**
 * The logo file drawn one pixel right of the box its look reports it resting
 * in: the resting-mark gate's shift control. The CLI loads this module by
 * path, so no module imports it.
 * @toolContract
 */
export const definition: FilmDefinition = {
  spec: controlSpec('qa-logo-shifted'),
  score: CONTROL_SCORE,
};
