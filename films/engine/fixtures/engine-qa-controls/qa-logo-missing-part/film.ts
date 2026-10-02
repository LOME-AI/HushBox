import { CONTROL_SCORE, controlSpec } from '../control-film.js';

import type { FilmDefinition } from '../../../film/spec.js';

/**
 * The traced mark at rest with its smallest part left out: the resting-mark
 * gate's missing-part control. The CLI loads this module by path, so no module
 * imports it.
 * @toolContract
 */
export const definition: FilmDefinition = {
  spec: controlSpec('qa-logo-missing-part'),
  score: CONTROL_SCORE,
};
