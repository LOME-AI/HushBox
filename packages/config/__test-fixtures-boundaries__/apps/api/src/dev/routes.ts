import { deltaDomainSecret } from '../slices/delta/domain/index.js';
import { wired } from '../composition/wires.js';
import { devFixture } from './fixtures.js';

export const devRoutes = `${deltaDomainSecret}${wired}${devFixture}`;
