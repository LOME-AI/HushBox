import { CONTROL_SCORE, controlSpec } from '../control-film.js';

import type { FilmDefinition } from '../../../film/spec.js';

/**
 * The logo file at rest on a ground one level off its own red: the resting-mark gate's contrast control. The CLI loads this module by path, so no module imports it.
 * @toolContract
 */
export const definition: FilmDefinition = {
  spec: controlSpec('qa-logo-grey-level'),
  score: CONTROL_SCORE,
};
