import { AbsoluteFill, useCurrentFrame } from 'remotion';

import { Component as EngineRender } from '../../engine-render/composition.js';
import { COUNTER } from '../palette.js';

/**
 * Studio reaches every composition through the bundler context in the package
 * root, so no module imports these exports.
 * @toolContract
 */
export { definition } from './film.js';

const STEP_PX = 24;
const STEPS = 40;
const BAR_PX = 48;

/**
 * The renders this module has made in its page: state a frame must never
 * read. A page that renders every frame in turn counts them all; a fresh page
 * counts one.
 */
let renders = 0;

/**
 * engine-render's frame with the render count drawn over it as a bar. It reads
 * the frame, as every film component does, so it renders again on each frame.
 * @toolContract
 */
export function Component(): React.JSX.Element {
  useCurrentFrame();
  renders += 1;
  return (
    <AbsoluteFill>
      <EngineRender />
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          height: BAR_PX,
          width: STEP_PX * (renders % STEPS),
          backgroundColor: COUNTER,
        }}
      />
    </AbsoluteFill>
  );
}
