import type { PostSettings } from '../../../visual/gl/index.js';

/**
 * The plain look's canvas and picture. The look host loads this module by path,
 * so no module imports these exports.
 * @toolContract
 */
export { context, renderFrame } from '../engine-look-plain/look.js';

/**
 * The post chain with every effect at 0: its highlight roll-off and dither alone.
 * @toolContract
 */
export function post(): PostSettings {
  return { bloom: 0, aberration: 0, vignette: 0, flash: 0 };
}
