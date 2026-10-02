import { controlLook } from '../text-control.js';
import { definition } from './film.js';

/**
 * The look draws on a 2D canvas. The look host loads it by path, so no module
 * imports these exports.
 * @toolContract
 */
export const context = '2d';

/**
 * The striped field and one line drawn over the first bar that the look never
 * reports: the containment gate's control for text with no box.
 * @toolContract
 */
export const renderFrame = controlLook(definition.spec, [
  { id: 'unreported', sizePx: 84, x: 120, baseline: 450, reported: false },
]);
