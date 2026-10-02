import { configureIdempotencyBodyHashSecret } from '../lib/idempotency/index.js';
import { configureRateLimitBound, configureRateLimitKeySecret } from '../lib/rate-limit/index.js';

/**
 * Puts the rate-limit Redis bound and identifier key, and the idempotency
 * body-hash key, in force for every test process, from the same registry
 * entries the Worker reads.
 *
 * The Worker's bindings stage does this at the top of each request; a test that
 * calls a slice domain directly never reaches that stage, and each refuses to
 * answer until something has configured them. Here the mode's values arrive in
 * the process environment instead — one runtime's ambient environment standing
 * in for the other's, not a second value: `development` and `ciVitest` resolve
 * the same registry entries the pipeline would.
 */
configureRateLimitBound(process.env);
configureRateLimitKeySecret(process.env);
configureIdempotencyBodyHashSecret(process.env);
