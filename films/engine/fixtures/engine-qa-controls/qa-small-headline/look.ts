import { controlLook } from '../text-control.js';
import { definition } from './film.js';

/**
 * The look draws on a 2D canvas. The look host loads it by path, so no module
 * imports these exports.
 * @toolContract
 */
export const context = '2d';

/**
 * The striped field and its lines of copy: the size floor's control: the headline set at 83 px, one below its floor.
 * @toolContract
 */
export const renderFrame = controlLook(definition.spec, [
  { id: 'headline', sizePx: 83, x: 120, baseline: 450 },
]);
