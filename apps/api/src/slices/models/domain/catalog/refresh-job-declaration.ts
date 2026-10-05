import { z } from 'zod';
import type { OneShotJobRegistration } from '../../../../lib/jobs/index.js';

export const CATALOG_REFRESH_JOB_TYPE = 'catalog.refresh.v1';

/**
 * The descriptor version the enqueuing read expected. It is the job's identity,
 * not an input: the refresh writes whatever version the running code bakes.
 */
const catalogRefreshPayloadSchema = z.object({ descriptorVersion: z.string().min(1) });

export type CatalogRefreshJobRegistration = OneShotJobRegistration<
  typeof catalogRefreshPayloadSchema
>;

/**
 * Everything the job declares but its work, in a module the catalog read can
 * import: the work runs the refresh, and the refresh reaches the read.
 */
export const CATALOG_REFRESH_JOB_DECLARATION = {
  kind: 'oneShot',
  type: CATALOG_REFRESH_JOB_TYPE,
  schema: catalogRefreshPayloadSchema,
  // Bounded by the gateway's catalog rather than by any caller: the gateway's
  // listings, one endpoint fetch per image model and one write per listed
  // model, each request under its own deadline.
  maxExecutionSeconds: 60,
  // Retries ride out a gateway or database outage: on the dispatcher's backoff
  // curve eight attempts span over an hour before the row dead-letters.
  maxFailures: 8,
  // The refresh converges by upsert on the model id, so a redelivered or
  // concurrent run lands on the same catalog.
  idempotency: 'natural',
  shard: 'bulk',
} as const satisfies Omit<CatalogRefreshJobRegistration, 'handler'>;

/**
 * The registration a catalog read enqueues through. `enqueueWithinTx` reads the
 * declaration and never the handler, and the read holds none of the refresh's
 * gateway or sighting dependencies, so its handler is a refusal: the job runs
 * only through the dispatcher's registration, which binds the real ones.
 */
export const catalogRefreshEnqueueRegistration: CatalogRefreshJobRegistration = {
  ...CATALOG_REFRESH_JOB_DECLARATION,
  handler: () =>
    Promise.reject(
      new Error(
        `${CATALOG_REFRESH_JOB_TYPE} ran from its enqueue-side registration; only the dispatcher registration runs it`
      )
    ),
};
