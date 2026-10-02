import { CONTROL_SCORE, controlSpec } from '../control-film.js';

import type { FilmDefinition } from '../../../film/spec.js';

/**
 * engine-render with a bar whose width counts the renders its page has made:
 * the purity gate's control. The CLI loads this module by path, so no module
 * imports it.
 * @toolContract
 */
export const definition: FilmDefinition = { spec: controlSpec('qa-counter'), score: CONTROL_SCORE };
