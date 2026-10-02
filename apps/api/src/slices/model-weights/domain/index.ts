export { artifactContentType, artifactObjectKey, artifactParamsSchema } from './artifact.js';
export type { ModelWeightsBindings } from './artifact.js';

// Routes may import only this barrel and the middleware (boundaries), so the
// uniform error-body constructor the route seam needs is published here rather
// than imported from lib directly in routes.ts.
export { createErrorResponse } from '../../../lib/errors/index.js';
