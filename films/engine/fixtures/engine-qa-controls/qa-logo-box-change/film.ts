import { CONTROL_SCORE, controlSpec } from '../control-film.js';

import type { FilmDefinition } from '../../../film/spec.js';

/**
 * A mark resting in one box and then, from the next frame, in another, exact on every frame but the first box's last, which no probe lands on: the resting-mark gate's box-change control. The CLI loads this module by path, so no module imports it.
 * @toolContract
 */
export const definition: FilmDefinition = {
  spec: controlSpec('qa-logo-box-change'),
  score: CONTROL_SCORE,
};
