import { CONTROL_SCORE, controlSpec } from '../control-film.js';
import { firstBarRow } from '../text-rows.js';

import type { FilmDefinition } from '../../../film/spec.js';

/**
 * engine-render's grid and click track under a look: the reading-time rule's control: the headline taken off screen at frame 60, before its row's span ends. The CLI loads this
 * module by path, so no module imports it.
 * @toolContract
 */
export const definition: FilmDefinition = {
  spec: controlSpec('qa-early-removal', {
    text: [firstBarRow('headline', 'Every word counts.', 'headline')],
  }),
  score: CONTROL_SCORE,
};
