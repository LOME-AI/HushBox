import { CONTROL_SCORE, controlSpec } from '../control-film.js';

import type { FilmDefinition } from '../../../film/spec.js';

/**
 * The logo file drawn twice as wide as it is, at rest in a box stretched to match: the resting-mark gate's proportion control. The CLI loads this module by path, so no module imports it.
 * @toolContract
 */
export const definition: FilmDefinition = {
  spec: controlSpec('qa-logo-stretched'),
  score: CONTROL_SCORE,
};
