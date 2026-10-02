import { Sequence } from 'remotion';

import { Component as EngineRender } from '../../engine-render/composition.js';

/**
 * Studio reaches every composition through the bundler context in the package
 * root, so no module imports these exports.
 * @toolContract
 */
export { definition } from './film.js';

/**
 * engine-render's next frame at each frame: its sequence starts one frame early.
 * @toolContract
 */
export function Component(): React.JSX.Element {
  return (
    <Sequence from={-1}>
      <EngineRender />
    </Sequence>
  );
}
