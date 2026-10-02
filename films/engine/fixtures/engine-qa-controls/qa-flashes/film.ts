import { CONTROL_SCORE, controlSpec } from '../control-film.js';

import type { FilmDefinition } from '../../../film/spec.js';

/**
 * engine-render with a full-frame white flash added between each beat of the
 * second bar's first two beats, so the frame flashes at 5 Hz for one second:
 * the flash rule's control. The CLI loads this module by path, so no module
 * imports it.
 * @toolContract
 */
export const definition: FilmDefinition = { spec: controlSpec('qa-flashes'), score: CONTROL_SCORE };
