import { AbsoluteFill, useCurrentFrame } from 'remotion';

import { Component as EngineRender } from '../../engine-render/composition.js';
import { FLASH } from '../../engine-render/palette.js';
import { beatToFrame } from '../../../time/grid.js';
import { definition } from './film.js';

/**
 * Studio reaches every composition through the bundler context in the package
 * root, so no module imports these exports.
 * @toolContract
 */
export { definition } from './film.js';

/** Half-beat flashes between engine-render's own beat flashes at beats 4, 5 and 6: five flashes 12 frames apart. */
const ADDED = new Set([4.5, 5.5].map((beat) => beatToFrame(definition.spec.grid, beat)));

/**
 * engine-render's frame, washed white on each added flash frame.
 * @toolContract
 */
export function Component(): React.JSX.Element {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill>
      <EngineRender />
      {ADDED.has(frame) ? <AbsoluteFill style={{ backgroundColor: FLASH }} /> : null}
    </AbsoluteFill>
  );
}
