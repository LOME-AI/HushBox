import { CONTROL_SCORE, controlSpec } from '../control-film.js';
import { firstBarRow } from '../text-rows.js';

import type { FilmDefinition } from '../../../film/spec.js';

/**
 * engine-render's grid and click track under a look: the text gates' clean case: a headline and a support line in the brand foreground, inside the safe box, reported where they are drawn. The CLI loads this
 * module by path, so no module imports it.
 * @toolContract
 */
export const definition: FilmDefinition = {
  spec: controlSpec('qa-contrast-clear', {
    text: [
      firstBarRow('headline', 'Every word counts.', 'headline'),
      firstBarRow('support', 'Read it all.', 'support'),
    ],
  }),
  score: CONTROL_SCORE,
};
