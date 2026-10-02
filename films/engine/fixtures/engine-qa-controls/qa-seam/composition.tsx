import { Component as EngineRender } from '../../engine-render/composition.js';

/**
 * Studio reaches every composition through the bundler context in the package
 * root, so no module imports these exports.
 * @toolContract
 */
export { definition } from './film.js';

/**
 * engine-render's frame, unchanged: the control is in the spec.
 * @toolContract
 */
export function Component(): React.JSX.Element {
  return <EngineRender />;
}
