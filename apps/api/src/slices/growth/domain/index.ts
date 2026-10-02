export { bundledGrowthEventIndex, parseGrowthEventIndex } from './allowlist.js';
export { countBeacon } from './count-beacon.js';
export type { BeaconCount, GrowthCeilings } from './count-beacon.js';
export { deviceFamily, edgeGeography, normaliseCountry, normaliseRegion } from './dimensions.js';
export { recordBeacon } from './record-beacon.js';
export type { BeaconOutcome, RecordBeaconArgs } from './record-beacon.js';
export {
  GROWTH_ROLLUP_HOUR_LOST,
  GROWTH_ROLLUP_JOB_TYPE,
  createGrowthRollupEnqueueEntry,
  createGrowthRollupJobRegistration,
  growthRollupHourSchema,
  growthRollupWindow,
  rollupGrowthHour,
} from './rollup.js';
export type {
  GrowthRollupEnqueueDeps,
  GrowthRollupInput,
  GrowthRollupJobDeps,
  GrowthRollupOutcome,
  GrowthRollupRowCounts,
} from './rollup.js';
export type { GrowthStores } from '../ports/index.js';

// The visitor hash is deliberately absent from every door this slice has: it is
// the one symbol the growth seam names, and publishing it would let a module
// that resolves a principal reach the anonymous half of the design.

// Routes import only this barrel and the middleware (boundaries), so the lib
// surface the route seam needs is published here rather than reached directly.
export { createErrorResponse } from '../../../lib/errors/index.js';
export { idempotencyExempt, idempotent, runMutation } from '../../../lib/idempotency/index.js';
export { resolveClientIp } from '../../../lib/redis/index.js';
export type { Bindings } from '../../../lib/context/index.js';
export { FINGERPRINT_CODES } from '../../../lib/telemetry/index.js';
