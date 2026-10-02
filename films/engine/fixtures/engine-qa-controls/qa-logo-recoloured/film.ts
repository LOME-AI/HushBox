import { CONTROL_SCORE, controlSpec } from '../control-film.js';

import type { FilmDefinition } from '../../../film/spec.js';

/**
 * The traced mark at rest, filled in a colour other than the logo's: the resting-mark gate's colour control. The CLI loads this module by path, so no module imports it.
 * @toolContract
 */
export const definition: FilmDefinition = {
  spec: controlSpec('qa-logo-recoloured'),
  score: CONTROL_SCORE,
};
