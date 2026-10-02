import { controlLook } from '../text-control.js';
import { definition } from './film.js';

/**
 * The look draws on a 2D canvas. The look host loads it by path, so no module
 * imports these exports.
 * @toolContract
 */
export const context = '2d';

/**
 * The striped field and its lines of copy: the safe-box rule's control: the headline set starting left of the safe box.
 * @toolContract
 */
export const renderFrame = controlLook(definition.spec, [
  { id: 'headline', sizePx: 84, x: 20, baseline: 450 },
]);
