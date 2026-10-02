import { CONTROL_SCORE, controlSpec } from '../control-film.js';

import type { FilmDefinition } from '../../../film/spec.js';

/**
 * The composition measure's low control: one scene whose parts bob in place.
 * It reads lower turnover and travel than `qa-composition-travel`, and passes
 * every gate. The CLI loads this module by path, so no module imports it.
 * @toolContract
 */
export const definition: FilmDefinition = {
  spec: controlSpec('qa-composition-bob'),
  score: CONTROL_SCORE,
};
