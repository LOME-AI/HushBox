import { controlLook } from '../text-control.js';
import { definition } from './film.js';

/**
 * The look draws on a 2D canvas. The look host loads it by path, so no module
 * imports these exports.
 * @toolContract
 */
export const context = '2d';

/**
 * The striped field and its lines of copy: the containment gate's control for misplaced text: the headline drawn 60 px below the box it reports.
 * @toolContract
 */
export const renderFrame = controlLook(definition.spec, [
  { id: 'headline', sizePx: 84, x: 120, baseline: 450, drawnBelowPx: 60 },
]);
