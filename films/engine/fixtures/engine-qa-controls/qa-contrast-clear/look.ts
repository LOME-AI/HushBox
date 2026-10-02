import { controlLook } from '../text-control.js';
import { definition } from './film.js';

/**
 * The look draws on a 2D canvas. The look host loads it by path, so no module
 * imports these exports.
 * @toolContract
 */
export const context = '2d';

/**
 * The striped field and its lines of copy: the text gates' clean case: a headline and a support line in the brand foreground, inside the safe box, reported where they are drawn.
 * @toolContract
 */
export const renderFrame = controlLook(definition.spec, [
  { id: 'headline', sizePx: 84, x: 120, baseline: 450 },
  { id: 'support', sizePx: 44, x: 120, baseline: 620 },
]);
