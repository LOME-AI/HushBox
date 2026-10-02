import { CONTROL_SCORE, controlSpec } from '../control-film.js';
import { firstBarRow } from '../text-rows.js';

import type { FilmDefinition } from '../../../film/spec.js';

/**
 * engine-render's grid and click track under a look: the safe-box rule's control: the headline set starting left of the safe box. The CLI loads this
 * module by path, so no module imports it.
 * @toolContract
 */
export const definition: FilmDefinition = {
  spec: controlSpec('qa-off-safe', {
    text: [firstBarRow('headline', 'Every word counts.', 'headline')],
  }),
  score: CONTROL_SCORE,
};
