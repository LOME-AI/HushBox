import { controlLook } from '../text-control.js';
import { definition } from './film.js';

/**
 * The look draws on a 2D canvas. The look host loads it by path, so no module
 * imports these exports.
 * @toolContract
 */
export const context = '2d';

/**
 * The striped field and its lines of copy: the containment gate's control for hideText: the headline drawn whether or not the pass hides text.
 * @toolContract
 */
export const renderFrame = controlLook(
  definition.spec,
  [{ id: 'headline', sizePx: 84, x: 120, baseline: 450 }],
  { ignoresHideText: true }
);
