import { CONTROL_SCORE, controlSpec } from '../control-film.js';

import type { FilmDefinition } from '../../../film/spec.js';

/**
 * engine-render with the cue on its first cut declared a hit rather than a
 * flash, so the white frame the picture draws there is a flash at a cut with
 * no flash cue: the seam rule's control. The CLI loads this module by path, so
 * no module imports it.
 * @toolContract
 */
export const definition: FilmDefinition = {
  spec: controlSpec('qa-seam', { retype: { 'beat-4': 'hit' } }),
  score: CONTROL_SCORE,
};
