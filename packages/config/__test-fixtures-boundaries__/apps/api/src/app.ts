import { wired } from './composition/wires.js';
import { devRoutes } from './dev/routes.js';

export const app = `${wired}${devRoutes}`;
