import { CONTROL_SCORE, controlSpec } from '../control-film.js';

import type { FilmDefinition } from '../../../film/spec.js';

/**
 * A field of the logo's red with the mark cut out of it, at rest: the resting-mark gate's knockout control. The CLI loads this module by path, so no module imports it.
 * @toolContract
 */
export const definition: FilmDefinition = {
  spec: controlSpec('qa-logo-knockout'),
  score: CONTROL_SCORE,
};
