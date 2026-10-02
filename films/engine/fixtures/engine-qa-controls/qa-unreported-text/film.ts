import { CONTROL_SCORE, controlSpec } from '../control-film.js';
import { firstBarRow } from '../text-rows.js';

import type { FilmDefinition } from '../../../film/spec.js';

/**
 * engine-render's grid and click track under a look: the containment gate's
 * control for unreported text, a line drawn over the first bar with no box
 * reported for it. The row is imagery so the claims gate asks nothing of it.
 * The CLI loads this module by path, so no module imports it.
 * @toolContract
 */
export const definition: FilmDefinition = {
  spec: controlSpec('qa-unreported-text', {
    text: [firstBarRow('unreported', 'Nobody reports me.', 'imagery')],
  }),
  score: CONTROL_SCORE,
};
