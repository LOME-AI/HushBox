import { CONTROL_SCORE, controlSpec } from '../control-film.js';

import type { FilmDefinition } from '../../../film/spec.js';

/**
 * A mark resting over a run of frames whose ends are not all probe frames:
 * exact on every probe frame of the run and one pixel off on its last frame,
 * which no probe lands on. The resting-mark gate's run-end control. The CLI
 * loads this module by path, so no module imports it.
 * @toolContract
 */
export const definition: FilmDefinition = {
  spec: controlSpec('qa-logo-between-probes'),
  score: CONTROL_SCORE,
};
