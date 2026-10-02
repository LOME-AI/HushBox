import { AbsoluteFill } from 'remotion';

import { FILL } from './palette.js';

/**
 * Studio reaches every composition through the bundler context in the package
 * root, so no module imports these exports.
 * @toolContract
 */
export { definition } from './film.js';

/**
 * The frame Studio renders for this fixture.
 * @toolContract
 */
export function Component(): React.JSX.Element {
  return <AbsoluteFill style={{ backgroundColor: FILL }} />;
}
