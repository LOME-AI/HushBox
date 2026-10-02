import { CONTROL_SCORE, controlSpec } from '../control-film.js';

import type { FilmDefinition } from '../../../film/spec.js';

/**
 * A fitted approximation of the mark at rest, each part a polygon through every
 * 24th point of its traced outline: the resting-mark gate's approximation
 * control. The CLI loads this module by path, so no module imports it.
 * @toolContract
 */
export const definition: FilmDefinition = {
  spec: controlSpec('qa-logo-fitted'),
  score: CONTROL_SCORE,
};
