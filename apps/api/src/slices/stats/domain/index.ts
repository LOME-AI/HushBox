export { buildPublicStats } from './build-stats.js';

// The snapshot reader this build reads through is billing's, so billing's
// published store type is the one the composition root hands the route.
export type { PublicStatsStores } from '../../billing/index.js';

// Routes may import only this barrel and the middleware (boundaries), so the
// lib surface the route seam needs — the uniform error body constructor and
// the per-IP window this public endpoint is throttled by — is published here
// rather than imported from lib directly in routes.ts.
export { createErrorResponse } from '../../../lib/errors/index.js';
export { statsIpRateLimit } from '../../../lib/redis/index.js';
