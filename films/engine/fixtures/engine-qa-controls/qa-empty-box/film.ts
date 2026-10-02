import { CONTROL_SCORE, controlSpec } from '../control-film.js';
import { firstBarRow } from '../text-rows.js';

import type { FilmDefinition } from '../../../film/spec.js';

/**
 * engine-render's grid and click track under a look: the containment gate's control for an empty box: the support line reported and never drawn, beside a headline drawn as reported. The CLI loads this
 * module by path, so no module imports it.
 * @toolContract
 */
export const definition: FilmDefinition = {
  spec: controlSpec('qa-empty-box', {
    text: [
      firstBarRow('headline', 'Every word counts.', 'headline'),
      firstBarRow('support', 'Read it all.', 'support'),
    ],
  }),
  score: CONTROL_SCORE,
};
