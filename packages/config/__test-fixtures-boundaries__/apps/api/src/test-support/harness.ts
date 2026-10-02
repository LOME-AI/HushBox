import { deltaDomainSecret } from '../slices/delta/domain/index.js';
import { wired } from '../composition/wires.js';

export const harness = `${deltaDomainSecret}${wired}`;
