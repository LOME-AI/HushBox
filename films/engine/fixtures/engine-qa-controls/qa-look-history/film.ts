import { CONTROL_SCORE, controlSpec } from '../control-film.js';

import type { FilmDefinition } from '../../../film/spec.js';

/**
 * A look whose picture follows the order its browser drew in: the purity
 * gate's control for state a browser carries between pages.
 * The CLI loads this module by path, so no module imports it.
 * @toolContract
 */
export const definition: FilmDefinition = {
  spec: controlSpec('qa-look-history'),
  score: CONTROL_SCORE,
};
