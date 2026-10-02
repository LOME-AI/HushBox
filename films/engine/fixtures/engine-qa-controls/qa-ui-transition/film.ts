import { CONTROL_SCORE, controlSpec } from '../control-film.js';

import type { FilmDefinition } from '../../../film/spec.js';

/**
 * A UI layer whose component keeps its own CSS transition: the freeze's
 * control, pure with the freeze and impure without it. The CLI loads this
 * module by path, so no module imports it.
 * @toolContract
 */
export const definition: FilmDefinition = {
  spec: controlSpec('qa-ui-transition'),
  score: CONTROL_SCORE,
};
