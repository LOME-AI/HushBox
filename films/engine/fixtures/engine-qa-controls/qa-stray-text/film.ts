import { CONTROL_SCORE, controlSpec } from '../control-film.js';
import { firstBarRow } from '../text-rows.js';

import type { FilmDefinition } from '../../../film/spec.js';

/**
 * engine-render's grid and click track under a look: the containment gate's control for misplaced text: the headline drawn 60 px below the box it reports. The CLI loads this
 * module by path, so no module imports it.
 * @toolContract
 */
export const definition: FilmDefinition = {
  spec: controlSpec('qa-stray-text', {
    text: [firstBarRow('headline', 'Every word counts.', 'headline')],
  }),
  score: CONTROL_SCORE,
};
