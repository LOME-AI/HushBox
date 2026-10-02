import { PUBLIC_USAGE_STATS_SCHEMA_VERSION, publicUsageStatsSchema } from '@hushbox/shared';
import { unavailableError, validationError } from '../../../lib/errors/index.js';
import { errAsync, okAsync } from '../../../lib/result/index.js';
import { readLatestPublicStatsSnapshot } from '../../billing/index.js';
import type { Database } from '@hushbox/db';
import type { PublicUsageStats } from '@hushbox/shared';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { PublicStatsStores } from '../../billing/index.js';

interface BuildPublicStatsDeps {
  readonly stores: PublicStatsStores;
  readonly db: Database;
}

/**
 * The public usage stats: the latest snapshot row matching
 * `PUBLIC_USAGE_STATS_SCHEMA_VERSION`, read through the billing barrel and
 * validated against the public schema before it is served.
 *
 * No snapshot row, a stored payload failing the schema, or a DB failure all
 * surface as errors the route maps to a 503 — there is no fallback
 * computation by design.
 */
export function buildPublicStats(
  deps: BuildPublicStatsDeps
): ResultAsync<PublicUsageStats, DomainError> {
  return readLatestPublicStatsSnapshot(
    deps.stores,
    deps.db,
    PUBLIC_USAGE_STATS_SCHEMA_VERSION
  ).andThen((row) => {
    if (row === null) {
      return errAsync(unavailableError('stats: no snapshot row for the current schema version'));
    }
    const parsed = publicUsageStatsSchema.safeParse(row.stats);
    if (!parsed.success) {
      return errAsync(
        validationError('stats: stored snapshot payload failed the public schema', parsed.error)
      );
    }
    return okAsync(parsed.data);
  });
}
