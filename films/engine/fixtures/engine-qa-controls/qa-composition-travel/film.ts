import { CONTROL_SCORE, controlSpec } from '../control-film.js';

import type { FilmDefinition } from '../../../film/spec.js';

/**
 * The composition measure's high control: a look that travels through five
 * compositions, each building into a state it did not start in. It reads
 * higher turnover and travel than `qa-composition-bob`, and passes every gate.
 * The CLI loads this module by path, so no module imports it.
 * @toolContract
 */
export const definition: FilmDefinition = {
  spec: controlSpec('qa-composition-travel'),
  score: CONTROL_SCORE,
};
